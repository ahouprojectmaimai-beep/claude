import type { YearFormat } from "../config/config";

/** "YYYY-MM-DD" 形式の日付（タイムゾーンを持たない暦日） */
export type ISODate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidISODate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function toISODate(y: number, m: number, d: number): ISODate | null {
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isValidISODate(s) ? s : null;
}

function toUTC(d: ISODate): Date {
  if (!isValidISODate(d)) throw new Error(`不正な日付: ${d}`);
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day));
}

export function addDays(d: ISODate, n: number): ISODate {
  const dt = toUTC(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(a).getTime() - toUTC(b).getTime()) / 86_400_000);
}

/** 曜日（0=日〜6=土） */
export function dayOfWeek(d: ISODate): number {
  return toUTC(d).getUTCDay();
}

/** 日本時間（JST）での今日の日付 */
export function todayJST(now: Date = new Date()): ISODate {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** 書類に印字された年の数字を西暦に変換する。書類ごとの表記は設定で決め、推測しない。 */
export function resolveYear(yearText: string, format: YearFormat): number | null {
  if (!/^\d+$/.test(yearText)) return null;
  const n = Number(yearText);
  switch (format) {
    case "reiwa2":
      return yearText.length <= 2 && n >= 1 ? 2018 + n : null;
    case "western2":
      return yearText.length === 2 ? 2000 + n : null;
    case "western4":
      return yearText.length === 4 ? n : null;
  }
}

/** 銀行営業日カレンダー（土日＋設定ファイルの休業日） */
export class BankCalendar {
  private readonly holidays: Set<ISODate>;

  constructor(holidayDates: readonly ISODate[]) {
    for (const d of holidayDates) {
      if (!isValidISODate(d)) throw new Error(`休業日データが不正: ${d}`);
    }
    this.holidays = new Set(holidayDates);
  }

  isBankBusinessDay(d: ISODate): boolean {
    const w = dayOfWeek(d);
    return w !== 0 && w !== 6 && !this.holidays.has(d);
  }

  /** d より後の最初の銀行営業日 */
  nextBankBusinessDayAfter(d: ISODate): ISODate {
    let x = addDays(d, 1);
    while (!this.isBankBusinessDay(x)) x = addDays(x, 1);
    return x;
  }

  /** d 当日を含む、最初の銀行営業日 */
  firstBankBusinessDayOnOrAfter(d: ISODate): ISODate {
    return this.isBankBusinessDay(d) ? d : this.nextBankBusinessDayAfter(d);
  }

  /** d から n 銀行営業日後 */
  addBankBusinessDays(d: ISODate, n: number): ISODate {
    let x = d;
    for (let i = 0; i < n; i++) x = this.nextBankBusinessDayAfter(x);
    return x;
  }
}
