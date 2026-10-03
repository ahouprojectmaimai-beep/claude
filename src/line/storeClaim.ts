import type { AppConfig } from "../config/config";
import { normalizeLabel } from "../domain/text";

/**
 * 投稿テキストに含まれる店舗名を探す（「白梅町」「京大前店です」など）。
 * 複数の店舗名が入っていたら、どの写真の店か決められないので ambiguous。
 */
export function detectStoreClaim(text: string, cfg: AppConfig): { kind: "none" } | { kind: "store"; storeId: string } | { kind: "ambiguous"; storeIds: string[] } {
  const t = normalizeLabel(text);
  const hits = cfg.stores.filter((s) => [s.name, ...s.aliases].some((a) => t.includes(normalizeLabel(a)))).map((s) => s.id);
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "store", storeId: hits[0]! };
  return { kind: "ambiguous", storeIds: hits };
}

export function isCashCheckText(text: string): boolean {
  return normalizeLabel(text).includes("現金チェック");
}
