// MCP の HTTP 層。Lambda Function URL とローカル開発サーバーの共通実装。
// Web 標準の Request/Response で完結させ、express は使わない（DESIGN.md 決定22）
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type BillingMcpServerOptions,
  buildPaidWrapper,
  createBillingMcpServer,
  createResourceServer,
} from "./billing-mcp-server.js";
import { createBedrockJudge, type Judge } from "./pricing/judge.js";
import { resolveQuote } from "./pricing/quote.js";
import {
  DEFAULT_TIER_TABLE,
  generationBudgetOf,
  tierLabel,
} from "./pricing/tiers.js";
import {
  type ConverseFn,
  createDefaultConverse,
} from "./tools/generate-html.js";

/** MCP のエンドポイント。ローカルも Function URL も同じパス（決定4） */
export const MCP_PATH = "/mcp";

/**
 * 見積書の封の鍵の既定値（決定55）。開発とテスト専用。
 *
 * 本番で使うと、封を偽造して安い段で買えてしまう。`QUOTE_SEAL_KEY` を必ず渡すこと
 */
export const DEV_QUOTE_SEAL_KEY = "dev-only-quote-seal-key";

// ブラウザが ui:// リソースを直接取得する経路（決定10）のために CORS を開ける。
// Function URL 側の CORS 設定には寄せず、ローカルと本番で同じ挙動にする
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers":
    "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function withCors(headers: Headers): Headers {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return headers;
}

/**
 * 本文をバッファしてはいけない（終わらない）応答か。
 *
 * SSE ストリームに対して `response.text()` を呼ぶと永久に解決しない Promise が
 * でき、Lambda では Runtime.NodeJsExit（Promise が未解決のまま Node が終了）に
 * なって実行環境ごと落ちる。クラウドで実際に踏んだため防護を残す
 */
export function isStreamingResponse(response: Response): boolean {
  return (
    response.headers.get("content-type")?.includes("text/event-stream") ?? false
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withCors(new Headers({ "content-type": "application/json" })),
  });
}

/**
 * MCP を処理する fetch ハンドラを作る。
 *
 * facilitator への /supported 照会を伴う支払いラッパーの構築は、Lambda の
 * INIT フェーズ（10 秒制限）を避けるため初回リクエストまで遅延させる。
 * 失敗した場合は次のリクエストで作り直す。
 */
export function createMcpFetchHandler(
  options: BillingMcpServerOptions,
): (request: Request) => Promise<Response> {
  // ステートレス化でサーバーは毎リクエスト作り直すが、Bedrock クライアント
  // （資格情報チェーンと接続プール）は作り捨てにしない。ここで1度だけ解決して
  // 全リクエストで共有する
  const resolvedOptions: BillingMcpServerOptions = {
    ...options,
    converse: options.converse ?? createDefaultConverse(),
  };
  // 段の判定器（決定53）。Bedrock クライアントは共有する。
  // System One（Jev 互換）へ差し替えるときはここを createSystemOneJudge に替える
  const judge: Judge =
    options.judge ?? createBedrockJudge(resolvedOptions.converse as ConverseFn);

  // facilitator への /supported 照会を伴う初期化だけを使い回す。
  // accepts の構築は段ごとに価格が変わるため毎リクエスト行う（決定56）
  let resourceServerPromise:
    | ReturnType<typeof createResourceServer>
    | undefined;

  const getResourceServer = () => {
    if (!resourceServerPromise) {
      const pending = createResourceServer(options.facilitatorUrl);
      resourceServerPromise = pending;
      pending.catch(() => {
        if (resourceServerPromise === pending)
          resourceServerPromise = undefined;
      });
    }
    return resourceServerPromise;
  };

  return async function handleMcpRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: withCors(new Headers()),
      });
    }

    if (new URL(request.url).pathname !== MCP_PATH) {
      return jsonResponse(404, { error: "Not Found" });
    }

    // ステートレス + enableJsonResponse では単独の SSE ストリームを提供しない。
    // GET をそのまま SDK へ渡すと終わらないストリームが返り、応答が返らなくなる。
    // MCP 仕様上、SSE を提供しないサーバーは GET に 405 を返してよい
    if (request.method === "GET") {
      const response = jsonResponse(405, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message:
            "Method Not Allowed: このサーバーは単独の SSE ストリームを提供しません",
        },
      });
      response.headers.set("allow", "POST, DELETE, OPTIONS");
      return response;
    }

    // 本文は一度しか読めない。段を決めるために先に読み切り、
    // transport には同じ本文で組み直した Request を渡す
    const body = await request.text();

    const table = options.tierTable ?? DEFAULT_TIER_TABLE;
    const quote = await resolveQuote(body, {
      table,
      judge,
      key: options.quoteSealKey ?? DEV_QUOTE_SEAL_KEY,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    let payment: Awaited<ReturnType<typeof buildPaidWrapper>>;
    try {
      payment = await buildPaidWrapper(await getResourceServer(), {
        payTo: options.payTo,
        price: quote.price,
        ...(quote.seal ? { quoteSeal: quote.seal } : {}),
      });
    } catch (error) {
      // facilitator に到達できないと価格を広告できない。落ちた理由を残す
      console.error("支払いラッパーの初期化に失敗しました", error);
      return jsonResponse(503, {
        error: "Payment facilitator unavailable",
      });
    }

    if (quote.seal) {
      console.info(`[pricing] 段=${tierLabel(quote.tier)} 価格=${quote.price}`);
    }

    // ステートレス（sessionIdGenerator 未指定）。1 リクエストごとに
    // サーバーとトランスポートを立て、応答を読み切ってから閉じる
    const server = await createBillingMcpServer(
      { ...resolvedOptions, generation: generationBudgetOf(table, quote.tier) },
      payment,
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body,
        }),
      );
      if (isStreamingResponse(response)) {
        // ここに来る経路は塞いだつもりだが、万一残っていても待ち続けない
        await response.body?.cancel();
        console.error(
          "ストリーミング応答は Function URL のバッファ応答では返せません",
        );
        return jsonResponse(500, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32603,
            message: "Streaming responses are not supported",
          },
        });
      }
      const responseBody = await response.text();
      return new Response(responseBody === "" ? null : responseBody, {
        status: response.status,
        headers: withCors(new Headers(response.headers)),
      });
    } finally {
      await server.close().catch(() => {});
      await transport.close().catch(() => {});
    }
  };
}

/** 環境変数から売り手の設定を読む。PAY_TO_ADDRESS は必須 */
export function optionsFromEnv(): BillingMcpServerOptions {
  const payTo = process.env.PAY_TO_ADDRESS as `0x${string}` | undefined;
  if (!payTo) {
    throw new Error("環境変数 PAY_TO_ADDRESS（売上受取ウォレット）が必要です");
  }
  const quoteSealKey = process.env.QUOTE_SEAL_KEY;
  if (!quoteSealKey) {
    console.warn(
      "[pricing] QUOTE_SEAL_KEY が未設定です。開発用の鍵で動きますが、" +
        "本番では封を偽造されます（決定55）",
    );
  }
  return {
    facilitatorUrl:
      process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
    payTo,
    price: process.env.PRICE,
    ...(quoteSealKey ? { quoteSealKey } : {}),
  };
}
