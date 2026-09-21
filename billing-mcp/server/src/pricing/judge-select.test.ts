import { describe, expect, it, vi } from "vitest";
import type { Judge } from "./judge.js";
import { createJudgeSelector } from "./judge-select.js";

const bedrock: Judge = async () => ({ tier: "ume" });
const systemOne: Judge = async () => ({ tier: "matsu" });

describe("判定器の選択（決定58）", () => {
  it("bedrock を指せば既定の判定器を返す", async () => {
    const loadApiKey = vi.fn();
    const select = createJudgeSelector({ bedrock, loadApiKey });
    expect(
      await (await select("bedrock"))({ toolName: "t", state: "s" }),
    ).toEqual({ tier: "ume" });
    // 使わない鍵を取りに行かない
    expect(loadApiKey).not.toHaveBeenCalled();
  });

  it("systemone を指し、鍵があれば System One を使う", async () => {
    const create = vi.fn().mockReturnValue(systemOne);
    const select = createJudgeSelector({
      bedrock,
      loadApiKey: async () => "k",
      createSystemOne: create,
    });
    const judge = await select("systemone");
    expect(await judge({ toolName: "t", state: "s" })).toEqual({
      tier: "matsu",
    });
    expect(create).toHaveBeenCalledWith("k");
  });

  // CDK が作るのは空の Secret なので、鍵を入れ忘れたまま倒す事故は実際に起きる
  it("systemone を指しても鍵が無ければ既定の判定器に留まり、警告を出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const select = createJudgeSelector({
      bedrock,
      loadApiKey: async () => undefined,
      createSystemOne: () => systemOne,
    });
    expect(
      await (await select("systemone"))({ toolName: "t", state: "s" }),
    ).toEqual({ tier: "ume" });
    expect(warn.mock.calls.flat().join(" ")).toContain("既定");
    warn.mockRestore();
  });

  // リクエストごとにクライアントを作り直すと、接続プールが毎回捨てられる
  it("鍵が同じなら System One の判定器を作り直さない", async () => {
    const create = vi.fn().mockReturnValue(systemOne);
    const select = createJudgeSelector({
      bedrock,
      loadApiKey: async () => "k",
      createSystemOne: create,
    });
    await select("systemone");
    await select("systemone");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
