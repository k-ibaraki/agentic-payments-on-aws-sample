// 見積書の封（DESIGN.md 決定55）。
//
// x402 は 2 往復する。支払いの無い呼び出しに 402 で価格を提示し、買い手が署名して
// 再び呼ぶ。上流の照合（`@x402/core` の paymentRequirementsMatchAccepted）は `amount`
// を含む core フィールドを deepEqual で突き合わせるため、2 往復で同じ額を再現できないと
// 買い手は 402 を受け取り続ける。段の判定は決定的でないので、1 往復目で判じた結果を
// 封じて `accepts[].extra.quote` に載せ、2 往復目は判定をやり直さず封を検めるだけにする。
//
// 封には引数の指紋を含める。安い見積書を高い依頼に付け替える細工を防ぐため。
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** 段（DESIGN.md 決定56）。表示名は梅・竹・松だが、封や JSON には ASCII の鍵で載せる */
export type Tier = "ume" | "take" | "matsu";

export interface SealedQuote {
  /** 見積もった対象のツール名 */
  toolName: string;
  /** ツール引数の指紋（fingerprintArgs の戻り値） */
  argsFingerprint: string;
  /** 判じた段 */
  tier: Tier;
  /** 提示する価格（"$0.15" 形式） */
  price: string;
  /** 有効期限（UNIX 秒） */
  expiresAt: number;
}

/** 封の書式の版。中身の並びを変えるときは上げる */
const VERSION = "v1";

/**
 * 区切り。封の各項目に現れない文字を選ぶ。
 *
 * `.` は使えない。価格が "$0.15" のように小数点を含み、分割が狂うため
 * （2026-09-21、テストで検出）
 */
const SEP = "|";

/**
 * ツール引数の指紋。キーの並び順に依らず、値が違えば変わる。
 *
 * 鍵を並べ替えてから JSON にするので、買い手が引数の順序だけ変えて送っても同じ指紋になる。
 * `undefined` の項目は JSON.stringify が落とすため、項目の有無は自然に区別される
 */
export function fingerprintArgs(args: unknown): string {
  return createHash("sha256").update(canonicalize(args)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

/** 封の本体（署名の対象）。項目の順序は検証側と揃える */
function body(quote: SealedQuote): string {
  return [
    VERSION,
    quote.toolName,
    quote.argsFingerprint,
    quote.tier,
    quote.price,
    String(quote.expiresAt),
  ].join(SEP);
}

/** 見積もりを封じる。戻り値をそのまま `accepts[].extra.quote` に載せる */
export function sealQuote(quote: SealedQuote, key: string): string {
  const payload = body(quote);
  const mac = createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}${SEP}${mac}`;
}

export interface OpenQuoteContext {
  /** 呼ばれたツール名 */
  toolName: string;
  /** 実際に届いた引数の指紋 */
  argsFingerprint: string;
  /** 封に使った鍵 */
  key: string;
  /** 現在時刻（UNIX 秒） */
  nowSeconds: number;
}

/**
 * 封を検める。通れば封じられていた見積もりを返し、少しでも合わなければ undefined。
 *
 * 例外は投げない。封は外部入力（買い手がエコーバックしてくる値）なので、壊れた形も
 * 攻撃も「開かない」の一語に畳む
 */
export function openQuoteSeal(
  sealed: string,
  context: OpenQuoteContext,
): SealedQuote | undefined {
  const parts = sealed.split(SEP);
  if (parts.length !== 7) return undefined;
  const [version, toolName, argsFingerprint, tier, price, expiresAt, mac] =
    parts;
  if (version !== VERSION) return undefined;
  if (tier !== "ume" && tier !== "take" && tier !== "matsu") return undefined;
  if (!/^\d+$/.test(expiresAt)) return undefined;

  const quote: SealedQuote = {
    toolName,
    argsFingerprint,
    tier,
    price,
    expiresAt: Number(expiresAt),
  };

  // 封が破られていないか。文字列比較の時間差から中身を探られないよう timingSafeEqual を使う
  const expected = createHmac("sha256", context.key)
    .update(body(quote))
    .digest("base64url");
  if (!equalsConstantTime(mac, expected)) return undefined;

  // 中身が今回の呼び出しと合っているか
  if (quote.toolName !== context.toolName) return undefined;
  if (quote.argsFingerprint !== context.argsFingerprint) return undefined;
  if (quote.expiresAt <= context.nowSeconds) return undefined;

  return quote;
}

function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
