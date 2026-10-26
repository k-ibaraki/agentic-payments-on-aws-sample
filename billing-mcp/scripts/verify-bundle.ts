// 束ねた Web Functions のバンドルが「起動して待ち受ける」ことを確かめる。
//
// ESM 出力に CJS 配布の依存（AWS SDK v3 等）を同梱すると、実行時に
// 「Dynamic require of "node:stream" is not supported」で落ちる。また Web Functions は
// 起動後に AWS_LAMBDA_HTTP_ENDPOINT の番地で待ち始めないと使えない。どちらも
// デプロイするまで露見しないため、ここで潰す。
// CDK と同じ束ね（stacks/bundle.ts）をここから呼び、その出力を実行環境と同じく index.js で起動して、
// MCP のパスに OPTIONS を送って 204 が、他のパスに 404 が返るのを見る。
// ネットワーク（facilitator）には触れない（支払いラッパーの構築は初回の POST まで遅延）
import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { bundleServer } from "../stacks/bundle";

/** 空いているポートを 1 つ借りる */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("ポートを取れませんでした"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

/** 待ち始めるまで OPTIONS を送り続ける（上限 10 秒。実行環境の起動制限と同じ） */
async function waitForListening(url: string, child: ChildProcess): Promise<Response> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
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

async function main(): Promise<void> {
  const dir = bundleServer(path.join(__dirname, ".."));
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
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      output += chunk;
    });
  }

  try {
    const preflight = await waitForListening(`http://127.0.0.1:${port}/mcp`, child);
    if (preflight.status !== 204) {
      throw new Error(`OPTIONS /mcp が 204 ではありません: ${preflight.status}`);
    }
    const other = await fetch(`http://127.0.0.1:${port}/other`, { method: "POST" });
    if (other.status !== 404) {
      throw new Error(`POST /other が 404 ではありません: ${other.status}`);
    }
    console.log(`OK: ${dir}（起動・OPTIONS /mcp 204・他パス 404 を確認）`);
  } catch (error) {
    console.error(String(error));
    if (output) console.error(output);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
}

void main();
