// MCP の HTTP 層。Lambda Function URL とローカル開発サーバーの共通実装。
// Web 標準の Request/Response で完結させ、express は使わない（DESIGN.md 決定22）
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type BillingMcpServerOptions,
  buildPaidWrapper,
  createBillingMcpServer,
  createResourceServer,
} from "./billing-mcp-server.js";
import { tierTableLoaderFromEnv } from "./pricing/config.js";
import { createBedrockJudge } from "./pricing/judge.js";
import { createJudgeBudget } from "./pricing/judge-guard.js";
import { createJudgeSelector } from "./pricing/judge-select.js";
import { resolveQuote } from "./pricing/quote.js";
import {
  DEFAULT_TIER_TABLE,
  generationBudgetOf,
  quoteDisclosure,
  tierLabel,
} from "./pricing/tiers.js";
import {
  createApiKeyLoader,
  createDefaultSecretReader,
} from "./pricing/typesafe-key.js";
import {
  type ConverseFn,
  createDefaultConverse,
} from "./tools/generate-html.js";

/** MCP のエンドポイント。ローカルも Function URL も同じパス（決定4） */
export const MCP_PATH = "/mcp";

/**
 * 見積もりの呼び出し予算の既定値（決定57）。
 *
 * コンテナごとに持つので、全体の天井は「同時実行数 × この値」になる。
 * 正規の買い手は 1 回の購入につき見積もりを 1 度しか要さないため、
 * この程度あれば通常の売買は妨げない
 */
export const DEFAULT_JUDGE_BUDGET = { capacity: 20, refillPerSecond: 0.2 };

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
  // 乱発への防護（決定57、詳細は pricing/judge-guard.ts）。バケツはコンテナに 1 つ
  const judgeBudget = createJudgeBudget(
    options.judgeBudget ?? DEFAULT_JUDGE_BUDGET,
  );
  // 価格帯の判定モデルの選択（決定53・58、詳細は pricing/judge-select.ts）
  const selectJudge = createJudgeSelector({
    bedrock:
      options.judge ??
      createBedrockJudge(resolvedOptions.converse as ConverseFn),
    loadApiKey:
      options.loadApiKey ??
      createApiKeyLoader({
        env: process.env,
        read: createDefaultSecretReader(),
      }),
    ...(options.createSystemOne
      ? { createSystemOne: options.createSystemOne }
      : {}),
  });

  // facilitator への /supported 照会を伴う初期化だけを使い回す。
  // accepts の構築は価格帯ごとに価格が変わるため毎リクエスト行う（決定56）
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

    // 本文は一度しか読めない。価格帯を決めるために先に読み切り、
    // transport には同じ本文で組み直した Request を渡す
    const body = await request.text();

    // AppConfig の読み手があればそれを優先する。読めない設定は退けられ、
    // 直前に読めた表（無ければ既定の表）が返る
    const table = options.loadTierTable
      ? await options.loadTierTable()
      : (options.tierTable ?? DEFAULT_TIER_TABLE);
    // 判定モデルは価格表の指定で毎リクエスト選ぶ（AppConfig で切り替えられるため）。
    // 予算はコンテナ共有のバケツから取る
    const judge = judgeBudget.wrap(await selectJudge(table.judge));
    const quote = await resolveQuote(body, { table, judge });

    let payment: Awaited<ReturnType<typeof buildPaidWrapper>>;
    try {
      payment = await buildPaidWrapper(await getResourceServer(), {
        payTo: options.payTo,
        price: quote.price,
        ...(quote.quote ? { quoteNote: quote.quote } : {}),
        ...(quote.quote
          ? { disclosure: quoteDisclosure(table, quote.tier) }
          : {}),
      });
    } catch (error) {
      // facilitator に到達できないと価格を広告できない。落ちた理由を残す
      console.error("支払いラッパーの初期化に失敗しました", error);
      return jsonResponse(503, {
        error: "Payment facilitator unavailable",
      });
    }

    if (quote.quote) {
      // 確信度は判断に使わないが、水準の記述が効いているかを実地で見るために残す
      const confidence =
        quote.confidence === undefined
          ? ""
          : ` 確信度=${quote.confidence.toFixed(2)}`;
      console.info(
        `[pricing] 価格帯=${tierLabel(quote.tier)} 価格=${quote.price}${confidence}`,
      );
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
  const loadTierTable = tierTableLoaderFromEnv();
  return {
    facilitatorUrl:
      process.env.FACILITATOR_URL ?? "https://x402.org/facilitator",
    payTo,
    ...(loadTierTable ? { loadTierTable } : {}),
  };
}
