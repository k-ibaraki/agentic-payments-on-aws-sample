// HTTP サーバーの組み立て（DESIGN.md 決定22・74）。
// Lambda Web Functions でもローカルでも、同じ Hono アプリをポートで待たせる。
// MCP の処理そのものは app.ts の fetch ハンドラに集約し、ここは経路を繋ぐだけ
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type FetchHandler, MCP_PATH } from "./app.js";

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
 * 依頼の本文の上限（バイト）。無認証の公開エンドポイントで、本文は支払いの検証より前に
 * 読み切るので、上限が無いと巨大な本文で実行環境のメモリ（2 GB を最大 64 件で分け合う）を
 * 使い切らされる。Function URL には 6MB の上限があったが Web Functions には無い（決定74）。
 * 添付 1 件の上限（文書 4.5MB を base64 にして約 6MB）に、前回の HTML などの分を足した値
 */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

/**
 * Hono アプリを作る。MCP のパス宛て（OPTIONS を含む全メソッド）は本文の大きさを確かめてから
 * fetch ハンドラへそのまま渡し、他のパスは 404。応答は本文のストリームごと返す
 * （SSE の経過の通知を途中で届けるため。決定65）
 */
export function createApp(handleMcp: FetchHandler): Hono {
  const app = new Hono();
  app.all(
    MCP_PATH,
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => c.json({ error: "Payload Too Large" }, 413),
    }),
    (c) => handleMcp(c.req.raw),
  );
  app.notFound((c) => c.json({ error: "Not Found" }, 404));
  return app;
}
