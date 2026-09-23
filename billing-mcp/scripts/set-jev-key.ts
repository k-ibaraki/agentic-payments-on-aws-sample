// Jev（TypeSafe）の API キーを Secrets Manager に入れる（DESIGN.md 決定58）。
//
// CDK が作るのは仮の値（REPLACE_ME）を入れたシークレットだけで、鍵は人が入れる。CDK に書くと
// CloudFormation テンプレートに平文で残るため。
//
// 実行: pnpm set:jev-key        … parameter.ts の envName からスタックを決める
//       pnpm set:jev-key <名前> … スタック名を直接指定する
//
// 鍵は標準入力から受ける。コマンド引数に置くとシェルの履歴とプロセス一覧に残るため、
// 引数では受け取らない。端末から実行すれば入力は伏せ字になり、パイプでも渡せる:
//   pbpaste | pnpm set:jev-key
//
// AWS CLI を使う（outputs.ts と揃える。この一手のために SDK の依存を増やさない）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { devParameter } from "../parameter";

const stackName = process.argv[2] ?? `BillingMcpStack-${devParameter.envName}`;
const region = devParameter.env?.region;
const regionArgs = region ? ["--region", region] : [];

function aws(args: string[]): string {
  try {
    return execFileSync("aws", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      console.error("aws コマンドが見つかりません。AWS CLI を入れて PATH を通すこと");
      process.exit(1);
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    console.error(
      stderr ? String(stderr).trim() : error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  }
}

/** スタックの出力から Secret の ARN を引く。作り直すと変わるので記録の値は使わない */
function secretArn(): string {
  const json = aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    stackName,
    ...regionArgs,
    "--output",
    "json",
  ]);
  const outputs: { OutputKey?: string; OutputValue?: string }[] =
    JSON.parse(json).Stacks?.[0]?.Outputs ?? [];
  const arn = outputs.find((o) => o.OutputKey === "TypesafeApiKeySecretArn")?.OutputValue;
  if (!arn) {
    console.error(`${stackName} に TypesafeApiKeySecretArn がありません。deploy 済みか確認すること`);
    process.exit(1);
  }
  return arn;
}

/** 鍵を読む。端末なら伏せ字で、パイプならそのまま */
async function readKey(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf-8").trim();
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  // 入力中の文字を画面に出さない。readline の出力口を差し替えるのが定石
  (rl as unknown as { _writeToOutput(text: string): void })._writeToOutput = (
    text,
  ) => {
    // 問いかけの行はそのまま出し、打った鍵は捨てる
    if (text.includes("API キー")) process.stdout.write(text);
  };
  const answer = await new Promise<string>((resolve) => {
    rl.question("TypeSafe の API キー（画面には出ません）: ", resolve);
  });
  rl.close();
  process.stdout.write("\n");
  return answer.trim();
}

// billing-mcp の package.json は ESM 指定が無く、tsx は CJS で出力する。
// トップレベル await が使えないため、関数に包んで呼ぶ
async function main(): Promise<void> {
  const key = await readKey();
  if (!key) {
    console.error("鍵が空です。何もしていません");
    process.exit(1);
  }
  if (key === "REPLACE_ME") {
    console.error("仮の値そのものは入れられません。実際の鍵を渡すこと");
    process.exit(1);
  }

  const arn = secretArn();
  // 鍵はコマンド引数に置かない。`execFileSync` の引数配列はシェルを介さないが、
  // プロセス一覧（ps）には見えるため。標準入力（`file:///dev/stdin`）も試したが、
  // Node が作るパイプでは開けない（macOS で Permission denied）。そこで本人しか
  // 読めない一時ファイル（0600）に置いて渡し、成否によらず必ず消す
  const dir = mkdtempSync(path.join(tmpdir(), "set-jev-key-"));
  const inputPath = path.join(dir, "input.json");
  try {
    writeFileSync(inputPath, JSON.stringify({ SecretId: arn, SecretString: key }), {
      mode: 0o600,
    });
    execFileSync(
      "aws",
      [
        "secretsmanager",
        "put-secret-value",
        "--cli-input-json",
        `file://${inputPath}`,
        ...regionArgs,
        "--output",
        "json",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`入れました（${key.length} 文字）。判定モデルを切り替えるには価格表の judge を jev にして配ること`);
  console.log("");
  console.log('  pnpm set:tier-table < tier-table.json   # 中身は { "tiers": { ... }, "judge": "jev" }');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
