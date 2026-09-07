import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it, vi } from "vitest";
import {
  guardPayment,
  PAYMENT_META_KEY,
  paymentRejectionReason,
} from "./payment-guard.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NOW_SECONDS = 1_800_000_000;

const REQUIREMENT: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: ASSET,
  amount: "100000",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2", paymentFlow: "upfront" },
};

const SIGNATURE = `0x${"ab".repeat(65)}`;

function payment(
  overrides: {
    authorization?: Record<string, unknown> | undefined;
    signature?: unknown;
    accepted?: Partial<PaymentRequirements>;
  } = {},
) {
  const authorization =
    "authorization" in overrides
      ? overrides.authorization
      : {
          from: "0x1111111111111111111111111111111111111111",
          to: PAY_TO,
          value: "100000",
          validAfter: "0",
          validBefore: String(NOW_SECONDS + 300),
          nonce: `0x${"cd".repeat(32)}`,
        };
  return {
    x402Version: 2,
    accepted: { ...REQUIREMENT, ...overrides.accepted },
    payload: {
      ...(authorization ? { authorization } : {}),
      signature: "signature" in overrides ? overrides.signature : SIGNATURE,
    },
  };
}

describe("paymentRejectionReason", () => {
  it("要求どおりの支払いは通す", () => {
    expect(
      paymentRejectionReason(payment(), [REQUIREMENT], NOW_SECONDS),
    ).toBeUndefined();
  });

  it("要求より多く払う分には通す", () => {
    const p = payment();
    (p.payload.authorization as Record<string, unknown>).value = "100001";
    expect(
      paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS),
    ).toBeUndefined();
  });

  it("宛先が売り手のアドレスでなければ弾く", () => {
    const p = payment();
    (p.payload.authorization as Record<string, unknown>).to =
      "0x3333333333333333333333333333333333333333";
    expect(paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS)).toMatch(
      /宛先/,
    );
  });

  it("宛先の大文字小文字は問わない", () => {
    const p = payment();
    (p.payload.authorization as Record<string, unknown>).to =
      PAY_TO.toUpperCase();
    expect(
      paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS),
    ).toBeUndefined();
  });

  it("金額が足りなければ弾く", () => {
    const p = payment();
    (p.payload.authorization as Record<string, unknown>).value = "1";
    expect(paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS)).toMatch(
      /金額/,
    );
  });

  it("有効期限が切れていれば弾く", () => {
    const p = payment();
    (p.payload.authorization as Record<string, unknown>).validBefore =
      String(NOW_SECONDS);
    expect(paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS)).toMatch(
      /期限/,
    );
  });

  it("有効期間がまだ始まっていなければ弾く", () => {
    const p = payment();
    (p.payload.authorization as Record<string, unknown>).validAfter = String(
      NOW_SECONDS + 1,
    );
    expect(paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS)).toMatch(
      /期間/,
    );
  });

  it("署名の長さが 65 バイトでなければ弾く", () => {
    expect(
      paymentRejectionReason(
        payment({ signature: "0xdead" }),
        [REQUIREMENT],
        NOW_SECONDS,
      ),
    ).toMatch(/署名/);
  });

  it("署名が 16 進数でなければ弾く", () => {
    expect(
      paymentRejectionReason(
        payment({ signature: `0x${"zz".repeat(65)}` }),
        [REQUIREMENT],
        NOW_SECONDS,
      ),
    ).toMatch(/署名/);
  });

  it("authorization が無ければ弾く（この売り手は eip3009 しか受けない）", () => {
    expect(
      paymentRejectionReason(
        payment({ authorization: undefined }),
        [REQUIREMENT],
        NOW_SECONDS,
      ),
    ).toMatch(/形式/);
  });

  it("金額が数字でなければ弾く", () => {
    const p = payment();
    (p.payload.authorization as Record<string, unknown>).value = "たくさん";
    expect(paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS)).toMatch(
      /形式/,
    );
  });

  it("合致する要求が無ければ判定せず上流に委ねる", () => {
    expect(
      paymentRejectionReason(
        payment({ accepted: { network: "eip155:1" } }),
        [REQUIREMENT],
        NOW_SECONDS,
      ),
    ).toBeUndefined();
  });

  it("accepted が無ければ判定せず上流に委ねる（照合は上流の担当）", () => {
    const p = payment() as Record<string, unknown>;
    p.accepted = undefined;
    expect(
      paymentRejectionReason(p, [REQUIREMENT], NOW_SECONDS),
    ).toBeUndefined();
  });

  it("支払いの形をなしていなければ判定せず上流に委ねる", () => {
    expect(
      paymentRejectionReason("payment", [REQUIREMENT], NOW_SECONDS),
    ).toBeUndefined();
    expect(
      paymentRejectionReason(null, [REQUIREMENT], NOW_SECONDS),
    ).toBeUndefined();
  });
});

describe("guardPayment", () => {
  const ok = { content: [{ type: "text" as const, text: "通した" }] };

  it("支払いが無ければ委譲する（上流が支払い要求を返す）", async () => {
    const inner = vi.fn().mockResolvedValue(ok);
    const guarded = guardPayment(
      inner,
      [REQUIREMENT],
      () => NOW_SECONDS * 1000,
    );
    await expect(guarded({}, { _meta: {} })).resolves.toBe(ok);
    expect(inner).toHaveBeenCalled();
  });

  it("要求どおりの支払いは委譲する", async () => {
    const inner = vi.fn().mockResolvedValue(ok);
    const guarded = guardPayment(
      inner,
      [REQUIREMENT],
      () => NOW_SECONDS * 1000,
    );
    await expect(
      guarded({}, { _meta: { [PAYMENT_META_KEY]: payment() } }),
    ).resolves.toBe(ok);
    expect(inner).toHaveBeenCalled();
  });

  it("要求に合わない支払いは委譲せず、その場で失敗を返す", async () => {
    const inner = vi.fn().mockResolvedValue(ok);
    const guarded = guardPayment(
      inner,
      [REQUIREMENT],
      () => NOW_SECONDS * 1000,
    );
    const result = await guarded(
      {},
      { _meta: { [PAYMENT_META_KEY]: payment({ signature: "0xdead" }) } },
    );
    expect(inner).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/署名/);
  });

  it("支払い要求として解釈されないよう structuredContent は付けない", async () => {
    const inner = vi.fn().mockResolvedValue(ok);
    const guarded = guardPayment(
      inner,
      [REQUIREMENT],
      () => NOW_SECONDS * 1000,
    );
    const result = await guarded(
      {},
      { _meta: { [PAYMENT_META_KEY]: payment({ signature: "0xdead" }) } },
    );
    expect(result.structuredContent).toBeUndefined();
  });
});
