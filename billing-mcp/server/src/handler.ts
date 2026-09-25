// Lambda Function URL のエントリポイント（DESIGN.md 決定19・22・65）。
// 認証は掛けない。認可は x402 の支払いが単独で担う。
// 経過の通知（決定65）を途中で届けるため、Function URL はレスポンスストリーミング（RESPONSE_STREAM）で返す
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type {
  LambdaFunctionURLEvent,
  LambdaFunctionURLResult,
} from "aws-lambda";
import { createMcpFetchHandler, optionsFromEnv } from "./app.js";

type FetchHandler = (request: Request) => Promise<Response>;

function toRequest(event: LambdaFunctionURLEvent): Request {
  const host = event.headers?.host ?? event.requestContext.domainName;
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://${host}${event.rawPath}${query}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }

  const method = event.requestContext.http.method;
  const hasBody =
    event.body !== undefined && method !== "GET" && method !== "HEAD";
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, "base64")
      : (event.body as string)
    : undefined;

  return new Request(url, { method, headers, body });
}

async function toResult(
  response: Response,
): Promise<LambdaFunctionURLResult<never>> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // バッファ版は SSE を最後まで溜めてから一度に返す（途中の経過は逐次には届かない）。
  // ストリーミングの無い実行環境向けの退路
  const body = await response.text();
  return {
    statusCode: response.status,
    headers,
    body,
    isBase64Encoded: false,
  };
}

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

/** awslambda.HttpResponseStream.from と同じ形（テストで差し替えるため） */
export type ResponseStreamFactory = (
  writable: Writable,
  metadata: Record<string, unknown>,
) => Writable;

/**
 * fetch ハンドラを、レスポンスストリーミングの Function URL ハンドラに変換する。
 * ステータスとヘッダを先に渡し、本文は届いた順に流す。SSE の途中の通知が
 * 生成の終わりを待たずに買い手へ届く
 */
export function createStreamingLambdaHandler(
  fetchHandler: FetchHandler,
  from: ResponseStreamFactory,
) {
  return async (
    event: LambdaFunctionURLEvent,
    responseStream: Writable,
  ): Promise<void> => {
    const response = await fetchHandler(toRequest(event));
    const stream = from(responseStream, {
      statusCode: response.status,
      headers: headersOf(response),
    });
    if (!response.body) {
      // 実行環境はステータスとヘッダを最初の write のときに送る。write 無しに end すると
      // それらが送られず、OPTIONS の 204 と CORS ヘッダが消える（2026-09-25 にクラウドで実測）。
      // 空の書き込みを 1 度行って、ステータスとヘッダを確実に送らせる
      stream.write("");
      stream.end();
      return;
    }
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      stream,
    );
  };
}

/** fetch ハンドラを Function URL のハンドラに変換する（テストのために分離） */
export function createLambdaHandler(fetchHandler: FetchHandler) {
  return async (
    event: LambdaFunctionURLEvent,
  ): Promise<LambdaFunctionURLResult<never>> =>
    toResult(await fetchHandler(toRequest(event)));
}

// 環境変数の読み取りと facilitator 照会をモジュール読み込み時に走らせないよう、
// 初回リクエストまで遅延させる（Lambda の INIT フェーズは 10 秒制限）
let fetchHandler: FetchHandler | undefined;
const lazyFetchHandler: FetchHandler = (request) => {
  fetchHandler ??= createMcpFetchHandler(optionsFromEnv());
  return fetchHandler(request);
};

// awslambda.streamifyResponse はストリーミング対応の Lambda 実行環境だけが持つ。手元でバンドルを
// 読み込む検証（verify-bundle.mjs）やテストでは無いので、そのときはバッファ版を書き出す
const streaming = typeof globalThis.awslambda?.streamifyResponse === "function";

export const handler = !streaming
  ? createLambdaHandler(lazyFetchHandler)
  : awslambda.streamifyResponse(
      createStreamingLambdaHandler(lazyFetchHandler, (writable, metadata) =>
        awslambda.HttpResponseStream.from(writable, metadata),
      ),
    );
