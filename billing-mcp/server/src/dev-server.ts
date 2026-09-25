// ローカル開発用の薄いエントリポイント（DESIGN.md 決定22）。
// 本番（Lambda Function URL）と同じ fetch ハンドラを node:http に載せるだけで、
// MCP の処理そのものは app.ts に集約する
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createMcpFetchHandler, MCP_PATH, optionsFromEnv } from "./app.js";

const PORT = Number.parseInt(process.env.PORT ?? "8000", 10);

const options = optionsFromEnv();
const handleMcpRequest = createMcpFetchHandler(options);

async function toRequest(req: IncomingMessage): Promise<Request> {
  const url = `http://${req.headers.host ?? `localhost:${PORT}`}${req.url ?? "/"}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value))
      for (const v of value) headers.append(key, v);
  }

  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new Request(url, {
    method,
    headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const response = await handleMcpRequest(await toRequest(req));
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      res.writeHead(response.status, headers);
      // SSE（経過の通知。決定65）を届いた順に流すため、本文は読み切らずに流す
      if (!response.body) {
        res.end();
        return;
      }
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
        res,
      );
    } catch (error) {
      console.error("リクエスト処理に失敗しました", error);
      // 流している途中で落ちたときは、ステータスとヘッダを送り終えているので、接続を打ち切るだけにする
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Internal Server Error" }));
    }
  })();
});

server.listen(PORT, () =>
  console.log(
    `billing-mcp サーバー起動: http://localhost:${PORT}${MCP_PATH}（価格は段階制 / facilitator ${options.facilitatorUrl}）`,
  ),
);
