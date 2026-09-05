import { describe, expect, it } from 'vitest';
import { assertPendingInterrupts } from './interrupt-guard.js';

const PENDING = [{ id: 'int-1' }, { id: 'int-2' }];

describe('assertPendingInterrupts', () => {
  it('承認待ちの ID への応答は通す', () => {
    expect(() => assertPendingInterrupts(PENDING, [{ interruptId: 'int-1' }])).not.toThrow();
    expect(() =>
      assertPendingInterrupts(PENDING, [{ interruptId: 'int-1' }, { interruptId: 'int-2' }]),
    ).not.toThrow();
  });

  it('承認待ちが 1 件も無ければ弾く', () => {
    expect(() => assertPendingInterrupts([], [{ interruptId: 'int-1' }])).toThrow(/承認待ち/);
  });

  it('承認待ちに無い ID への応答は弾く（1 件でも混ざれば全体を弾く）', () => {
    expect(() => assertPendingInterrupts(PENDING, [{ interruptId: 'int-x' }])).toThrow(/承認待ち/);
    expect(() =>
      assertPendingInterrupts(PENDING, [{ interruptId: 'int-1' }, { interruptId: 'int-x' }]),
    ).toThrow(/承認待ち/);
  });

  it('応答が空なら弾く', () => {
    expect(() => assertPendingInterrupts(PENDING, [])).toThrow(/承認待ち/);
  });
});
