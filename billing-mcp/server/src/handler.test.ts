import { PassThrough, type Writable } from "node:stream";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import {
  createLambdaHandler,
  createStreamingLambdaHandler,
} from "./handler.js";

// Function URL のイベント → Request → Response → Function URL の応答、
// という変換だけを検証する。MCP 本体の挙動は app.test.ts が見る
function event(overrides: Partial<LambdaFunctionURLEvent> = {}) {
  return {
    version: "2.0",
    rawPath: "/mcp",
    rawQueryString: "",
    headers: { "content-type": "application/json" },
    requestContext: {
      http: { method: "POST", path: "/mcp" },
      domainName: "abc123.lambda-url.ap-northeast-1.on.aws",
    },
    body: '{"ping":true}',
    isBase64Encoded: false,
    ...overrides,
  } as LambdaFunctionURLEvent;
}

describe("Lambda Function URL アダプタ", () => {
  it("メソッド・パス・ヘッダ・ボディを Request に写す", async () => {
    let seen: Request | undefined;
    const handler = createLambdaHandler(async (request) => {
      seen = request;
      return new Response("ok", { status: 200 });
    });

    const result = await handler(
      event({ rawQueryString: "a=1", headers: { "x-test": "yes" } }),
    );

    expect(seen?.method).toBe("POST");
    expect(new URL(seen?.url ?? "").pathname).toBe("/mcp");
    expect(new URL(seen?.url ?? "").search).toBe("?a=1");
    expect(seen?.headers.get("x-test")).toBe("yes");
    expect(await seen?.text()).toBe('{"ping":true}');
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe("ok");
  });

  it("base64 エンコードされたボディを復元する", async () => {
    let seen: Request | undefined;
    const handler = createLambdaHandler(async (request) => {
      seen = request;
      return new Response(null, { status: 204 });
    });

    await handler(
      event({
        body: Buffer.from('{"日本語":"あり"}', "utf-8").toString("base64"),
        isBase64Encoded: true,
      }),
    );

    expect(await seen?.text()).toBe('{"日本語":"あり"}');
  });

  it("応答のヘッダとステータスをそのまま返す", async () => {
    const handler = createLambdaHandler(
      async () =>
        new Response('{"ok":true}', {
          status: 402,
          headers: {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          },
        }),
    );

    const result = await handler(event());

    expect(result.statusCode).toBe(402);
    expect(result.headers?.["content-type"]).toBe("application/json");
    expect(result.headers?.["access-control-allow-origin"]).toBe("*");
    expect(result.isBase64Encoded).toBe(false);
  });

  it("ボディの無いリクエスト（GET）でも変換できる", async () => {
    let seen: Request | undefined;
    const handler = createLambdaHandler(async (request) => {
      seen = request;
      return new Response(null, { status: 405 });
    });

    const result = await handler(
      event({
        body: undefined,
        requestContext: {
          http: { method: "GET", path: "/mcp" },
          domainName: "abc123.lambda-url.ap-northeast-1.on.aws",
        } as LambdaFunctionURLEvent["requestContext"],
      }),
    );

    expect(seen?.method).toBe("GET");
    expect(result.statusCode).toBe(405);
  });
});

// 決定65: 経過の通知を途中で届けるため、Function URL はレスポンスストリーミングで返す
describe("Lambda Function URL アダプタ（レスポンスストリーミング）", () => {
  /** awslambda.HttpResponseStream.from の代わり。渡されたステータスとヘッダ（metadata）を控える */
  function fakeStream() {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    let writes = 0;
    const write = sink.write.bind(sink);
    sink.write = ((...args: Parameters<typeof write>) => {
      writes += 1;
      return write(...args);
    }) as typeof sink.write;
    sink.on("data", (chunk: Buffer) => chunks.push(chunk));
    let metadata: Record<string, unknown> | undefined;
    const from = (writable: Writable, meta: Record<string, unknown>) => {
      metadata = meta;
      return writable;
    };
    return {
      sink,
      from,
      metadata: () => metadata,
      writes: () => writes,
      text: () => Buffer.concat(chunks).toString("utf-8"),
    };
  }

  it("ステータスとヘッダを先に渡し、本文を流し終えたらストリームを閉じる", async () => {
    const stream = fakeStream();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: message\n"));
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        controller.close();
      },
    });
    const handler = createStreamingLambdaHandler(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      stream.from,
    );

    await handler(event(), stream.sink);

    expect(stream.metadata()).toMatchObject({
      statusCode: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(stream.text()).toBe("event: message\ndata: {}\n\n");
    expect(stream.sink.writableEnded).toBe(true);
  });

  it("本文の無い応答もステータスとヘッダを返して閉じる", async () => {
    const stream = fakeStream();
    const handler = createStreamingLambdaHandler(
      async () =>
        new Response(null, {
          status: 204,
          headers: { "access-control-allow-origin": "*" },
        }),
      stream.from,
    );

    await handler(event(), stream.sink);

    expect(stream.metadata()).toMatchObject({
      statusCode: 204,
      headers: { "access-control-allow-origin": "*" },
    });
    expect(stream.sink.writableEnded).toBe(true);
    // Lambda の実行環境はステータスとヘッダを最初の write のときに送る。write 無しに end するとそれらが送られず、
    // 204 と CORS ヘッダが消えてプリフライトが通らなくなる（2026-09-25 にクラウドで実測）
    expect(stream.writes()).toBeGreaterThan(0);
  });

  it("リクエストへの変換はバッファ版と同じ", async () => {
    const stream = fakeStream();
    let seen: Request | undefined;
    const handler = createStreamingLambdaHandler(async (request) => {
      seen = request;
      return new Response("ok");
    }, stream.from);

    await handler(event({ rawQueryString: "a=1" }), stream.sink);

    expect(new URL(seen?.url ?? "").search).toBe("?a=1");
    expect(await seen?.text()).toBe('{"ping":true}');
  });
});
