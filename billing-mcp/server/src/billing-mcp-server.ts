import fs from "node:fs";
import path from "node:path";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createPaymentWrapper, x402ResourceServer } from "@x402/mcp";
import { guardPayment } from "./payment-guard.js";
import type { Judge } from "./pricing/judge.js";
import type { TierTable } from "./pricing/tiers.js";
import {
  type ConverseFn,
  createGenerateHtmlHandler,
  type GenerationBudget,
  PREVIEW_VIEW_RESOURCE_URI,
  registerGenerateHtmlTool,
} from "./tools/generate-html.js";

// Base Sepolia（テストネット）。DESIGN.md 決定8参照
export const NETWORK = "eip155:84532";
// 0.1 テスト USDC / 呼び出し。DESIGN.md 決定18参照
export const DEFAULT_PRICE = "$0.1";
// 決済（settle）をハンドラ実行前に行う。無認証の公開エンドポイントで、
// 署名は有効だが決済が通らない支払いにより Bedrock の生成コストだけを
// 負わされる経路を塞ぐ。DESIGN.md 決定21参照
export const PAYMENT_FLOW = "upfront";

export interface BillingMcpServerOptions {
  /** x402 facilitator の URL（テストでは偽サーバーに差し替える） */
  facilitatorUrl: string;
  /** 売上の受取先ウォレットアドレス */
  payTo: `0x${string}`;
  /** 価格（"$0.01" 形式）。省略時は DEFAULT_PRICE */
  price?: string;
  /** Bedrock 呼び出し（テストでは偽物に差し替える） */
  converse?: ConverseFn;
  /** ui:// で配信する HTML のローダー（テストでは差し替える） */
  loadUiHtml?: () => string;
  /**
   * 段から決まる生成の予算（決定56）。省略時は規模を指示しない。
   * リクエストごとに段が変わるため、サーバーを組むたびに渡す
   */
  generation?: GenerationBudget;
  /** 段の判定器（決定53）。省略時は Bedrock の Haiku */
  judge?: Judge;
  /** 段ごとの価格表（決定56）。省略時は既定値。AppConfig から差し替える */
  tierTable?: TierTable;
  /** 見積書の封の鍵（決定55）。本番では Secrets Manager から渡す */
  quoteSealKey?: string;
}

// ui:// で配信する HTML の場所を決める。
// ローカルは vite build（singlefile）の出力をそのまま読む。Lambda ではバンドル後に
// import.meta.dirname が変わるため、パスを推測させず UI_HTML_PATH で明示する
export function resolveUiHtmlPath(): string {
  return (
    process.env.UI_HTML_PATH ??
    path.join(
      import.meta.dirname,
      "..",
      "dist",
      "ui",
      "src",
      "ui",
      "preview-view.html",
    )
  );
}

function defaultLoadUiHtml(): string {
  return fs.readFileSync(resolveUiHtmlPath(), "utf-8");
}

// 支払いラッパー（有料ツール用）を作る。facilitator への /supported 照会を伴う。
// 組み立てた accepts も返す。settle 前の門番（payment-guard）が、買い手の支払いを
// 売り手側の条件と突き合わせるのに要る
/**
 * facilitator への `/supported` 照会を伴う初期化。往復を伴うので使い回す。
 *
 * 段ごとに価格が変わる（決定56）ため accepts の構築は毎リクエスト行うが、
 * そちらは局所計算のみで往復しない
 */
export async function createResourceServer(facilitatorUrl: string) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  resourceServer.register(NETWORK, new ExactEvmScheme());
  await resourceServer.initialize();
  return resourceServer;
}

/**
 * 初期化済みの resourceServer から、この呼び出し用の accepts と支払いラッパーを組む。
 *
 * `quoteSeal` は見積書の封（決定55）。`extra.quote` に載せると買い手がそのまま
 * エコーバックしてくるので、支払い付きの呼び出しでは判定をやり直さずに済む
 */
export async function buildPaidWrapper(
  resourceServer: Awaited<ReturnType<typeof createResourceServer>>,
  options: { payTo: `0x${string}`; price?: string; quoteSeal?: string },
) {
  const accepts = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: NETWORK,
    payTo: options.payTo,
    price: options.price ?? DEFAULT_PRICE,
    // EIP-712 ドメインパラメータ（Base Sepolia のテスト USDC）と支払いフロー。
    // exact スキームは eip3009 で authorization / upfront に対応する
    extra: {
      name: "USDC",
      version: "2",
      paymentFlow: PAYMENT_FLOW,
      ...(options.quoteSeal ? { quote: options.quoteSeal } : {}),
    },
  });

  const paid = createPaymentWrapper(resourceServer, {
    accepts,
    resource: {
      url: "mcp://tool/generate-html",
      description: "ユーザーの指示に従ってHTMLを生成する",
      mimeType: "application/json",
    },
  });

  return { paid, accepts };
}

/** 初期化と構築をまとめて行う従来の入口。毎回 facilitator へ照会するので使い回さない経路向け */
export async function createPaidWrapper(options: {
  facilitatorUrl: string;
  payTo: `0x${string}`;
  price?: string;
  quoteSeal?: string;
}) {
  const resourceServer = await createResourceServer(options.facilitatorUrl);
  return buildPaidWrapper(resourceServer, options);
}

export async function createBillingMcpServer(
  options: BillingMcpServerOptions,
  sharedPaid?: Awaited<ReturnType<typeof createPaidWrapper>>,
): Promise<McpServer> {
  const { paid, accepts } =
    sharedPaid ??
    (await createPaidWrapper({
      facilitatorUrl: options.facilitatorUrl,
      payTo: options.payTo,
      price: options.price,
    }));

  const server = new McpServer({ name: "billing-mcp", version: "0.1.0" });

  // 支払いラッパーの外側を門番で包む。上流は authorization の中身を見ずに settle へ
  // 渡すため、明らかに要求に合わない支払いをここで止める（payment-guard.ts、U9）
  registerGenerateHtmlTool(
    server,
    guardPayment(
      paid(createGenerateHtmlHandler(options.converse, options.generation)),
      accepts,
    ),
  );

  const loadUiHtml = options.loadUiHtml ?? defaultLoadUiHtml;
  registerAppResource(
    server,
    "Preview View",
    PREVIEW_VIEW_RESOURCE_URI,
    {},
    async () => ({
      contents: [
        {
          uri: PREVIEW_VIEW_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: loadUiHtml(),
        },
      ],
    }),
  );

  return server;
}
