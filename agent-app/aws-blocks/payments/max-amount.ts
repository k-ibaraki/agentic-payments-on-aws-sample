// 利用者ごとの 1 回の支払い上限を画面から変えられるようにする（決定66）。
// 値は KVStore `payment-max-amount` に利用者（Cognito の sub）をキーで持ち、無ければ環境変数の既定
// （PAYMENT_MAX_AMOUNT）を使う。売り手の提示を払うかどうかはアプリ側の判定（x402-payer.ts の
// selectAcceptable）だけで決まり、AgentCore Payments とは関わらないので、変えても PaymentSession は
// 破棄しない。次の購入から効く。天井は設けない（実質の天井はセッションの残枠とウォレット残高）
import { formatTokenAmount, toTokenUnits } from './amount.js';
import { isUsdAmount } from './spend-limit.js';

/** 決定8 のテスト USDC の桁数。支払いポリシーの資産はこれに固定されている */
const USDC_DECIMALS = 6;

export interface MaxAmountRecord {
  /** 資産の最小単位の整数（PAYMENT_MAX_AMOUNT と同じ表現） */
  maxAmount: string;
  updatedAt: number;
}

/** KVStore の必要最小限。テストではメモリ実装で代える */
export interface MaxAmountStore {
  get(key: string): Promise<MaxAmountRecord | null>;
  put(key: string, value: MaxAmountRecord): Promise<void>;
}

export interface MaxAmount {
  /** 支払いポリシーに渡す最小単位の整数 */
  maxAmount: string;
  /** 画面に出す USD 表記（小数 2 桁以上）。既定が最小単位の整数でなければ null */
  maxAmountUsd: string | null;
  /** user = 利用者が画面で設定した値、default = 環境変数の既定 */
  source: 'user' | 'default';
}

export interface MaxAmountSource {
  get(userSub: string): Promise<MaxAmount>;
  /** USD で受ける。書式外・0 は拒む（支出上限と同じ書式） */
  set(userSub: string, maxAmountUsd: string): Promise<MaxAmount>;
}

// 支出上限の欄（"2.50"）と並べて読むため小数 2 桁以上に揃える。細かい既定の桁は落とさない
function usdDisplay(maxAmount: string): string | null {
  if (!/^\d+$/.test(maxAmount)) return null;
  const [whole, fraction = ''] = formatTokenAmount(maxAmount, USDC_DECIMALS).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

function describe(maxAmount: string, source: MaxAmount['source']): MaxAmount {
  return { maxAmount, maxAmountUsd: usdDisplay(maxAmount), source };
}

export function maxAmountSource(
  store: MaxAmountStore,
  defaultMaxAmount: string,
  now: () => number = Date.now,
): MaxAmountSource {
  return {
    async get(userSub) {
      const saved = await store.get(userSub);
      return saved ? describe(saved.maxAmount, 'user') : describe(defaultMaxAmount, 'default');
    },
    async set(userSub, maxAmountUsd) {
      if (!isUsdAmount(maxAmountUsd)) {
        throw new Error(
          `上限は正の金額で指定してください（例 0.20。小数は 2 桁まで、桁区切りは使えません）: ${maxAmountUsd}`,
        );
      }
      const maxAmount = toTokenUnits(maxAmountUsd, USDC_DECIMALS);
      await store.put(userSub, { maxAmount, updatedAt: now() });
      console.log(`[max-amount] 1 回の上限を変更 利用者=${userSub} 上限=${maxAmount}（最小単位）`);
      return describe(maxAmount, 'user');
    },
  };
}
