/**
 * 判定を止める理由。
 * - unreadable: 画像判読不能（撮り直しが必要）
 * - review: 要確認（人が見る必要がある）
 */
export type IssueSeverity = "unreadable" | "review";

export interface Issue {
  code: string;
  severity: IssueSeverity;
  message: string;
}

export const unreadable = (code: string, message: string): Issue => ({ code, severity: "unreadable", message });
export const review = (code: string, message: string): Issue => ({ code, severity: "review", message });

export function worstSeverity(issues: readonly Issue[]): IssueSeverity | null {
  if (issues.some((i) => i.severity === "unreadable")) return "unreadable";
  if (issues.length > 0) return "review";
  return null;
}
