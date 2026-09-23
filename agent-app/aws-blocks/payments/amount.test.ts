// 支払額の表示（決定60）のテスト。ドル表記に直せるのは桁数を知っている資産だけで、
// 知らない資産で推量しないことをここで固定する
import { describe, expect, it } from 'vitest';
import { amountFields, describeAmount, formatTokenAmount, usdOf } from './amount.js';

// 決定8: Base Sepolia のテスト USDC（6 桁）
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

describe('formatTokenAmount', () => {
  it('最小単位の整数を decimals 桁で割った十進表記にし、末尾の 0 は落とす', () => {
    expect(formatTokenAmount('1100000', 6)).toBe('1.1');
    expect(formatTokenAmount('1000000', 6)).toBe('1');
    expect(formatTokenAmount('5', 6)).toBe('0.000005');
    expect(formatTokenAmount('0', 6)).toBe('0');
    expect(formatTokenAmount('123', 0)).toBe('123');
  });

  it('既に小数表記で来た値はそのまま返す（API の表記が最小単位か十進かは実測で確定させる）', () => {
    expect(formatTokenAmount('1.1', 6)).toBe('1.1');
  });
});

describe('usdOf', () => {
  it('既知の資産ならドル表記にする（売り手の提示と同じ形）', () => {
    expect(usdOf('150000', USDC)).toBe('$0.15');
    expect(usdOf('100000', USDC)).toBe('$0.1');
    expect(usdOf('200000', USDC)).toBe('$0.2');
  });

  // EVM アドレスのチェックサム表記は大文字小文字が揺れる
  it('アドレスの大文字小文字は同一視する', () => {
    expect(usdOf('150000', USDC.toLowerCase())).toBe('$0.15');
  });

  it('知らない資産・資産不明・読めない額では undefined（桁数を推量しない）', () => {
    expect(usdOf('150000', '0x0000000000000000000000000000000000000001')).toBeUndefined();
    expect(usdOf('150000', undefined)).toBeUndefined();
    expect(usdOf('いくらか', USDC)).toBeUndefined();
  });
});

describe('describeAmount', () => {
  it('ドル表記を主にし、最小単位を括弧で併記する', () => {
    expect(describeAmount({ amount: '150000', asset: USDC })).toBe('$0.15（150000）');
  });

  it('桁数を知らない資産では最小単位だけを、そうと分かる形で出す', () => {
    expect(describeAmount({ amount: '150000', asset: '0x0000000000000000000000000000000000000001' })).toBe(
      '150000（最小単位）',
    );
  });
});

// ツール要約（LLM と画面が読む）に載せる欄。生の額と、人が読む表記を分けて持つ
describe('amountFields', () => {
  it('生の額・資産と、併記の表記を返す', () => {
    expect(amountFields({ amount: '150000', asset: USDC })).toEqual({
      amount: '150000',
      asset: USDC,
      amountDisplay: '$0.15（150000）',
    });
  });

  it('額が分からなければ何も足さない（要約に空欄を作らない）', () => {
    expect(amountFields(undefined)).toBeUndefined();
  });
});
