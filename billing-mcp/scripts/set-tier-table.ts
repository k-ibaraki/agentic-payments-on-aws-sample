// 価格表（価格帯ごとの価格と目安、判定モデル）を AppConfig に配る。CDK は器だけを作り、
// 中身はこのスクリプトで配る（DESIGN.md 決定64）。
//
// 実行: pnpm set:tier-table < tier-table.json        … parameter.ts の envName からスタックを決める
//       pnpm set:tier-table <名前> < tier-table.json … スタック名を直接指定する
//       pbpaste | pnpm set:tier-table                … クリップボードから渡す場合
//
// 表は丸ごと差し替える。中身の検証はサーバーに任せ（決定56）、ここでは JSON であることと
// `tiers` を含むことだけを見る。`{"judge":"jev"}` だけを配ると表ごと退けられ、
// 切り替えたつもりで何も変わらないため。
//
// AWS CLI を使う（outputs.ts / set-jev-key.ts と揃える）。
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { devParameter } from "../parameter";

const stackName = process.argv[2] ?? `BillingMcpStack-${devParameter.envName}`;
const region = devParameter.env?.region;
const regionArgs = region ? ["--region", region] : [];

function aws(args: string[]): string {
  try {
    return execFileSync("aws", [...args, ...regionArgs, "--output", "json"], {
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

interface Target {
  applicationId: string;
  environmentId: string;
  profileId: string;
  strategyId: string;
}

/** スタックの出力から配り先を引く。作り直すと変わるので記録の値は使わない */
function target(): Target {
  const outputs: { OutputKey?: string; OutputValue?: string }[] =
    JSON.parse(aws(["cloudformation", "describe-stacks", "--stack-name", stackName])).Stacks?.[0]
      ?.Outputs ?? [];
  const get = (key: string): string => {
    const value = outputs.find((o) => o.OutputKey === key)?.OutputValue;
    if (!value) {
      console.error(
        `${stackName} に ${key} がありません。決定64 以降のコードで deploy 済みか確認すること`,
      );
      process.exit(1);
    }
    return value;
  };
  return {
    applicationId: get("PricingApplicationId"),
    environmentId: get("PricingEnvironmentId"),
    profileId: get("PricingProfileId"),
    strategyId: get("PricingDeploymentStrategyId"),
  };
}

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

/** 送る前に JSON であることと `tiers` を含むことだけを見て、詰めた形にする */
function normalize(text: string): string {
  let table: unknown;
  try {
    table = JSON.parse(text);
  } catch (error) {
    console.error(`JSON として読めません: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const tiers = (table as { tiers?: unknown } | null)?.tiers;
  if (typeof tiers !== "object" || tiers === null) {
    console.error(
      "tiers がありません。価格表は丸ごと差し替えるので、judge だけを変えるときも tiers を含めること",
    );
    process.exit(1);
  }
  return JSON.stringify(table);
}

// billing-mcp の package.json は ESM 指定が無く、tsx は CJS で出力する。
// トップレベル await が使えないため、関数に包んで呼ぶ
async function main(): Promise<void> {
  if (process.stdin.isTTY) {
    console.error("価格表の JSON を標準入力で渡すこと（例: pnpm set:tier-table < tier-table.json）");
    process.exit(1);
  }
  const content = normalize(await readInput());
  const to = target();

  const dir = mkdtempSync(path.join(tmpdir(), "set-tier-table-"));
  try {
    const contentPath = path.join(dir, "content.json");
    writeFileSync(contentPath, content);
    // 最後の位置引数は、作った版の中身を書き戻す先（CLI の必須引数）。使わないので一時置き場に捨てる
    const version = JSON.parse(
      aws([
        "appconfig",
        "create-hosted-configuration-version",
        "--application-id",
        to.applicationId,
        "--configuration-profile-id",
        to.profileId,
        "--content-type",
        "application/json",
        "--content",
        `fileb://${contentPath}`,
        path.join(dir, "echo.json"),
      ]),
    ).VersionNumber as number;

    const deployment = JSON.parse(
      aws([
        "appconfig",
        "start-deployment",
        "--application-id",
        to.applicationId,
        "--environment-id",
        to.environmentId,
        "--configuration-profile-id",
        to.profileId,
        "--deployment-strategy-id",
        to.strategyId,
        "--configuration-version",
        String(version),
      ]),
    ) as { DeploymentNumber?: number; State?: string };

    console.log(
      `版 ${version} を配りました（配信 #${deployment.DeploymentNumber}、状態 ${deployment.State}）`,
    );
    console.log(content);
    console.log("");
    console.log("反映は即時ではない。間隔をあけた呼び出しが 2 回ほど要る（拡張は更新を取った回には旧値を返す）。");
    console.log("反映後、CloudWatch Logs に「判定モデルの指定を読み取れませんでした」が出ていないか確かめること");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
