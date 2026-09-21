import { describe, expect, it, vi } from "vitest";
import { createQuoteSealKeyLoader, DEV_QUOTE_SEAL_KEY } from "./seal-key.js";

describe("見積書の封の鍵", () => {
  it("環境変数に鍵があればそれを使う", async () => {
    const fetchSecret = vi.fn();
    const load = createQuoteSealKeyLoader(
      { QUOTE_SEAL_KEY: "env-key" },
      fetchSecret,
    );
    expect(await load()).toBe("env-key");
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  it("ARN があれば Secrets Manager から読む", async () => {
    const fetchSecret = vi.fn().mockResolvedValue("secret-key");
    const load = createQuoteSealKeyLoader(
      { QUOTE_SEAL_SECRET_ARN: "arn:aws:secretsmanager:..." },
      fetchSecret,
    );
    expect(await load()).toBe("secret-key");
    expect(fetchSecret).toHaveBeenCalledWith("arn:aws:secretsmanager:...");
  });

  it("一度読んだ鍵は取り直さない", async () => {
    const fetchSecret = vi.fn().mockResolvedValue("secret-key");
    const load = createQuoteSealKeyLoader(
      { QUOTE_SEAL_SECRET_ARN: "arn" },
      fetchSecret,
    );
    await load();
    await load();
    expect(fetchSecret).toHaveBeenCalledOnce();
  });

  // 鍵が無いまま本番で動くと封を偽造され、安い段で買われる（決定55）
  it("どちらも無ければ開発用の鍵に落ちる", async () => {
    const load = createQuoteSealKeyLoader({}, vi.fn());
    expect(await load()).toBe(DEV_QUOTE_SEAL_KEY);
  });

  it("Secrets Manager が失敗しても開発用の鍵で動き続ける", async () => {
    const load = createQuoteSealKeyLoader(
      { QUOTE_SEAL_SECRET_ARN: "arn" },
      vi.fn().mockRejectedValue(new Error("denied")),
    );
    expect(await load()).toBe(DEV_QUOTE_SEAL_KEY);
  });
});
