import type { AppConfig } from "../config/config";
import { ClaudeExtractor } from "./claudeExtractor";
import type { Extractor } from "./extractor";

/** 設定ファイルの extraction.passes から抽出器を作る */
export function extractorsFromConfig(cfg: AppConfig): Extractor[] {
  return cfg.extraction.passes.map((p) => new ClaudeExtractor({ model: p.model, variant: p.variant, effort: p.effort }));
}
