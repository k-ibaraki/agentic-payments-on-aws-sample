import type { LambdaFunctionURLEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createLambdaHandler } from "./handler.js";

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
