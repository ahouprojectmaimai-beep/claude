import type { DB } from "./db.ts";
import { hhmmToMin, isHHMM } from "./time.ts";

export type Settings = {
  timezone: string;
  durationMin: number;
  stepMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  weekdays: number[]; // 0=日..6=土
  dayStart: string; // 受付開始時刻（この時刻以降に開始）
  dayEnd: string; // 受付終了時刻（この時刻までに終了）
  horizonDays: number;
  allowSameDay: boolean;
  cutoffMin: number; // 開始の何分前まで受付
  officeName: string;
  officeAddress: string;
  visitLocationBy: "customer" | "admin";
  busyCalendarIds: string[]; // 空き判定に使う追加カレンダー
  targetCalendarId: string; // 予約の登録先
  googleInvite: boolean; // Googleカレンダーの招待通知を送る
  sendOwnMail: boolean; // 独自の確認メールを送る
  adminNotifyEmail: string;
  replyTo: string;
  maxFutureBookingsPerEmail: number;
  privacyText: string;
};

export const DEFAULT_SETTINGS: Settings = {
  timezone: "Asia/Tokyo",
  durationMin: 60,
  stepMin: 15,
  bufferBeforeMin: 0,
  bufferAfterMin: 0,
  weekdays: [1, 2, 3, 4, 5],
  dayStart: "10:00",
  dayEnd: "18:00",
  horizonDays: 30,
  allowSameDay: true,
  cutoffMin: 120,
  officeName: "TUMIKI事務所",
  officeAddress: "",
  visitLocationBy: "customer",
  busyCalendarIds: [],
  targetCalendarId: "primary",
  googleInvite: true,
  sendOwnMail: true,
  adminNotifyEmail: "",
  replyTo: "",
  maxFutureBookingsPerEmail: 3,
  privacyText:
    "ご入力いただいた情報は、お打ち合わせの日程調整・ご連絡および当日のご案内の目的にのみ利用し、ご本人の同意なく第三者へ提供しません。",
};

const int = (v: unknown, lo: number, hi: number, def: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
const str = (v: unknown, max: number, def: string) => (typeof v === "string" ? v.trim().slice(0, max) : def);
const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);

/** 任意の入力を検証・補正して Settings にする（管理画面の保存時と読み込み時に使用） */
export function normalizeSettings(input: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s: Settings = {
    timezone: str(i.timezone, 64, base.timezone) || base.timezone,
    durationMin: int(i.durationMin, 15, 480, base.durationMin),
    stepMin: int(i.stepMin, 5, 120, base.stepMin),
    bufferBeforeMin: int(i.bufferBeforeMin, 0, 240, base.bufferBeforeMin),
    bufferAfterMin: int(i.bufferAfterMin, 0, 240, base.bufferAfterMin),
    weekdays: Array.isArray(i.weekdays)
      ? [...new Set(i.weekdays.filter((n): n is number => Number.isInteger(n) && n >= 0 && n <= 6))].sort()
      : base.weekdays,
    dayStart: isHHMM(i.dayStart) ? i.dayStart : base.dayStart,
    dayEnd: isHHMM(i.dayEnd) ? i.dayEnd : base.dayEnd,
    horizonDays: int(i.horizonDays, 1, 90, base.horizonDays),
    allowSameDay: bool(i.allowSameDay, base.allowSameDay),
    cutoffMin: int(i.cutoffMin, 0, 60 * 24 * 14, base.cutoffMin),
    officeName: str(i.officeName, 100, base.officeName),
    officeAddress: str(i.officeAddress, 300, base.officeAddress),
    visitLocationBy: i.visitLocationBy === "admin" ? "admin" : i.visitLocationBy === "customer" ? "customer" : base.visitLocationBy,
    busyCalendarIds: Array.isArray(i.busyCalendarIds)
      ? [...new Set(i.busyCalendarIds.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 200))].slice(0, 20)
      : base.busyCalendarIds,
    targetCalendarId: str(i.targetCalendarId, 200, base.targetCalendarId) || "primary",
    googleInvite: bool(i.googleInvite, base.googleInvite),
    sendOwnMail: bool(i.sendOwnMail, base.sendOwnMail),
    adminNotifyEmail: str(i.adminNotifyEmail, 200, base.adminNotifyEmail),
    replyTo: str(i.replyTo, 200, base.replyTo),
    maxFutureBookingsPerEmail: int(i.maxFutureBookingsPerEmail, 1, 20, base.maxFutureBookingsPerEmail),
    privacyText: str(i.privacyText, 1000, base.privacyText) || base.privacyText,
  };
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: s.timezone });
  } catch {
    s.timezone = base.timezone;
  }
  if (hhmmToMin(s.dayEnd) - hhmmToMin(s.dayStart) < s.durationMin) {
    s.dayStart = base.dayStart;
    s.dayEnd = base.dayEnd;
  }
  return s;
}

export async function loadSettings(db: DB): Promise<Settings> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'main'").first<{ value: string }>();
  if (!row) return DEFAULT_SETTINGS;
  try {
    return normalizeSettings(JSON.parse(row.value));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(db: DB, s: Settings): Promise<void> {
  await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('main', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(JSON.stringify(s), Math.floor(Date.now() / 1000))
    .run();
}
