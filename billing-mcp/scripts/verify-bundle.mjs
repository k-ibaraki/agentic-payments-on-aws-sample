// 合成した Web Functions のバンドルが「起動して待ち受ける」ことを確かめる。
//
// ESM 出力に CJS 配布の依存（AWS SDK v3 等）を同梱すると、実行時に
// 「Dynamic require of "node:stream" is not supported」で落ちる。また Web Functions は
// 起動後に AWS_LAMBDA_HTTP_ENDPOINT の番地で待ち始めないと使えない。どちらも
// デプロイするまで露見しないため、synth 直後にここで潰す。
// 実行環境と同じく index.js を起動し、MCP のパスに OPTIONS を送って 204 が返るのを見る。
// ネットワーク（facilitator）には触れない（支払いラッパーの構築は初回の POST まで遅延）
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const outDir = path.join(import.meta.dirname, "..", "cdk.out");
if (!fs.existsSync(outDir)) {
  console.error("cdk.out がありません。先に cdk synth を実行してください");
  process.exit(1);
}

const assetDirs = fs
  .readdirSync(outDir)
  .filter((name) => name.startsWith("asset."))
  .map((name) => path.join(outDir, name))
  // CDK の補助関数（zip の配置やバケットの後始末）も index.js を持つので、
  // ui:// の HTML を同梱している方を売り手のバンドルとみなす
  .filter(
    (dir) =>
      fs.existsSync(path.join(dir, "index.js")) &&
      fs.existsSync(path.join(dir, "preview-view.html")),
  );

if (assetDirs.length === 0) {
  console.error(
    "cdk.out に Web Functions のバンドル（index.js と preview-view.html）が見つかりません",
  );
  process.exit(1);
}

/** 空いているポートを 1 つ借りる */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 待ち始めるまで OPTIONS を送り続ける（上限 10 秒。実行環境の起動制限と同じ） */
async function waitForListening(url, child) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`サーバーが終了しました（終了コード ${child.exitCode}）`);
    }
    try {
      return await fetch(url, { method: "OPTIONS" });
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`10 秒以内に待ち受けが始まりませんでした: ${lastError}`);
}

for (const dir of assetDirs) {
  // index.js を ESM として読ませる package.json が同梱されているか
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    console.error(`package.json が同梱されていません: ${dir}`);
    process.exit(1);
  }
  if (JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).type !== "module") {
    console.error(`package.json の type が module ではありません: ${dir}`);
    process.exit(1);
  }

  const port = await freePort();
  const child = spawn(process.execPath, ["index.js"], {
    cwd: dir,
    env: {
      ...process.env,
      AWS_LAMBDA_HTTP_ENDPOINT: `127.0.0.1:${port}`,
      // 起動に要る最低限。受取先は検証用のダミー（ネットワークには出ない）
      PAY_TO_ADDRESS: "0x2222222222222222222222222222222222222222",
      UI_HTML_PATH: path.join(dir, "preview-view.html"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    const preflight = await waitForListening(`http://127.0.0.1:${port}/mcp`, child);
    if (preflight.status !== 204) {
      throw new Error(`OPTIONS /mcp が 204 ではありません: ${preflight.status}`);
    }
    const other = await fetch(`http://127.0.0.1:${port}/other`, { method: "POST" });
    if (other.status !== 404) {
      throw new Error(`POST /other が 404 ではありません: ${other.status}`);
    }
    console.log(`OK: ${path.basename(dir)}（起動・OPTIONS /mcp 204・他パス 404 を確認）`);
  } catch (error) {
    console.error(String(error));
    if (output) console.error(output);
    process.exit(1);
  } finally {
    child.kill();
  }
}
