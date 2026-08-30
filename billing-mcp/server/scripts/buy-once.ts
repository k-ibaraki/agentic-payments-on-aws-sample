// ローカル検証用の買い手スクリプト（DESIGN.md 決定18）
// 使い捨てウォレットで billing-mcp の有料ツールを x402 支払い付きで1回呼ぶ。
//
// 使い方:
//   1回目（鍵なし）: pnpm buy:once → 鍵を生成して表示するので .env に保存し、
//                     表示されたアドレスに Circle Faucet でテスト USDC を入金する
//   2回目以降:       サーバーを起動したうえで pnpm buy:once
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createx402MCPClient } from "@x402/mcp";
import { createPublicClient, formatUnits, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ERC20_BALANCE_OF = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const privateKey = process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined;
if (!privateKey) {
  const generated = generatePrivateKey();
  const address = privateKeyToAccount(generated).address;
  console.log("買い手ウォレットが未設定のため、使い捨て鍵を生成しました。");
  console.log("");
  console.log(`  BUYER_PRIVATE_KEY=${generated}`);
  console.log(`  アドレス: ${address}`);
  console.log("");
  console.log("上記を billing-mcp/server/.env に保存し、");
  console.log(
    "https://faucet.circle.com/ で Base Sepolia のテスト USDC をこのアドレスに入金してから再実行してください。",
  );
  process.exit(0);
}

const account = privateKeyToAccount(privateKey);
const serverUrl = process.env.MCP_SERVER_URL ?? "http://localhost:8000/mcp";
const payTo = process.env.PAY_TO_ADDRESS as `0x${string}` | undefined;

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(),
});

async function usdcBalance(address: `0x${string}`): Promise<string> {
  const raw = await publicClient.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: ERC20_BALANCE_OF,
    functionName: "balanceOf",
    args: [address],
  });
  return formatUnits(raw, 6);
}

console.log(`買い手ウォレット: ${account.address}`);
console.log(
  `  残高: ${await usdcBalance(account.address)} USDC (Base Sepolia)`,
);
if (payTo) {
  console.log(`売り手ウォレット: ${payTo}`);
  console.log(`  残高: ${await usdcBalance(payTo)} USDC (Base Sepolia)`);
}

const client = createx402MCPClient({
  name: "billing-mcp-test-buyer",
  version: "0.1.0",
  schemes: [{ network: "eip155:84532", client: new ExactEvmScheme(account) }],
  autoPayment: true,
  onPaymentRequested: async (context) => {
    const price = context.paymentRequired.accepts[0];
    console.log(
      `支払い要求を受信: ${context.toolName} に ${price.amount}（最小単位）を ${price.network} で支払います`,
    );
    return true;
  },
});

const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
await client.connect(transport);
console.log(`MCP サーバーに接続: ${serverUrl}`);

const { tools } = await client.listTools();
console.log(`ツール一覧: ${tools.map((t) => t.name).join(", ")}`);

console.log("generate-html を呼び出します（支払いあり）...");
const result = await client.callTool("generate-html", {
  prompt: "「x402決済成功」と大きく表示するシンプルなHTMLページ",
});

console.log(`支払い実施: ${result.paymentMade}`);
if (result.paymentResponse) {
  console.log(`決済成功: ${result.paymentResponse.success}`);
  console.log(`トランザクション: ${result.paymentResponse.transaction}`);
  console.log(
    `  https://sepolia.basescan.org/tx/${result.paymentResponse.transaction}`,
  );
}
// 注意: @x402/mcp クライアントは有料ツールの結果から structuredContent を
// 落とす（content / isError / _meta のみ写す）ため、ここでは content を表示する。
// HTML 本体が必要な場合は低レベル API で呼ぶ必要がある（DESIGN.md U6 参照）
console.log(`ツール結果: ${result.content[0]?.text ?? "(なし)"}`);

if (payTo) {
  console.log(
    `売り手の決済後残高: ${await usdcBalance(payTo)} USDC (Base Sepolia)`,
  );
}

await client.close();
// 検証スクリプトとして、決済が完了しなかった場合は失敗終了する
if (!result.paymentResponse?.success) {
  console.error("決済が完了しませんでした");
  process.exit(1);
}
process.exit(0);
