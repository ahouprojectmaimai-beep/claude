// 予約サービス本体: 空き取得 / 確定 / 変更 / キャンセル
import { dateRangeToTs, blockOf, isSlotAvailable, rangeSlots, slotInterval } from "./availability.ts";
import { newBookingId, randomToken, sha256Hex, timingSafeEqual } from "./crypto.ts";
import type { DB } from "./db.ts";
import { GoogleError, meetUrlOf, type CalendarApi, type GEvent } from "./google.ts";
import { buildMail, sendAndLog, type MailBooking, type MailKind, type Mailer } from "./mail.ts";
import { allow } from "./ratelimit.ts";
import type { Settings } from "./settings.ts";
import { addDays, isDateStr, isHHMM, MIN, overlaps, tsToDate, tsToHHMM, type Interval } from "./time.ts";

export type Mode = "online" | "office" | "visit";
export type Status = "pending" | "confirmed" | "cancelled" | "failed";

export type Booking = MailBooking & {
  status: Status; block_start_ts: number; block_end_ts: number; event_id: string; calendar_id: string;
  manage_token_hash: string; cancelled_by: string; externally_changed: number; fail_reason: string;
  created_at: number; updated_at: number;
};

export type Deps = {
  db: DB;
  cal: CalendarApi;
  mailer: Mailer | null;
  baseUrl: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class BookingError extends Error {
  constructor(public code: "invalid" | "unavailable" | "not_found" | "rate_limited" | "google" | "forbidden", message: string, public fields?: string[]) {
    super(message);
  }
}

const nowOf = (d: Deps) => (d.now ? d.now() : Math.floor(Date.now() / 1000));
const PENDING_TTL = 5 * MIN;

// ---- 入力検証 ---------------------------------------------------------------

export type BookingInput = {
  mode: Mode; date: string; time: string; name: string; email: string; company?: string; note?: string;
  locationName?: string; locationAddress?: string; website?: string; // website はハニーポット
};

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

export function validateInput(raw: unknown, s: Settings) {
  const i = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const errors: string[] = [];
  const mode = i.mode as Mode;
  if (!["online", "office", "visit"].includes(mode)) errors.push("mode");
  if (!isDateStr(i.date)) errors.push("date");
  if (!isHHMM(i.time)) errors.push("time");
  const name = clean(i.name, 80);
  if (!name) errors.push("name");
  const email = clean(i.email, 200).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 200) errors.push("email");
  const note = typeof i.note === "string" ? i.note.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 1000) : "";
  const company = clean(i.company, 100);
  let location_name = "", location_address = "", location_source: "" | "office" | "customer" | "admin" = "", unconfirmed = 0;
  if (mode === "office") {
    location_name = s.officeName; location_address = s.officeAddress; location_source = "office";
  } else if (mode === "visit") {
    if (s.visitLocationBy === "customer") {
      location_name = clean(i.locationName, 100);
      location_address = clean(i.locationAddress, 300);
      if (!location_name && !location_address) errors.push("locationName");
      location_source = "customer";
      unconfirmed = location_address ? 0 : 1; // 店舗名だけなら住所未確認として管理者に見せる
    } else {
      location_source = "admin"; unconfirmed = 1; // 管理者が後から場所を指定
    }
  }
  if (errors.length) throw new BookingError("invalid", "入力内容をご確認ください", errors);
  return { mode, date: i.date as string, time: i.time as string, name, email, company, note, location_name, location_address, location_source, unconfirmed };
}

// ---- 空き時間 ---------------------------------------------------------------

async function holdsIn(db: DB, range: Interval, now: number, excludeId = ""): Promise<Interval[]> {
  const { results } = await db
    .prepare(
      "SELECT block_start_ts AS start, block_end_ts AS end FROM bookings WHERE id != ? AND block_start_ts < ? AND block_end_ts > ? AND (status = 'confirmed' OR (status = 'pending' AND created_at > ?))",
    )
    .bind(excludeId, range.end, range.start, now - PENDING_TTL)
    .all<Interval>();
  return results;
}

async function busyIn(d: Deps, s: Settings, range: Interval, excludeEventId?: string): Promise<Interval[]> {
  const others = s.busyCalendarIds.filter((c) => c !== s.targetCalendarId && !(c === "primary" && s.targetCalendarId.includes("@")));
  const [own, extra] = await Promise.all([
    d.cal.busyFromEvents(s.targetCalendarId, range, s.timezone, excludeEventId),
    d.cal.busyFromFreeBusy(others, range),
  ]);
  return [...own, ...extra];
}

/** 期間内の予約可能な日時（お客様には既存予定の内容を一切返さない） */
export async function getAvailability(d: Deps, s: Settings, from: string, to: string, excludeBookingId = "") {
  const now = nowOf(d);
  if (!isDateStr(from) || !isDateStr(to) || to < from) throw new BookingError("invalid", "期間が正しくありません");
  if (to > addDays(from, 62)) to = addDays(from, 62);
  const range = dateRangeToTs(s, addDays(from, -1), addDays(to, 1));
  let eventId: string | undefined;
  if (excludeBookingId) eventId = (await getBooking(d.db, excludeBookingId))?.event_id || undefined;
  const [busy, holds] = await Promise.all([busyIn(d, s, range, eventId), holdsIn(d.db, range, now, excludeBookingId)]);
  return rangeSlots(s, from, to, busy, holds, now);
}

async function assertSlotFree(d: Deps, s: Settings, date: string, time: string, excludeBookingId = "", excludeEventId?: string) {
  const now = nowOf(d);
  const range = dateRangeToTs(s, addDays(date, -1), addDays(date, 1));
  const [busy, holds] = await Promise.all([busyIn(d, s, range, excludeEventId), holdsIn(d.db, range, now, excludeBookingId)]);
  if (!isSlotAvailable(s, date, time, busy, holds, now)) {
    throw new BookingError("unavailable", "申し訳ありません、この日時は埋まってしまいました。別の日時をお選びください。");
  }
}

/** 作成後の競合検出: 自分以外の「予定あり」が占有範囲と重なっていないか */
async function hasExternalConflict(d: Deps, s: Settings, block: Interval, ownEventId: string): Promise<boolean> {
  const busy = await busyIn(d, s, block, ownEventId);
  return busy.some((b) => overlaps(b, block));
}

// ---- DB ヘルパ ---------------------------------------------------------------

export async function getBooking(db: DB, id: string): Promise<Booking | null> {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return db.prepare("SELECT * FROM bookings WHERE id = ?").bind(id).first<Booking>();
}

export async function getBookingByToken(db: DB, id: string, token: string): Promise<Booking | null> {
  const b = await getBooking(db, id);
  if (!b || !token) return null;
  const hash = await sha256Hex(token);
  return timingSafeEqual(hash, b.manage_token_hash) ? b : null;
}

export const manageUrl = (baseUrl: string, id: string, token: string) => `${baseUrl}/manage?b=${id}&t=${token}`;

async function setFailed(db: DB, id: string, reason: string, now: number) {
  await db.prepare("UPDATE bookings SET status = 'failed', fail_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(reason.slice(0, 300), now, id).run();
}

// ---- Googleイベント -----------------------------------------------------------

export function eventTitle(b: Pick<MailBooking, "company" | "name">): string {
  const who = b.company ? b.company.replace(/様$/, "") : b.name.replace(/様$/, "");
  return `【TUMIKI】${who}様 お打ち合わせ`;
}

function eventLocation(b: MailBooking, s: Settings): string {
  if (b.mode === "office") return [s.officeName, s.officeAddress].filter(Boolean).join(" ");
  if (b.mode === "visit") return [b.location_name, b.location_address].filter(Boolean).join(" ");
  return "";
}

function eventBody(b: MailBooking, s: Settings, baseUrl: string, token: string | null) {
  const desc = [
    `お客様: ${b.name}${b.company ? `（${b.company}）` : ""}`,
    `メール: ${b.email}`,
    `開催方法: ${{ online: "オンライン（Google Meet）", office: "対面（事務所）", visit: "対面（店舗・指定場所）" }[b.mode]}`,
    b.mode === "visit" && (b.address_unconfirmed || !b.location_address) ? "※訪問先の住所は未確認です" : "",
    b.note ? `ご相談内容: ${b.note}` : "",
    token ? `予約の確認・変更・キャンセル: ${manageUrl(baseUrl, b.id, token)}` : "",
    `予約管理ID: ${b.id}`,
  ].filter(Boolean).join("\n");
  return {
    id: b.id, // 予約IDから決定的に生成 → 再実行しても重複しない
    summary: eventTitle(b),
    description: desc,
    location: eventLocation(b, s) || undefined,
    start: { dateTime: new Date(b.start_ts * 1000).toISOString(), timeZone: s.timezone },
    end: { dateTime: new Date(b.end_ts * 1000).toISOString(), timeZone: s.timezone },
    transparency: "opaque",
    attendees: s.googleInvite ? [{ email: b.email, displayName: b.name }] : [],
    guestsCanModify: false,
    extendedProperties: { private: { tumikiBookingId: b.id } },
  };
}

// ---- 予約確定 ------------------------------------------------------------------

export async function createBooking(d: Deps, s: Settings, raw: unknown, ip = "unknown") {
  const now = nowOf(d);
  const input = validateInput(raw, s);
  // ハニーポット: ボットは黙って成功したように見せる（保存しない）
  if (raw && typeof raw === "object" && (raw as BookingInput).website) {
    return { id: "0".repeat(32), startTs: 0, endTs: 0, token: "", fake: true as const };
  }
  if (!(await allow(d.db, `book:ip:${ip}`, 3600, 10, now)) || !(await allow(d.db, `book:mail:${input.email}`, 86400, 5, now))) {
    throw new BookingError("rate_limited", "短時間にたくさんの操作がありました。しばらくしてからお試しください。");
  }
  const future = await d.db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE email = ? AND status = 'confirmed' AND start_ts > ?")
    .bind(input.email, now)
    .first<{ n: number }>();
  if ((future?.n ?? 0) >= s.maxFutureBookingsPerEmail) {
    throw new BookingError("rate_limited", "このメールアドレスでは、すでに複数のご予約があります。変更・キャンセルは確認メールのリンクからお願いします。");
  }

  // 1) 設定条件 + Google空き + 既存予約 を確認
  await assertSlotFree(d, s, input.date, input.time);

  // 2) DB側で原子的に仮押さえ（重なれば0件 → 失敗）
  const iv = slotInterval(s, input.date, input.time);
  const block = blockOf(s, iv);
  const id = newBookingId();
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const held = await d.db
    .prepare(
      `INSERT INTO bookings (id,status,start_ts,end_ts,block_start_ts,block_end_ts,mode,name,email,company,note,location_name,location_address,location_source,address_unconfirmed,calendar_id,manage_token_hash,created_at,updated_at)
       SELECT ?,'pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
       WHERE NOT EXISTS (
         SELECT 1 FROM bookings WHERE block_start_ts < ? AND block_end_ts > ?
           AND (status = 'confirmed' OR (status = 'pending' AND created_at > ?)))`,
    )
    .bind(
      id, iv.start, iv.end, block.start, block.end, input.mode, input.name, input.email, input.company, input.note,
      input.location_name, input.location_address, input.location_source, input.unconfirmed, s.targetCalendarId, hash, now, now,
      block.end, block.start, now - PENDING_TTL,
    )
    .run();
  if (held.meta.changes !== 1) {
    throw new BookingError("unavailable", "申し訳ありません、この日時は埋まってしまいました。別の日時をお選びください。");
  }

  const b = (await getBooking(d.db, id))!;
  let created = false;
  try {
    // 3) 仮押さえ後にGoogle側を再確認（直前に入った外部予定を検出）
    if (await hasExternalConflict(d, s, block, id)) {
      throw new BookingError("unavailable", "申し訳ありません、この日時は埋まってしまいました。別の日時をお選びください。");
    }
    // 4) イベント作成（オンラインのみMeet発行）
    const body = eventBody(b, s, d.baseUrl, token) as Record<string, unknown>;
    if (b.mode === "online") {
      body.conferenceData = { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } };
    }
    created = true;
    let ev = await d.cal.insertEvent(s.targetCalendarId, body, { meet: b.mode === "online", sendUpdates: s.googleInvite ? "all" : "none" });
    let meet = "";
    if (b.mode === "online") {
      meet = meetUrlOf(ev);
      for (let n = 0; !meet && n < 4; n++) {
        await (d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(700);
        const got = await d.cal.getEvent(s.targetCalendarId, id);
        if (got) { ev = got; meet = meetUrlOf(got); }
      }
      if (!meet) throw new Error("Google Meetのリンクを発行できませんでした");
    }
    // 5) 作成直後の競合検出（他の予定と重なれば取り消す）
    if (await hasExternalConflict(d, s, block, id)) {
      throw new BookingError("unavailable", "申し訳ありません、この日時は埋まってしまいました。別の日時をお選びください。");
    }
    // 6) 確定
    const upd = await d.db
      .prepare("UPDATE bookings SET status='confirmed', event_id=?, meet_url=?, updated_at=? WHERE id=? AND status='pending'")
      .bind(ev.id, meet, nowOf(d), id)
      .run();
    if (upd.meta.changes !== 1) throw new Error("仮押さえが失効しました");
  } catch (e) {
    // 失敗: イベントを残さない・予約だけ残さない
    if (created) {
      try { await d.cal.deleteEvent(s.targetCalendarId, id, { sendUpdates: "none" }); } catch { /* cronが後始末 */ }
    }
    await setFailed(d.db, id, String((e as Error).message ?? e), nowOf(d));
    if (e instanceof BookingError) throw e;
    throw new BookingError("google", "予約を確定できませんでした。時間をおいてもう一度お試しください。");
  }

  const final = (await getBooking(d.db, id))!;
  await notify(d, s, "confirmed", final, token);
  return { id, token, startTs: final.start_ts, endTs: final.end_ts, booking: publicView(final, s), fake: false as const };
}

/** 通知: お客様への確認メール + 管理者への通知。失敗は履歴に残し予約は維持 */
async function notify(d: Deps, s: Settings, kind: "confirmed" | "changed" | "cancelled", b: Booking, token: string | null) {
  if (s.sendOwnMail) {
    const msg = buildMail(kind, b, s, { manageUrl: token ? manageUrl(d.baseUrl, b.id, token) : undefined, baseUrl: d.baseUrl });
    await sendAndLog(d.db, d.mailer, b.id, kind, msg);
  }
  if (s.adminNotifyEmail && kind !== "changed") {
    const ak: MailKind = kind === "confirmed" ? "admin_new" : "admin_cancelled";
    await sendAndLog(d.db, d.mailer, b.id, ak, buildMail(ak, b, s, { baseUrl: d.baseUrl, to: s.adminNotifyEmail }));
  }
}

/** お客様に返す予約情報（管理用の項目は含めない） */
export function publicView(b: Booking, s: Settings) {
  return {
    id: b.id, status: b.status, mode: b.mode, name: b.name, company: b.company, email: b.email, note: b.note,
    date: tsToDate(b.start_ts, s.timezone), time: tsToHHMM(b.start_ts, s.timezone), endTime: tsToHHMM(b.end_ts, s.timezone),
    startTs: b.start_ts, endTs: b.end_ts, meetUrl: b.meet_url,
    locationName: b.mode === "office" ? s.officeName : b.location_name,
    locationAddress: b.mode === "office" ? s.officeAddress : b.location_address,
    addressUnconfirmed: !!b.address_unconfirmed && b.mode === "visit",
  };
}

// ---- 変更 ------------------------------------------------------------------------

export async function rescheduleBooking(d: Deps, s: Settings, id: string, date: string, time: string, by: "customer" | "admin", token: string | null = null) {
  const b = await getBooking(d.db, id);
  if (!b || b.status !== "confirmed") throw new BookingError("not_found", "予約が見つかりません");
  if (!isDateStr(date) || !isHHMM(time)) throw new BookingError("invalid", "日時が正しくありません");
  if (by === "customer" && b.start_ts - nowOf(d) < s.cutoffMin * MIN) {
    throw new BookingError("forbidden", "開始時刻が近いため、オンラインでの変更はできません。お手数ですが直接ご連絡ください。");
  }
  await assertSlotFree(d, s, date, time, id, b.event_id || undefined);

  const iv = slotInterval(s, date, time);
  const blk = blockOf(s, iv);
  const now = nowOf(d);
  const moved = await d.db
    .prepare(
      `UPDATE bookings SET start_ts=?, end_ts=?, block_start_ts=?, block_end_ts=?, externally_changed=0, updated_at=?
       WHERE id=? AND status='confirmed' AND NOT EXISTS (
         SELECT 1 FROM bookings o WHERE o.id != ? AND o.block_start_ts < ? AND o.block_end_ts > ?
           AND (o.status='confirmed' OR (o.status='pending' AND o.created_at > ?)))`,
    )
    .bind(iv.start, iv.end, blk.start, blk.end, now, id, id, blk.end, blk.start, now - PENDING_TTL)
    .run();
  if (moved.meta.changes !== 1) throw new BookingError("unavailable", "申し訳ありません、この日時は埋まってしまいました。別の日時をお選びください。");

  const revert = () =>
    d.db.prepare("UPDATE bookings SET start_ts=?, end_ts=?, block_start_ts=?, block_end_ts=?, updated_at=? WHERE id=?")
      .bind(b.start_ts, b.end_ts, b.block_start_ts, b.block_end_ts, nowOf(d), id).run();
  const patch = {
    start: { dateTime: new Date(iv.start * 1000).toISOString(), timeZone: s.timezone },
    end: { dateTime: new Date(iv.end * 1000).toISOString(), timeZone: s.timezone },
  };
  try {
    await d.cal.patchEvent(b.calendar_id || s.targetCalendarId, b.event_id, patch, { sendUpdates: s.googleInvite ? "all" : "none" });
    if (await hasExternalConflict(d, s, blk, b.event_id)) {
      await d.cal.patchEvent(b.calendar_id || s.targetCalendarId, b.event_id, {
        start: { dateTime: new Date(b.start_ts * 1000).toISOString(), timeZone: s.timezone },
        end: { dateTime: new Date(b.end_ts * 1000).toISOString(), timeZone: s.timezone },
      }, { sendUpdates: "none" });
      throw new BookingError("unavailable", "申し訳ありません、この日時は埋まってしまいました。別の日時をお選びください。");
    }
  } catch (e) {
    await revert();
    if (e instanceof BookingError) throw e;
    throw new BookingError("google", "日時を変更できませんでした。時間をおいてもう一度お試しください。");
  }
  const after = (await getBooking(d.db, id))!;
  await notify(d, s, "changed", after, token);
  return publicView(after, s);
}

// ---- キャンセル -----------------------------------------------------------------

export async function cancelBooking(d: Deps, s: Settings, id: string, by: "customer" | "admin", token: string | null = null) {
  const b = await getBooking(d.db, id);
  if (!b || b.status !== "confirmed") throw new BookingError("not_found", "予約が見つかりません");
  const now = nowOf(d);
  // DBを先に更新（同期処理が先に「カレンダーで削除された」と誤認しないように）
  const r = await d.db
    .prepare("UPDATE bookings SET status='cancelled', cancelled_by=?, updated_at=? WHERE id=? AND status='confirmed'")
    .bind(by, now, id).run();
  if (r.meta.changes !== 1) throw new BookingError("not_found", "予約が見つかりません");
  try {
    if (b.event_id) await d.cal.deleteEvent(b.calendar_id || s.targetCalendarId, b.event_id, { sendUpdates: s.googleInvite ? "all" : "none" });
  } catch (e) {
    await d.db.prepare("UPDATE bookings SET status='confirmed', cancelled_by='', updated_at=? WHERE id=?").bind(nowOf(d), id).run();
    throw new BookingError("google", "キャンセルできませんでした。時間をおいてもう一度お試しください。");
  }
  const after = (await getBooking(d.db, id))!;
  await notify(d, s, "cancelled", after, token);
  return publicView(after, s);
}

// ---- 管理者による場所・お客様情報の更新 --------------------------------------------

export async function adminUpdateDetails(d: Deps, s: Settings, id: string, patch: { locationName?: string; locationAddress?: string; note?: string }) {
  const b = await getBooking(d.db, id);
  if (!b || b.status !== "confirmed") throw new BookingError("not_found", "予約が見つかりません");
  const name = patch.locationName !== undefined ? clean(patch.locationName, 100) : b.location_name;
  const addr = patch.locationAddress !== undefined ? clean(patch.locationAddress, 300) : b.location_address;
  const unconfirmed = b.mode === "visit" && !addr ? 1 : 0;
  await d.db
    .prepare("UPDATE bookings SET location_name=?, location_address=?, address_unconfirmed=?, location_source=CASE WHEN mode='visit' THEN 'admin' ELSE location_source END, updated_at=? WHERE id=?")
    .bind(name, addr, unconfirmed, nowOf(d), id).run();
  const after = (await getBooking(d.db, id))!;
  if (b.event_id) {
    try {
      await d.cal.patchEvent(b.calendar_id || s.targetCalendarId, b.event_id, { location: eventLocation(after, s) || null }, { sendUpdates: s.googleInvite ? "all" : "none" });
    } catch {
      throw new BookingError("google", "保存しましたが、Googleカレンダーへの反映に失敗しました");
    }
  }
  return after;
}

/** 管理者による再通知。新しい管理リンクを発行する（トークンはDBにハッシュしか無いため） */
export async function resendConfirmation(d: Deps, s: Settings, id: string) {
  const b = await getBooking(d.db, id);
  if (!b || b.status !== "confirmed") throw new BookingError("not_found", "予約が見つかりません");
  const token = randomToken(32);
  await d.db.prepare("UPDATE bookings SET manage_token_hash=?, updated_at=? WHERE id=?").bind(await sha256Hex(token), nowOf(d), id).run();
  const msg = buildMail("confirmed", b, s, { manageUrl: manageUrl(d.baseUrl, id, token), baseUrl: d.baseUrl });
  return sendAndLog(d.db, d.mailer, id, "confirmed", msg);
}

// ---- 期限切れ仮押さえの後始末 (cron) ------------------------------------------------

export async function cleanupPending(d: Deps, s: Settings): Promise<number> {
  const now = nowOf(d);
  const { results } = await d.db
    .prepare("SELECT id, calendar_id FROM bookings WHERE status='pending' AND created_at <= ?")
    .bind(now - PENDING_TTL).all<{ id: string; calendar_id: string }>();
  for (const p of results) {
    try {
      const ev = await d.cal.getEvent(p.calendar_id || s.targetCalendarId, p.id);
      if (ev && ev.status !== "cancelled") await d.cal.deleteEvent(p.calendar_id || s.targetCalendarId, p.id, { sendUpdates: "none" });
    } catch (e) {
      if (e instanceof GoogleError) continue; // 次回再試行
    }
    await setFailed(d.db, p.id, "timeout", now);
  }
  return results.length;
}

export type { GEvent };
