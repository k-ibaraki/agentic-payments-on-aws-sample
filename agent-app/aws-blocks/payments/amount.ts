// 支払額の表示（決定60）。
//
// x402 の `accepts[].amount` は資産の最小単位の整数（テスト USDC なら 150000）で来る。
// そのままでは額の大小が人に伝わらないため、桁数を知っている資産ではドル表記を主に、
// 最小単位を括弧で併記する。知らない資産では桁数を推量せず最小単位だけを出す
// （推量を外すと、実際より安くも高くも見せてしまう）。
//
// ここに依存を増やさないこと。ブラウザ側からも読める純粋な計算だけを置く

/** 支払った（あるいは支払おうとした）額。x402 の `accepted` から取る生の値 */
export interface PaidAmount {
  /** 資産の最小単位の整数 */
  amount: string;
  /** 資産のコントラクトアドレス */
  asset: string;
}

interface AssetInfo {
  symbol: string;
  decimals: number;
}

/**
 * 桁数を知っている資産。鍵はアドレスの小文字（EVM のチェックサム表記の揺れを同一視する）。
 * 決定8 のとおり、本サンプルが扱うのは Base Sepolia のテスト USDC だけ
 */
const KNOWN_ASSETS: Record<string, AssetInfo> = {
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { symbol: 'USDC', decimals: 6 },
};

export function assetInfo(asset: string | undefined): AssetInfo | undefined {
  return asset ? KNOWN_ASSETS[asset.toLowerCase()] : undefined;
}

/**
 * 最小単位の整数を decimals 桁で割った十進表記にする。末尾の 0 は落とす。
 * 既に小数点を含む値は十進表記とみなしてそのまま返す
 */
export function formatTokenAmount(amount: string, decimals: number): string {
  if (amount.includes('.')) return amount;
  const digits = amount.replace(/^-/, '').padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals === 0 ? '' : digits.slice(-decimals).replace(/0+$/, '');
  const sign = amount.startsWith('-') ? '-' : '';
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * 最小単位の額をドル表記にする（売り手の提示と同じ "$0.15" の形）。
 * 桁数を知らない資産や、最小単位の整数でない値では undefined
 */
export function usdOf(amount: string, asset: string | undefined): string | undefined {
  const info = assetInfo(asset);
  if (!info || !/^\d+$/.test(amount)) return undefined;
  return `$${formatTokenAmount(amount, info.decimals)}`;
}

/** 併記の表記。ドルに直せなければ最小単位だけを、そうと分かる形で出す */
export function describeAmount(paid: PaidAmount): string {
  const usd = usdOf(paid.amount, paid.asset);
  return usd ? `${usd}（${paid.amount}）` : `${paid.amount}（最小単位）`;
}

/**
 * ツール要約（LLM と画面が読む）に載せる欄。生の額と人が読む表記を分けて持つ。
 * 生の額は記録と突き合わせのため、表記は LLM の報告と画面の表示のため
 */
export function amountFields(
  paid: PaidAmount | undefined,
): { amount: string; asset: string; amountDisplay: string } | undefined {
  if (!paid) return undefined;
  return { amount: paid.amount, asset: paid.asset, amountDisplay: describeAmount(paid) };
}
