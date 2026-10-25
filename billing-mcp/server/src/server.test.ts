import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { MCP_PATH } from "./app.js";
import {
  createApp,
  MAX_REQUEST_BODY_BYTES,
  parseListenAddress,
} from "./server.js";

describe("parseListenAddress", () => {
  // Web Functions は AWS_LAMBDA_HTTP_ENDPOINT で「このホストとポートで待て」と伝えてくる
  it("AWS_LAMBDA_HTTP_ENDPOINT の host:port を優先する", () => {
    expect(
      parseListenAddress({
        AWS_LAMBDA_HTTP_ENDPOINT: "127.0.0.1:8080",
        PORT: "9",
      }),
    ).toEqual({ hostname: "127.0.0.1", port: 8080 });
  });

  it("無ければ PORT、それも無ければ 8000 で全インターフェースを待つ", () => {
    expect(parseListenAddress({ PORT: "3001" })).toEqual({
      hostname: "0.0.0.0",
      port: 3001,
    });
    expect(parseListenAddress({})).toEqual({ hostname: "0.0.0.0", port: 8000 });
  });
});

describe("createApp", () => {
  it("MCP のパスへの要求を fetch ハンドラにそのまま渡す", async () => {
    const handle = vi.fn(
      async (request: Request) =>
        new Response(`seen ${request.method} ${await request.text()}`, {
          status: 200,
        }),
    );
    const app = createApp(handle);

    const response = await app.request(MCP_PATH, {
      method: "POST",
      body: "hello",
      headers: { "content-type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("seen POST hello");
    expect(handle).toHaveBeenCalledOnce();
  });

  // CORS の preflight（決定10）も fetch ハンドラが受け持つ。Hono 側で横取りしない
  it("OPTIONS も fetch ハンドラへ渡す", async () => {
    const handle = vi.fn(async () => new Response(null, { status: 204 }));
    const app = createApp(handle);
    const response = await app.request(MCP_PATH, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(handle).toHaveBeenCalledOnce();
  });

  it("MCP 以外のパスは 404 を返し、fetch ハンドラを呼ばない", async () => {
    const handle = vi.fn(async () => new Response("unexpected"));
    const app = createApp(handle);
    const response = await app.request("/other", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not Found" });
    expect(handle).not.toHaveBeenCalled();
  });

  // SSE（経過の通知）を届いた順に流せるよう、本文のストリームを読み切らずに返す
  it("ストリームの応答を読み切らずにそのまま返す", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("event: a\n\n"));
        controller.close();
      },
    });
    const app = createApp(
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const response = await app.request(MCP_PATH, { method: "POST" });
    expect(response.body).toBe(body);
  });

  // 無認証の公開エンドポイント。本文は支払いの検証より前に読み切るので、上限で守る
  it("上限を超える本文は 413 を返し、fetch ハンドラを呼ばない", async () => {
    const handle = vi.fn(async () => new Response("unexpected"));
    const app = createApp(handle);
    const response = await app.request(MCP_PATH, {
      method: "POST",
      body: "x".repeat(MAX_REQUEST_BODY_BYTES + 1),
      headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Payload Too Large" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("上限ちょうどの本文はそのまま渡す", async () => {
    const handle = vi.fn(
      async (request: Request) =>
        new Response(String((await request.text()).length)),
    );
    const app = createApp(handle);
    const response = await app.request(MCP_PATH, {
      method: "POST",
      body: "x".repeat(MAX_REQUEST_BODY_BYTES),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(String(MAX_REQUEST_BODY_BYTES));
  });
});

describe("実際の HTTP サーバー（@hono/node-server）越しの SSE", () => {
  // 経過の通知（決定65）は、生成の終わりを待たずに届かなければ意味が無い。
  // 最初のイベントが、次のイベントを出す前に買い手へ届くことを確かめる
  it("最初のイベントが、後続を出す前に届く", async () => {
    const encoder = new TextEncoder();
    let releaseSecond: () => void = () => {};
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const app = createApp(async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode("event: message\ndata: first\n\n"));
          await secondReleased;
          controller.enqueue(
            encoder.encode("event: message\ndata: second\n\n"),
          );
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${MCP_PATH}`, {
        method: "POST",
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("data: first");
      releaseSecond();
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      expect(rest).toContain("data: second");
    } finally {
      releaseSecond();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
