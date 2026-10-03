/**
 * 画像読み取りに使えるClaudeモデルと料金（USD / 100万トークン）。
 * 料金は 2026-09 時点の公開価格。変わったらここを更新する。
 */
export interface ModelProfile {
  id: string;
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
  /** output_config.effort を受け付けるか（Haiku 4.5 は不可） */
  supportsEffort: boolean;
  /** 安全分類器の拒否時の server-side fallback（"default"）に対応するか */
  supportsDefaultFallback: boolean;
}

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5（最安）",
    inputPerMTok: 1,
    outputPerMTok: 5,
    supportsEffort: false,
    supportsDefaultFallback: false,
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5（中）",
    inputPerMTok: 2,
    outputPerMTok: 10,
    supportsEffort: true,
    supportsDefaultFallback: true,
  },
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    label: "Opus 5.5（高精度）",
    inputPerMTok: 4,
    outputPerMTok: 20,
    supportsEffort: true,
    supportsDefaultFallback: true,
  },
};

export function modelProfile(model: string): ModelProfile {
  const p = MODEL_PROFILES[model];
  if (!p) throw new Error(`未登録のモデル: ${model}（src/extraction/models.ts に追加してください）`);
  return p;
}

export function costUSD(model: string, inputTokens: number, outputTokens: number): number {
  const p = modelProfile(model);
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000;
}
