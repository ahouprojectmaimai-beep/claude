// 日時ユーティリティ。内部はUTC秒、日付判定・表示は設定のタイムゾーン(既定 Asia/Tokyo)。
// Intl でゾーン換算するので、サマータイムのある地域にもそのまま使える。

export const MIN = 60;
export const DAY = 86400;

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

function partsInZone(ts: number, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ts * 1000))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year!, m: o.month!, d: o.day!, h: o.hour!, mi: o.minute!, s: o.second! };
}

/** ゾーンのUTCオフセット(秒)。ts時点のもの */
function offsetAt(ts: number, tz: string): number {
  const p = partsInZone(ts, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) / 1000 - ts;
}

/** 現地の日付+時刻 → UTC秒（存在しない時刻/重複時刻は前方に寄せる） */
export function zonedToTs(date: string, hhmm: string, tz: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, mi, 0) / 1000;
  let ts = guess - offsetAt(guess, tz);
  ts = guess - offsetAt(ts, tz);
  return ts;
}

export function tsToDate(ts: number, tz: string): string {
  const p = partsInZone(ts, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function tsToHHMM(ts: number, tz: string): string {
  const p = partsInZone(ts, tz);
  return `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

/** 0=日 ... 6=土 */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

export function isDateStr(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

export function isHHMM(s: unknown): s is string {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

export function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];

/** 「10月20日（火）13:30〜14:30」 */
export function formatRange(startTs: number, endTs: number, tz: string): string {
  const p = partsInZone(startTs, tz);
  const wd = WD[weekdayOf(tsToDate(startTs, tz))];
  return `${p.m}月${p.d}日（${wd}）${tsToHHMM(startTs, tz)}〜${tsToHHMM(endTs, tz)}`;
}

export function formatDateLong(startTs: number, tz: string): string {
  const p = partsInZone(startTs, tz);
  return `${p.y}年${p.m}月${p.d}日（${WD[weekdayOf(tsToDate(startTs, tz))]}）`;
}

export type Interval = { start: number; end: number };

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && a.end > b.start;
}
