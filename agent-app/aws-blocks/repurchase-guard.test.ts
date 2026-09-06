// 二重支払いを防ぐ買い手側の硬い防護（決定31・48）。
// 「支払い済みなのに成果物が無い」購入や「支払いの成否が不明」な購入が残っていれば、
// LLM の自動再試行では次の購入を始めさせず、人の承認（interrupt）を要求する。
// 会話単位（会話履歴）と利用者単位（KVStore）の両方を見る規則をここで固定する
import { describe, expect, it } from 'vitest';
import {
  clearUnresolved,
  loadUnresolved,
  pendingApprovals,
  recordUnresolved,
  UNRESOLVED_CAP,
  unresolvedPayments,
  withUnresolved,
  type UnresolvedPaymentRecord,
  type UnresolvedPaymentStore,
} from './repurchase-guard.js';

const paidOk = { resultId: 'a', ok: true, paymentMade: true, htmlBytes: 100 };
const paidFailed = { resultId: 'b', ok: false, paymentMade: true, error: 'Request timed out' };
const unpaidFailed = { resultId: 'c', ok: false, paymentMade: false, error: '売り手に接続できません' };
// ProcessPayment 自体が応答を返さなかった購入（決定48）。支払われたかどうか分からないので
// 「支払い済み」と同じく未解決として扱う
const uncertain = {
  resultId: 'u',
  ok: false,
  paymentMade: false,
  paymentUncertain: true,
  error: '支払いの成否を確認できません',
};

describe('unresolvedPayments', () => {
  it('支払い済みで成果物の無い購入だけを返す', () => {
    expect(unresolvedPayments([paidOk, paidFailed, unpaidFailed])).toEqual([paidFailed]);
  });

  it('無ければ空（承認は不要）', () => {
    expect(unresolvedPayments([paidOk, unpaidFailed])).toEqual([]);
    expect(unresolvedPayments([])).toEqual([]);
  });

  // 承認して買い直しが成功したら、その前の失敗は解決済みとして扱う。
  // さもないと一度事故が起きた会話は以後ずっと承認待ちになり、決定31 が
  // 「毎回の承認を必須にする案は不採用」とした意図と食い違う
  it('最後の成功より前の失敗は未解決に数えない', () => {
    expect(unresolvedPayments([paidFailed, paidOk])).toEqual([]);
    expect(unresolvedPayments([paidFailed, paidOk, unpaidFailed])).toEqual([]);
  });

  it('最後の成功より後の失敗は未解決に数える', () => {
    const later = { resultId: 'd', ok: false, paymentMade: true, error: '再び失敗' };
    expect(unresolvedPayments([paidFailed, paidOk, later])).toEqual([later]);
  });

  it('成功が一度も無ければ、支払い済みの失敗をすべて返す', () => {
    const another = { resultId: 'e', ok: false, paymentMade: true, error: '二度目の失敗' };
    expect(unresolvedPayments([paidFailed, another])).toEqual([paidFailed, another]);
  });

  // ProcessPayment がタイムアウトした購入は paymentMade が立たない。それでも
  // 支払いが成立している可能性があるため、未解決として承認を要求する（決定48）
  it('支払いの成否が不明な購入も未解決に数える', () => {
    expect(unresolvedPayments([uncertain])).toEqual([uncertain]);
    expect(unresolvedPayments([uncertain, paidOk])).toEqual([]);
  });
});

describe('withUnresolved', () => {
  it('未解決の resultId を足す', () => {
    expect(withUnresolved([], 'a')).toEqual(['a']);
    expect(withUnresolved(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('同じ resultId は重ねない', () => {
    expect(withUnresolved(['a', 'b'], 'a')).toEqual(['a', 'b']);
  });

  // 記録は TTL を付けずに残す（決定48）ので、際限なく伸びないよう上限で古いものから落とす。
  // 1 件でも残っていれば承認は要求されるため、古い ID が落ちても防護は働く
  it('上限を超えたら古いものから落とす', () => {
    const many = Array.from({ length: UNRESOLVED_CAP }, (_, i) => `id-${i}`);
    const added = withUnresolved(many, 'new');
    expect(added).toHaveLength(UNRESOLVED_CAP);
    expect(added.at(0)).toBe('id-1');
    expect(added.at(-1)).toBe('new');
  });
});

describe('pendingApprovals', () => {
  it('会話単位の未解決を返す', () => {
    expect(pendingApprovals([paidFailed], [])).toEqual(['b']);
  });

  // 修正の核心（決定48）: 事故の残る会話を離れて新しい会話を作っても、
  // 利用者単位の記録が残っている限り承認を要求する
  it('別の会話で起きた事故でも、利用者の記録が残っていれば承認を要求する', () => {
    expect(pendingApprovals([], ['b'])).toEqual(['b']);
    expect(pendingApprovals([paidOk], ['b'])).toEqual(['b']);
  });

  it('両方にあれば重複を除いて統合する', () => {
    expect(pendingApprovals([paidFailed], ['b', 'z'])).toEqual(['b', 'z']);
  });

  it('どちらにも無ければ空（承認は不要）', () => {
    expect(pendingApprovals([paidOk], [])).toEqual([]);
    expect(pendingApprovals([], [])).toEqual([]);
  });
});

// KVStore の最小実装。条件付き書き込み（ifValueEquals）は DynamoDB と同じく
// 満たさなければ ConditionalCheckFailedException で落とす
function memoryStore(initial?: UnresolvedPaymentRecord): UnresolvedPaymentStore & {
  data: Map<string, UnresolvedPaymentRecord>;
} {
  const data = new Map<string, UnresolvedPaymentRecord>();
  if (initial) data.set('user-a', initial);
  const conflict = () =>
    Object.assign(new Error('条件を満たしませんでした'), { name: 'ConditionalCheckFailedException' });
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value, options) {
      const current = data.get(key) ?? null;
      if (
        options?.ifValueEquals !== undefined &&
        JSON.stringify(current) !== JSON.stringify(options.ifValueEquals)
      ) {
        throw conflict();
      }
      data.set(key, value);
    },
    async delete(key, options) {
      const current = data.get(key) ?? null;
      if (
        options?.ifValueEquals !== undefined &&
        JSON.stringify(current) !== JSON.stringify(options.ifValueEquals)
      ) {
        throw conflict();
      }
      data.delete(key);
    },
  };
}

describe('利用者ごとの未解決記録', () => {
  it('記録が無ければ空を返す', async () => {
    expect(await loadUnresolved(memoryStore(), 'user-a')).toEqual([]);
  });

  it('記録した ID を読み出せる', async () => {
    const store = memoryStore();
    await recordUnresolved(store, 'user-a', 'r1');
    await recordUnresolved(store, 'user-a', 'r2');
    expect(await loadUnresolved(store, 'user-a')).toEqual(['r1', 'r2']);
  });

  it('利用者ごとに分かれる', async () => {
    const store = memoryStore();
    await recordUnresolved(store, 'user-a', 'r1');
    expect(await loadUnresolved(store, 'user-b')).toEqual([]);
  });

  it('購入が成功したら記録を消す', async () => {
    const store = memoryStore();
    await recordUnresolved(store, 'user-a', 'r1');
    await clearUnresolved(store, 'user-a');
    expect(await loadUnresolved(store, 'user-a')).toEqual([]);
  });

  it('記録が無いまま消しても失敗しない', async () => {
    await expect(clearUnresolved(memoryStore(), 'user-a')).resolves.toBeUndefined();
  });

  // 読んでから書くまでの間に別の購入が書いていたら、相手の記録を消さない。
  // 取りこぼしても記録は空にならないので、承認の要求は働き続ける
  it('書き込みが競合しても例外にしない', async () => {
    const store = memoryStore();
    await recordUnresolved(store, 'user-a', 'r1');
    const racing: UnresolvedPaymentStore = {
      ...store,
      async put(key, value, options) {
        // 読んだ後に別の購入が書き換えた状況を作る
        store.data.set(key, { resultIds: ['other'], updatedAt: 1 });
        return store.put(key, value, options);
      },
    };
    await expect(recordUnresolved(racing, 'user-a', 'r2')).resolves.toBeUndefined();
    expect(await loadUnresolved(store, 'user-a')).toEqual(['other']);
  });

  // 成功で消す間に別の購入が失敗を記録していたら、その記録は残す
  // （消すと未解決の支払いが記録から消え、承認を求められなくなる）
  it('消す間に別の購入が記録していたら残す', async () => {
    const store = memoryStore();
    await recordUnresolved(store, 'user-a', 'r1');
    const racing: UnresolvedPaymentStore = {
      ...store,
      async delete(key, options) {
        store.data.set(key, { resultIds: ['r1', 'r2'], updatedAt: 2 });
        return store.delete(key, options);
      },
    };
    await expect(clearUnresolved(racing, 'user-a')).resolves.toBeUndefined();
    expect(await loadUnresolved(store, 'user-a')).toEqual(['r1', 'r2']);
  });
});
