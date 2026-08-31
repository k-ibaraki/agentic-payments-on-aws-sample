// Lambda Function URL のエントリポイント（DESIGN.md 決定19・22）。
// 認証は掛けない。認可は x402 の支払いが単独で担う
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
  // enableJsonResponse で応答は JSON に収まるため、常にバッファして返す
  const body = await response.text();
  return {
    statusCode: response.status,
    headers,
    body,
    isBase64Encoded: false,
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

export const handler = createLambdaHandler(lazyFetchHandler);
