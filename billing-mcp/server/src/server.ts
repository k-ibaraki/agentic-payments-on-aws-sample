// HTTP サーバーの組み立て（DESIGN.md 決定22・74）。
// Lambda Web Functions でもローカルでも、同じ Hono アプリをポートで待たせる。
// MCP の処理そのものは app.ts の fetch ハンドラに集約し、ここは経路を繋ぐだけ
import { Hono } from "hono";
import { MCP_PATH } from "./app.js";

type FetchHandler = (request: Request) => Promise<Response>;

/** 待ち受けるホストとポート */
export interface ListenAddress {
  hostname: string;
  port: number;
}

/**
 * 待ち受け先を決める。
 *
 * Web Functions は AWS_LAMBDA_HTTP_ENDPOINT（`host:port`）で指定してくる。実行環境は
 * その番地を叩いて起動を確かめるので、ずらすと起動に失敗する。ローカルでは PORT（既定 8000）
 */
export function parseListenAddress(
  env: NodeJS.ProcessEnv = process.env,
): ListenAddress {
  const endpoint = env.AWS_LAMBDA_HTTP_ENDPOINT;
  if (endpoint) {
    const [hostname, port] = endpoint.split(":");
    return { hostname, port: Number.parseInt(port, 10) };
  }
  return {
    hostname: "0.0.0.0",
    port: Number.parseInt(env.PORT ?? "8000", 10),
  };
}

/**
 * Hono アプリを作る。MCP のパス宛て（OPTIONS を含む全メソッド）は fetch ハンドラへそのまま渡し、
 * 他のパスは 404。応答は本文のストリームごと返す（SSE の経過の通知を途中で届けるため。決定65）
 */
export function createApp(handleMcp: FetchHandler): Hono {
  const app = new Hono();
  app.all(MCP_PATH, (c) => handleMcp(c.req.raw));
  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  return app;
}
