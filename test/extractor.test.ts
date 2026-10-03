import { describe, expect, it } from "vitest";
import { ClaudeExtractor } from "../src/extraction/claudeExtractor";
import { costUSD } from "../src/extraction/models";
import { extractorsFromConfig } from "../src/extraction/fromConfig";
import { loadDefaultConfig } from "../src/config/load";

const req = { imageBase64: "AAAA", mediaType: "image/jpeg" as const, receiptLabels: null };
const fakeClient = {} as any;

describe("モデルごとのAPIパラメータ", () => {
  it("Haiku 4.5 には effort・fallback を付けない（非対応）", () => {
    const p = new ClaudeExtractor({ client: fakeClient, model: "claude-haiku-4-5", variant: "A", effort: "low" }).buildParams(req) as any;
    expect(p.model).toBe("claude-haiku-4-5");
    expect(p.output_config.effort).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toBeUndefined();
  });
  it("Sonnet 5.5 は effort と fallback を付ける", () => {
    const p = new ClaudeExtractor({ client: fakeClient, model: "claude-sonnet-5-5", variant: "B", effort: "low" }).buildParams(req) as any;
    expect(p.output_config.effort).toBe("low");
    expect(p.fallbacks).toBe("default");
  });
  it("未登録のモデルは起動時にエラー", () => {
    expect(() => new ClaudeExtractor({ client: fakeClient, model: "unknown-model", variant: "A" })).toThrow(/未登録のモデル/);
  });
  it("料金計算", () => {
    expect(costUSD("claude-haiku-4-5", 1_000_000, 1_000_000)).toBe(6);
    expect(costUSD("claude-sonnet-5-5", 3000, 4000)).toBeCloseTo(0.046);
  });
  it("本番設定は異なる2つの読み取り系統を持つ", () => {
    const ex = extractorsFromConfig(loadDefaultConfig());
    expect(ex.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ex.map((e) => e.id)).size).toBe(ex.length);
  });
});
