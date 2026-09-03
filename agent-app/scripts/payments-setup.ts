// AgentCore Payments のセットアップ（決定27）。冪等に作ってあり、何度実行してもよい。
//
// 作るもの（ap-southeast-1。決定12: Payments のみ越境）:
//   1. サービスロール（IAM。bedrock-agentcore が引き受けて資格情報を取りに行く）
//   2. PaymentManager（決済操作の親リソース）
//   3. PaymentConnector（Coinbase / QUICK_CREATE。OAuth 同意 URL が出たら人間が開く）
//   4. PaymentInstrument（EVM の埋め込みウォレット。委任と入金は redirectUrl で人間が行う）
//
// 実行: npx tsx scripts/payments-setup.ts
// 環境変数: PAYMENTS_USER_ID（既定 sample-user-1）、PAYMENTS_LINK_EMAIL（ウォレットに紐づけるメール。必須）

import {
  BedrockAgentCoreControlClient,
  CreatePaymentConnectorCommand,
  CreatePaymentCredentialProviderCommand,
  CreatePaymentManagerCommand,
  GetPaymentConnectorCommand,
  GetPaymentManagerCommand,
  ListPaymentConnectorsCommand,
  ListPaymentCredentialProvidersCommand,
  ListPaymentManagersCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  BedrockAgentCoreClient,
  CreatePaymentInstrumentCommand,
  CreatePaymentSessionCommand,
  GetPaymentInstrumentCommand,
  ListPaymentInstrumentsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  CreateRoleCommand,
  GetRoleCommand,
  IAMClient,
  PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { randomUUID } from 'node:crypto';

// .env（gitignore 済み）から CDP 資格情報等を読む。無ければ黙って続行
try {
  process.loadEnvFile(new URL('../.env', import.meta.url).pathname);
} catch {
  // .env が無い場合は環境変数だけで動く
}

const REGION = 'ap-southeast-1';
const ROLE_NAME = 'agentic-payments-sample-service-role';
// PaymentManager / Connector の name は英数字のみ（[a-zA-Z][a-zA-Z0-9]{0,47}）
const MANAGER_NAME = 'agenticPaymentsSample';
const CONNECTOR_NAME = 'coinbaseQuick';
const USER_ID = process.env.PAYMENTS_USER_ID ?? 'sample-user-1';

const control = new BedrockAgentCoreControlClient({ region: REGION });
const data = new BedrockAgentCoreClient({ region: REGION });
const iam = new IAMClient({ region: 'us-east-1' });
const sts = new STSClient({ region: REGION });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ensureServiceRole(account: string): Promise<string> {
  // 信頼ポリシーと基本許可は公式ドキュメント（payments-iam-roles）の「既存ロールを使う場合」の要件どおり
  const trustPolicy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {
          // 公式ドキュメントはグローバルの bedrock-agentcore.amazonaws.com のみ記載だが、
          // それだけだと CreatePaymentManager が Role validation failed になった（2026-08-31 実測）。
          // リージョン付きプリンシパルを併記すると通る
          Service: ['bedrock-agentcore.amazonaws.com', `bedrock-agentcore.${REGION}.amazonaws.com`],
        },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: {
            // PaymentManager の ARN は name が小文字化され `<name小文字>-<suffix>` になる（実測）
            'aws:SourceArn': `arn:aws:bedrock-agentcore:${REGION}:${account}:payment-manager/${MANAGER_NAME.toLowerCase()}-*`,
          },
        },
      },
    ],
  };
  // workload identity の ARN も PaymentManager 同様 name が小文字化される（実測）。
  // 初回はここが camelCase のままで GetWorkloadAccessToken が拒否され、
  // CreatePaymentInstrument が「Failed to obtain workload access token」で落ちた（2026-09-02）
  const workloadPattern = `${MANAGER_NAME.toLowerCase()}-*`;
  const basePermissions = {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'WorkloadIdentityManagement',
        Effect: 'Allow',
        Action: ['bedrock-agentcore:CreateWorkloadIdentity', 'bedrock-agentcore:DeleteWorkloadIdentity'],
        Resource: [
          `arn:aws:bedrock-agentcore:${REGION}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${REGION}:${account}:workload-identity-directory/default/workload-identity/*`,
        ],
      },
      {
        Sid: 'WorkloadIdentityAccess',
        Effect: 'Allow',
        Action: ['bedrock-agentcore:GetWorkloadAccessToken'],
        Resource: [
          `arn:aws:bedrock-agentcore:${REGION}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${REGION}:${account}:workload-identity-directory/default/workload-identity/${workloadPattern}`,
        ],
      },
      {
        Sid: 'PaymentTokenBaseAccess',
        Effect: 'Allow',
        Action: ['bedrock-agentcore:GetResourcePaymentToken'],
        Resource: [
          `arn:aws:bedrock-agentcore:${REGION}:${account}:token-vault/default`,
          `arn:aws:bedrock-agentcore:${REGION}:${account}:workload-identity-directory/default`,
          `arn:aws:bedrock-agentcore:${REGION}:${account}:workload-identity-directory/default/workload-identity/${workloadPattern}`,
        ],
      },
      {
        // QUICK_CREATE ではサービス側が資格情報プロバイダを作るため、その権限も要る
        Sid: 'PaymentCredentialProviderProvisioning',
        Effect: 'Allow',
        Action: [
          'bedrock-agentcore:CreatePaymentCredentialProvider',
          'bedrock-agentcore:GetPaymentCredentialProvider',
          'bedrock-agentcore:GetResourcePaymentToken',
          'bedrock-agentcore:TagResource',
        ],
        Resource: [
          `arn:aws:bedrock-agentcore:${REGION}:${account}:token-vault/*`,
          `arn:aws:bedrock-agentcore:${REGION}:${account}:token-vault/*/paymentcredentialprovider/*`,
        ],
      },
      {
        // コネクタ追加後に必要になる Secrets Manager 読み出し（QUICK_CREATE が保存した秘密）
        Sid: 'SecretsManagerAccess',
        Effect: 'Allow',
        Action: ['secretsmanager:GetSecretValue'],
        Resource: ['*'],
        Condition: { StringEquals: { 'aws:ResourceAccount': account } },
      },
    ],
  };
  try {
    const existing = await iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    // 冪等実行時も信頼ポリシー・許可ポリシーを最新の定義に同期させる
    await iam.send(
      new UpdateAssumeRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyDocument: JSON.stringify(trustPolicy),
      }),
    );
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: 'agentcore-payments-base',
        PolicyDocument: JSON.stringify(basePermissions),
      }),
    );
    console.log(`サービスロールは既存: ${existing.Role?.Arn}（ポリシー同期済み）`);
    return existing.Role!.Arn!;
  } catch {
    // 無ければ作る
  }
  const created = await iam.send(
    new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
      // IAM の Description は Latin-1 のみ許容のため英語（日本語だと ValidationError）
      Description: 'Service role assumed by AgentCore Payments (agentic-payments-on-aws-sample)',
    }),
  );
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: 'agentcore-payments-base',
      PolicyDocument: JSON.stringify(basePermissions),
    }),
  );
  console.log(`サービスロールを作成: ${created.Role?.Arn}`);
  // IAM は伝播に少し掛かる
  await sleep(10_000);
  return created.Role!.Arn!;
}

async function ensurePaymentManager(roleArn: string): Promise<{ id: string; arn: string }> {
  const list = await control.send(new ListPaymentManagersCommand({}));
  const found = list.paymentManagers?.find((m) => m.name === MANAGER_NAME);
  let id: string;
  if (found?.paymentManagerId) {
    id = found.paymentManagerId;
    console.log(`PaymentManager は既存: ${id}`);
  } else {
    const created = await control.send(
      new CreatePaymentManagerCommand({
        name: MANAGER_NAME,
        description: 'agentic-payments-on-aws-sample の買い手ウォレット管理',
        authorizerType: 'AWS_IAM',
        roleArn,
      }),
    );
    id = created.paymentManagerId!;
    console.log(`PaymentManager を作成: ${id}`);
  }
  // READY まで待つ（公式の目安は最大2分）
  for (let i = 0; i < 36; i++) {
    const got = await control.send(new GetPaymentManagerCommand({ paymentManagerId: id }));
    if (got.status === 'READY') return { id, arn: got.paymentManagerArn! };
    if (got.status?.endsWith('FAILED')) {
      throw new Error(`PaymentManager が ${got.status} になった。サービスロールを確認すること`);
    }
    await sleep(5_000);
  }
  throw new Error('PaymentManager が READY にならない');
}

// CDP の資格情報（MANUAL 経路）を AgentCore Identity に保存する。
// QUICK_CREATE はコンソールの白画面問題で三度失敗したため MANUAL へ切替（2026-09-02、決定27 変更）
async function ensureCredentialProvider(): Promise<string> {
  const PROVIDER_NAME = 'coinbaseManual';
  const list = await control.send(new ListPaymentCredentialProvidersCommand({}));
  const found = list.credentialProviders?.find((p) => p.name === PROVIDER_NAME);
  if (found?.credentialProviderArn) {
    console.log(`PaymentCredentialProvider は既存: ${found.credentialProviderArn}`);
    return found.credentialProviderArn;
  }
  const apiKeyId = process.env.CDP_API_KEY_ID;
  const apiKeySecret = process.env.CDP_API_KEY_SECRET;
  const walletSecret = process.env.CDP_WALLET_SECRET;
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      'CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET が未設定です。' +
        'CDP ポータルで発行し .env に保存してください（.env.example 参照）',
    );
  }
  const created = await control.send(
    new CreatePaymentCredentialProviderCommand({
      name: PROVIDER_NAME,
      credentialProviderVendor: 'CoinbaseCDP',
      providerConfigurationInput: {
        coinbaseCdpConfiguration: { apiKeyId, apiKeySecret, walletSecret },
      },
    }),
  );
  console.log(`PaymentCredentialProvider を作成: ${created.credentialProviderArn}`);
  return created.credentialProviderArn!;
}

async function ensureConnector(managerId: string): Promise<{ id: string; ready: boolean }> {
  const list = await control.send(new ListPaymentConnectorsCommand({ paymentManagerId: managerId }));
  const found = list.paymentConnectors?.find(
    (c) => c.name === CONNECTOR_NAME && c.status !== 'DELETING',
  );
  let id: string;
  if (found?.paymentConnectorId) {
    id = found.paymentConnectorId;
    console.log(`PaymentConnector は既存: ${id}`);
  } else {
    const credentialProviderArn = await ensureCredentialProvider();
    const created = await control.send(
      new CreatePaymentConnectorCommand({
        paymentManagerId: managerId,
        name: CONNECTOR_NAME,
        type: 'CoinbaseCDP',
        credentialProviderConfigurations: [{ coinbaseCDP: { credentialProviderArn } }],
      }),
    );
    id = created.paymentConnectorId!;
    console.log(`PaymentConnector を作成: ${id}（status: ${created.status}）`);
  }
  // READY まで待つ
  for (let i = 0; i < 24; i++) {
    const got = await control.send(
      new GetPaymentConnectorCommand({ paymentManagerId: managerId, paymentConnectorId: id }),
    );
    if (got.status === 'READY') return { id, ready: true };
    if (got.status?.endsWith('FAILED') || got.status === 'AWS_MARKETPLACE_SUBSCRIPTION_REQUIRED') {
      throw new Error(`PaymentConnector が ${got.status} になりました`);
    }
    await sleep(5_000);
  }
  console.log('PaymentConnector がまだ READY になりません。しばらくして再実行してください');
  return { id, ready: false };
}

async function ensureInstrument(managerArn: string, connectorId: string): Promise<string> {
  const list = await data.send(
    new ListPaymentInstrumentsCommand({ paymentManagerArn: managerArn, userId: USER_ID }),
  );
  const found = list.paymentInstruments?.find((i) => i.status !== 'INACTIVE');
  let instrumentId: string;
  if (found?.paymentInstrumentId) {
    instrumentId = found.paymentInstrumentId;
    console.log(`PaymentInstrument は既存: ${instrumentId}`);
  } else {
    const email = process.env.PAYMENTS_LINK_EMAIL;
    if (!email) throw new Error('PAYMENTS_LINK_EMAIL（ウォレットに紐づけるメール）を設定すること');
    const created = await data.send(
      new CreatePaymentInstrumentCommand({
        userId: USER_ID,
        paymentManagerArn: managerArn,
        paymentConnectorId: connectorId,
        paymentInstrumentType: 'EMBEDDED_CRYPTO_WALLET',
        paymentInstrumentDetails: {
          // Base Sepolia は EVM 系なのでファミリーは ETHEREUM（チェーンは x402 ペイロード側で指定する）
          embeddedCryptoWallet: {
            network: 'ETHEREUM',
            linkedAccounts: [{ email: { emailAddress: email } }],
          },
        },
        clientToken: randomUUID(),
      }),
    );
    // 応答は { paymentInstrument: {...} } に包まれている
    instrumentId = created.paymentInstrument!.paymentInstrumentId!;
    console.log(`PaymentInstrument を作成: ${instrumentId}`);
  }
  const got = (
    await data.send(
      new GetPaymentInstrumentCommand({
        userId: USER_ID,
        paymentManagerArn: managerArn,
        paymentInstrumentId: instrumentId,
      }),
    )
  ).paymentInstrument!;
  const wallet =
    got.paymentInstrumentDetails && 'embeddedCryptoWallet' in got.paymentInstrumentDetails
      ? got.paymentInstrumentDetails.embeddedCryptoWallet
      : undefined;
  console.log('');
  console.log(`PaymentInstrument ID: ${instrumentId}`);
  console.log(`ウォレットアドレス: ${wallet?.walletAddress ?? '(未発行)'}`);
  console.log(`ステータス: ${got.status}`);
  if (got.status !== 'ACTIVE' && wallet?.redirectUrl) {
    console.log('');
    console.log('★ ウォレットの委任（署名権限の付与）が必要です。次の URL をブラウザで開いて許可してください:');
    console.log(`  ${wallet.redirectUrl}`);
    console.log('（入金は scripts/faucet.ts＝CDP faucet で行える）');
  }
  return instrumentId;
}

// 検証用の PaymentSession を切る（時限・支出上限つき。期限切れのたびに再実行して作り直す）
async function createSession(managerArn: string): Promise<void> {
  const created = await data.send(
    new CreatePaymentSessionCommand({
      userId: USER_ID,
      paymentManagerArn: managerArn,
      expiryTimeInMinutes: 60,
      // 上限 1 USD ≒ 10 回分（1回 0.1 テスト USDC。決定18）
      limits: { maxSpendAmount: { value: '1.00', currency: 'USD' } },
      clientToken: randomUUID(),
    }),
  );
  const session = created.paymentSession!;
  console.log('');
  console.log(`PaymentSession を作成: ${session.paymentSessionId}（60分・上限 1.00 USD）`);
  console.log('');
  console.log('縦串検証はこの環境変数で:');
  console.log(`export PAYMENT_MANAGER_ARN=${managerArn}`);
  console.log(`export PAYMENT_SESSION_ID=${session.paymentSessionId}`);
}

async function main() {
  const who = await sts.send(new GetCallerIdentityCommand({}));
  const account = who.Account!;
  console.log(`アカウント ${account} / リージョン ${REGION} でセットアップを開始`);

  const roleArn = await ensureServiceRole(account);
  const manager = await ensurePaymentManager(roleArn);
  console.log(`PaymentManager ARN: ${manager.arn}`);
  const connector = await ensureConnector(manager.id);
  if (!connector.ready) return;
  const instrumentId = await ensureInstrument(manager.arn, connector.id);
  await createSession(manager.arn);
  console.log(`export PAYMENT_INSTRUMENT_ID=${instrumentId}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
