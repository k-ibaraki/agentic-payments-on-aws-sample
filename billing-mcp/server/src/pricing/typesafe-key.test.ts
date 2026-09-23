import { describe, expect, it, vi } from "vitest";
import {
  createApiKeyLoader,
  RETRY_COOLDOWN_MS,
  UNSET_API_KEY,
} from "./typesafe-key.js";

describe("Jev の API キーの読み手（決定58）", () => {
  it("環境変数があればそれを使い、Secrets Manager を呼ばない", async () => {
    const read = vi.fn();
    const load = createApiKeyLoader({
      env: { TYPESAFE_API_KEY: "env-key", TYPESAFE_API_KEY_SECRET_ARN: "arn" },
      read,
    });
    expect(await load()).toBe("env-key");
    expect(read).not.toHaveBeenCalled();
  });

  it("環境変数が無ければ Secrets Manager から読む", async () => {
    const read = vi.fn().mockResolvedValue("secret-key");
    const load = createApiKeyLoader({
      env: { TYPESAFE_API_KEY_SECRET_ARN: "arn:aws:secretsmanager:::secret:x" },
      read,
    });
    expect(await load()).toBe("secret-key");
    expect(read).toHaveBeenCalledWith("arn:aws:secretsmanager:::secret:x");
  });

  // コールドスタートに一度だけ読み、コンテナ内に保持する
  it("一度読めたら読み直さない", async () => {
    const read = vi.fn().mockResolvedValue("secret-key");
    const load = createApiKeyLoader({
      env: { TYPESAFE_API_KEY_SECRET_ARN: "arn" },
      read,
    });
    await load();
    await load();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("鍵の置き場が指定されていなければ読みに行かない", async () => {
    const read = vi.fn();
    const load = createApiKeyLoader({ env: {}, read });
    expect(await load()).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  // CDK が空の Secret を作るので、値の入れ忘れは実際に起きる
  it("秘密が空なら未設定として扱う", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = createApiKeyLoader({
      env: { TYPESAFE_API_KEY_SECRET_ARN: "arn" },
      read: vi.fn().mockResolvedValue("   "),
    });
    expect(await load()).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // CDK はランダム生成を避けて仮の値を入れる。出鱈目な鍵で 401 を繰り返さないため
  it("仮の値のままなら未設定として扱う", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = createApiKeyLoader({
      env: { TYPESAFE_API_KEY_SECRET_ARN: "arn" },
      read: vi.fn().mockResolvedValue(UNSET_API_KEY),
    });
    expect(await load()).toBeUndefined();
    warn.mockRestore();
  });

  it("取得に失敗しても投げず、未設定として扱う", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = createApiKeyLoader({
      env: { TYPESAFE_API_KEY_SECRET_ARN: "arn" },
      read: vi.fn().mockRejectedValue(new Error("AccessDenied")),
    });
    expect(await load()).toBeUndefined();
    warn.mockRestore();
  });

  // 失敗を永久に覚えると、あとから鍵を入れてもコンテナが入れ替わるまで効かない
  it("失敗のあと、冷却時間が過ぎれば読み直す", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("AccessDenied"))
      .mockResolvedValue("secret-key");
    let now = 0;
    const load = createApiKeyLoader({
      env: { TYPESAFE_API_KEY_SECRET_ARN: "arn" },
      read,
      now: () => now,
    });
    expect(await load()).toBeUndefined();
    now += RETRY_COOLDOWN_MS - 1;
    expect(await load()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    now += 1;
    expect(await load()).toBe("secret-key");
    vi.restoreAllMocks();
  });
});
