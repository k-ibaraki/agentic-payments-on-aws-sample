import {
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { describe, expect, it, vi } from "vitest";
import {
  createAppConfigDataReader,
  createTierTableLoader,
  tierTableLoaderFromEnv,
} from "./config.js";
import { DEFAULT_TIER_TABLE, priceOf } from "./tiers.js";

const VALID = {
  tiers: {
    ume: { price: "$0.2", targetTokens: 4_000 },
    take: { price: "$0.3", targetTokens: 9_000 },
    matsu: { price: "$0.4", targetTokens: 15_000 },
  },
};

const TARGET = {
  application: "app-1",
  environment: "env-1",
  profile: "profile-1",
};

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/** AppConfigData の偽クライアント。セッション開始と取得を順に返す */
function fakeClient(
  responses: Array<{
    Configuration?: Uint8Array;
    NextPollConfigurationToken?: string;
  }>,
) {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof StartConfigurationSessionCommand) {
      return { InitialConfigurationToken: "initial-token" };
    }
    if (command instanceof GetLatestConfigurationCommand) {
      const next = responses.shift();
      if (!next) throw new Error("応答の用意がありません");
      return { NextPollConfigurationToken: "next-token", ...next };
    }
    throw new Error("想定外のコマンドです");
  });
  return { send };
}

describe("createAppConfigDataReader", () => {
  it("セッションを開始してから最新の設定を取り、次回はトークンを引き継ぐ", async () => {
    const client = fakeClient([
      { Configuration: encode(VALID) },
      { Configuration: new Uint8Array() },
    ]);
    const read = createAppConfigDataReader({ client, target: TARGET });

    expect(await read()).toEqual(VALID);
    // 変更が無ければ本文は空で返る。読み手は「変わっていない」を undefined で伝える
    expect(await read()).toBeUndefined();

    const commands = client.send.mock.calls.map(([command]) => command);
    expect(commands[0]).toBeInstanceOf(StartConfigurationSessionCommand);
    expect((commands[0] as StartConfigurationSessionCommand).input).toEqual({
      ApplicationIdentifier: "app-1",
      EnvironmentIdentifier: "env-1",
      ConfigurationProfileIdentifier: "profile-1",
      RequiredMinimumPollIntervalInSeconds: 15,
    });
    expect((commands[1] as GetLatestConfigurationCommand).input).toEqual({
      ConfigurationToken: "initial-token",
    });
    expect((commands[2] as GetLatestConfigurationCommand).input).toEqual({
      ConfigurationToken: "next-token",
    });
  });

  // トークンは期限が切れる（24 時間）。取得に失敗したら次回はセッションを開き直す
  it("取得に失敗したら次回はセッションを開き直す", async () => {
    const client = fakeClient([]);
    client.send.mockRejectedValueOnce(new Error("BadRequestException"));
    const read = createAppConfigDataReader({ client, target: TARGET });

    await expect(read()).rejects.toThrow();
    client.send.mockClear();
    client.send.mockImplementationOnce(async () => ({
      InitialConfigurationToken: "initial-token",
    }));
    client.send.mockImplementationOnce(async () => ({
      Configuration: encode(VALID),
      NextPollConfigurationToken: "next-token",
    }));
    expect(await read()).toEqual(VALID);
    expect(client.send.mock.calls[0][0]).toBeInstanceOf(
      StartConfigurationSessionCommand,
    );
  });
});

describe("価格表の読み込み", () => {
  const options = { ttlMs: 1_000 };

  it("妥当な設定を読む", async () => {
    const load = createTierTableLoader({
      ...options,
      read: vi.fn().mockResolvedValue(VALID),
    });
    expect(priceOf(await load(), "take")).toBe("$0.3");
  });

  // 設定の書き損じで売り手が止まるより、既定の表で売り続けるほうが害が小さい
  it("設定が壊れていれば既定の表を使う", async () => {
    const load = createTierTableLoader({
      ...options,
      read: vi.fn().mockResolvedValue({ tiers: { ume: { price: "0.2" } } }),
    });
    expect(await load()).toEqual(DEFAULT_TIER_TABLE);
  });

  it("取得に失敗しても既定の表を使う", async () => {
    const load = createTierTableLoader({
      ...options,
      read: vi.fn().mockRejectedValue(new Error("unreachable")),
    });
    expect(await load()).toEqual(DEFAULT_TIER_TABLE);
  });

  it("有効期間のうちは取得し直さない", async () => {
    const read = vi.fn().mockResolvedValue(VALID);
    let now = 1_000;
    const load = createTierTableLoader({
      ...options,
      read,
      now: () => now,
    });
    await load();
    await load();
    now += 500;
    await load();
    expect(read).toHaveBeenCalledOnce();
  });

  it("有効期間を過ぎたら取得し直す", async () => {
    const read = vi.fn().mockResolvedValue(VALID);
    let now = 1_000;
    const load = createTierTableLoader({
      ...options,
      read,
      now: () => now,
    });
    await load();
    now += 1_001;
    await load();
    expect(read).toHaveBeenCalledTimes(2);
  });

  // 一度読めた表は、その後の取得が失敗しても使い続ける
  it("取得に失敗したら直前に読めた表を保つ", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(VALID)
      .mockRejectedValue(new Error("unreachable"));
    let now = 1_000;
    const load = createTierTableLoader({
      ...options,
      read,
      now: () => now,
    });
    expect(priceOf(await load(), "take")).toBe("$0.3");
    now += 1_001;
    expect(priceOf(await load(), "take")).toBe("$0.3");
  });

  // 1 つの実行環境が多数の依頼を同時にさばく。有効期間が切れた瞬間に依頼の数だけ取りに行かない
  it("有効期間が切れた直後の同時呼び出しは取得を 1 本にまとめる", async () => {
    let resolve: (value: unknown) => void = () => {};
    const read = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const load = createTierTableLoader({ ...options, read });
    const first = load();
    const second = load();
    expect(read).toHaveBeenCalledOnce();
    resolve(VALID);
    expect(priceOf(await first, "take")).toBe("$0.3");
    expect(priceOf(await second, "take")).toBe("$0.3");
  });

  // AppConfigData は変更が無ければ空を返す。それは失敗ではなく「いまの表のまま」
  it("変更なし（undefined）なら直前に読めた表を保つ", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(VALID)
      .mockResolvedValue(undefined);
    let now = 1_000;
    const load = createTierTableLoader({
      ...options,
      read,
      now: () => now,
    });
    expect(priceOf(await load(), "take")).toBe("$0.3");
    now += 1_001;
    expect(priceOf(await load(), "take")).toBe("$0.3");
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("tierTableLoaderFromEnv", () => {
  it("AppConfig の指定が揃っていなければ読み手を作らない（ローカルの通常経路）", () => {
    expect(tierTableLoaderFromEnv({})).toBeUndefined();
    expect(
      tierTableLoaderFromEnv({
        APPCONFIG_APPLICATION: "a",
        APPCONFIG_ENVIRONMENT: "e",
      }),
    ).toBeUndefined();
  });

  it("揃っていれば読み手を作る", () => {
    expect(
      tierTableLoaderFromEnv({
        APPCONFIG_APPLICATION: "a",
        APPCONFIG_ENVIRONMENT: "e",
        APPCONFIG_PROFILE: "p",
      }),
    ).toBeTypeOf("function");
  });
});
