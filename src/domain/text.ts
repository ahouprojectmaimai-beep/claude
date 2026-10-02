/** 全角数字・記号を半角へ、空白を除去 */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，、]/g, ",")
    .replace(/[．]/g, ".")
    .replace(/[－−ー‐―]/g, "-")
    .replace(/[／]/g, "/")
    .replace(/[〜～]/g, "~");
}

/**
 * 印字された金額文字列を整数へ。曖昧な文字列は null（推測しない）。
 * 許可: "65,320" "*65,000" "¥123,456" "300円" "-1,078"
 * 不許可: "65,32" "6S,320" "65.320" "" など
 */
export function parseAmount(text: string): number | null {
  let s = normalizeDigits(text).replace(/\s+/g, "");
  s = s.replace(/^[*＊¥￥\\]+/, "").replace(/円$/, "");
  let sign = 1;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1).replace(/^[*＊¥￥\\]+/, "");
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)$/.test(s)) return null;
  if (/^0\d/.test(s.replace(/,/g, ""))) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isSafeInteger(n) ? sign * n : null;
}

/**
 * 印字された日付文字列から [年, 月, 日] の数字列を取り出す。
 * 例: "08.09.24" "08-09-29" "2026/9/28 (月)" "26年 9月 22日"
 * 数字のかたまりがちょうど3つでなければ null。
 */
export function splitDateParts(text: string): [string, string, string] | null {
  const parts = normalizeDigits(text).match(/\d+/g);
  if (!parts || parts.length !== 3) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}
