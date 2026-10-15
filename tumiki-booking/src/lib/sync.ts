// Googleカレンダー ⇄ 予約データの同期（通知 + 定期同期の併用、冪等）
import { blockOf } from "./availability.ts";
import { getBooking, type Deps } from "./booking.ts";
import { randomToken, timingSafeEqual } from "./crypto.ts";
import type { DB } from "./db.ts";
import { eventInterval, GoogleError, type CalendarApi } from "./google.ts";
import type { Settings } from "./settings.ts";

async function getState(db: DB, key: string): Promise<string | null> {
  return (await db.prepare("SELECT value FROM sync_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}
async function setState(db: DB, key: string, value: string | null) {
  if (value === null) { await db.prepare("DELETE FROM sync_state WHERE key = ?").bind(key).run(); return; }
  await db.prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at")
    .bind(key, value, Math.floor(Date.now() / 1000)).run();
}

export type SyncResult = { checked: number; cancelled: number; moved: number };

/** 差分を取得して予約へ反映。通知とcronが重なっても、値を比較してから更新するので安全 */
export async function syncCalendar(d: Deps, s: Settings): Promise<SyncResult> {
  const cal = s.targetCalendarId;
  const key = `sync_token:${cal}`;
  const now = d.now ? d.now() : Math.floor(Date.now() / 1000);
  const timeMin = new Date((now - 86400) * 1000).toISOString();
  let res = await d.cal.listChanges(cal, await getState(d.db, key), timeMin);
  if (res === "expired") {
    await setState(d.db, key, null);
    res = await d.cal.listChanges(cal, null, timeMin);
  }
  if (res === "expired") throw new GoogleError(410, "sync token could not be reset");
  const out: SyncResult = { checked: 0, cancelled: 0, moved: 0 };
  for (const ev of res.events) {
    const bookingId = ev.extendedProperties?.private?.tumikiBookingId ?? ev.id;
    const b = await getBooking(d.db, bookingId);
    if (!b || b.status !== "confirmed" || (b.event_id && b.event_id !== ev.id)) continue;
    out.checked++;
    if (ev.status === "cancelled") {
      const r = await d.db
        .prepare("UPDATE bookings SET status='cancelled', cancelled_by='calendar', updated_at=? WHERE id=? AND status='confirmed'")
        .bind(now, b.id).run();
      out.cancelled += r.meta.changes;
      continue;
    }
    const iv = eventInterval(ev, s.timezone);
    if (!iv || ev.start?.date) continue; // 終日予定に変えられた場合などは触らず、管理者の目視に任せる
    if (iv.start !== b.start_ts || iv.end !== b.end_ts) {
      const blk = blockOf(s, iv);
      const r = await d.db
        .prepare("UPDATE bookings SET start_ts=?, end_ts=?, block_start_ts=?, block_end_ts=?, externally_changed=1, updated_at=? WHERE id=? AND status='confirmed' AND (start_ts != ? OR end_ts != ?)")
        .bind(iv.start, iv.end, blk.start, blk.end, now, b.id, iv.start, iv.end).run();
      out.moved += r.meta.changes;
    }
  }
  await setState(d.db, key, res.nextSyncToken);
  return out;
}

// ---- 通知チャンネル(events.watch) -------------------------------------------------

type Watch = { id: string; resourceId: string; expiration: number; token: string; calendarId: string };
const DAY_MS = 86_400_000;

export async function ensureWatch(cal: CalendarApi, db: DB, s: Settings, baseUrl: string, nowMs = Date.now()): Promise<"skipped" | "ok" | "renewed"> {
  if (!baseUrl.startsWith("https://")) return "skipped"; // Googleの通知はHTTPS必須
  const cur = JSON.parse((await getState(db, "watch")) ?? "null") as Watch | null;
  if (cur && cur.calendarId === s.targetCalendarId && cur.expiration - nowMs > 2 * DAY_MS) return "ok";
  const next = { id: crypto.randomUUID(), token: randomToken(24) };
  const w = await cal.watch(s.targetCalendarId, { ...next, address: `${baseUrl}/api/google/webhook` });
  await setState(db, "watch", JSON.stringify({ ...next, resourceId: w.resourceId, expiration: w.expiration, calendarId: s.targetCalendarId } satisfies Watch));
  if (cur) { try { await cal.stopChannel(cur.id, cur.resourceId); } catch { /* 期限切れなら無視 */ } }
  return "renewed";
}

export async function stopWatch(cal: CalendarApi, db: DB) {
  const cur = JSON.parse((await getState(db, "watch")) ?? "null") as Watch | null;
  if (cur) { try { await cal.stopChannel(cur.id, cur.resourceId); } catch { /* ignore */ } }
  await setState(db, "watch", null);
}

export async function watchStatus(db: DB): Promise<{ active: boolean; expiration?: number }> {
  const cur = JSON.parse((await getState(db, "watch")) ?? "null") as Watch | null;
  return cur ? { active: cur.expiration > Date.now(), expiration: cur.expiration } : { active: false };
}

/** Webhookの正当性検証: チャンネルidとトークンが登録済みのものと一致すること */
export async function verifyWebhook(db: DB, channelId: string | null, token: string | null): Promise<boolean> {
  if (!channelId || !token) return false;
  const cur = JSON.parse((await getState(db, "watch")) ?? "null") as Watch | null;
  return !!cur && timingSafeEqual(cur.id, channelId) && timingSafeEqual(cur.token, token);
}

