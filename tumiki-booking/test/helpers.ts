import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Deps } from "../src/lib/booking.ts";
import type { DB } from "../src/lib/db.ts";
import { eventBlocks, eventInterval, GoogleError, meetUrlOf, type CalendarApi, type GEvent } from "../src/lib/google.ts";
import type { Mailer, MailMessage } from "../src/lib/mail.ts";
import { DEFAULT_SETTINGS, saveSettings, type Settings } from "../src/lib/settings.ts";
import { zonedToTs, type Interval } from "../src/lib/time.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** D1 互換の最小アダプタ（node:sqlite） */
export function memDb(): DB {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  const mk = (sql: string, params: unknown[] = []): ReturnType<DB["prepare"]> => ({
    bind: (...v: unknown[]) => mk(sql, v),
    first: async <T>() => ((sqlite.prepare(sql).get(...(params as never[])) as T | undefined) ?? null),
    all: async <T>() => ({ results: sqlite.prepare(sql).all(...(params as never[])) as T[] }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) } }),
  });
  return { prepare: (sql) => mk(sql) };
}

/** Googleカレンダーの代役（メモリ上）。外部予定の追加や障害の注入ができる */
export class FakeCalendar implements CalendarApi {
  events = new Map<string, GEvent>();
  freeBusyBusy: Interval[] = [];
  failInsert = false;
  failMeet = false;
  insertCalls = 0;
  deleted: string[] = [];
  changeLog: GEvent[] = [];
  syncToken = 1;
  /** insert 直後に別の誰かが予定を入れた状況を作る */
  onAfterInsert: (() => void) | null = null;

  addExternal(id: string, startIso: string, endIso: string, extra: Partial<GEvent> = {}) {
    const ev: GEvent = { id, status: "confirmed", start: { dateTime: startIso }, end: { dateTime: endIso }, ...extra };
    this.events.set(id, ev);
    this.changeLog.push(ev);
  }
  async busyFromEvents(_c: string, range: Interval, tz: string, exclude?: string) {
    const out: Interval[] = [];
    for (const e of this.events.values()) {
      if (e.id === exclude || !eventBlocks(e)) continue;
      const iv = eventInterval(e, tz);
      if (iv && iv.start < range.end && iv.end > range.start) out.push(iv);
    }
    return out;
  }
  async busyFromFreeBusy() { return this.freeBusyBusy; }
  async insertEvent(_c: string, event: object, opts: { meet: boolean }) {
    this.insertCalls++;
    if (this.failInsert) throw new GoogleError(500, "boom");
    const e = event as GEvent & { conferenceData?: unknown };
    const existing = this.events.get(e.id);
    if (existing && existing.status !== "cancelled") return existing;
    const ev: GEvent = { ...e, status: "confirmed" };
    if (opts.meet && !this.failMeet) ev.hangoutLink = `https://meet.google.com/fake-${e.id.slice(0, 6)}`;
    delete (ev as { conferenceData?: unknown }).conferenceData;
    this.events.set(ev.id, ev);
    this.changeLog.push(ev);
    this.onAfterInsert?.();
    return ev;
  }
  async patchEvent(_c: string, id: string, patch: object) {
    const ev = { ...this.events.get(id)!, ...patch } as GEvent;
    this.events.set(id, ev);
    this.changeLog.push(ev);
    return ev;
  }
  async getEvent(_c: string, id: string) { return this.events.get(id) ?? null; }
  async deleteEvent(_c: string, id: string) {
    this.deleted.push(id);
    const ev = this.events.get(id);
    if (ev) { this.events.delete(id); this.changeLog.push({ id, status: "cancelled", extendedProperties: ev.extendedProperties }); }
  }
  async listChanges(_c: string, token: string | null) {
    if (token === "expired") return "expired" as const;
    const events = token ? this.changeLog.splice(0) : this.changeLog.splice(0);
    return { events, nextSyncToken: `tok${++this.syncToken}` };
  }
  async watch() { return { resourceId: "res1", expiration: Date.now() + 7 * 86400_000 }; }
  async stopChannel() {}
  async listCalendars() { return [{ id: "primary", summary: "main", primary: true, accessRole: "owner" }]; }
}

export class FakeMailer implements Mailer {
  sent: MailMessage[] = [];
  fail = false;
  async send(m: MailMessage) {
    if (this.fail) throw new Error("smtp down");
    this.sent.push(m);
  }
}

/** 2026-10-20(火) 09:00 JST を「現在」とする */
export const NOW = zonedToTs("2026-10-20", "09:00", "Asia/Tokyo");

export async function setup(over: Partial<Settings> = {}) {
  const db = memDb();
  const s: Settings = { ...DEFAULT_SETTINGS, officeAddress: "京都府京都市上京区築山南半町234 大甚ビル301", ...over };
  await saveSettings(db, s);
  const cal = new FakeCalendar();
  const mailer = new FakeMailer();
  const deps: Deps = { db, cal, mailer, baseUrl: "https://book.example.com", now: () => NOW, sleep: async () => {} };
  return { db, s, cal, mailer, deps };
}

export const jst = (date: string, hhmm: string) => new Date(zonedToTs(date, hhmm, "Asia/Tokyo") * 1000).toISOString();
export const input = (o: Record<string, unknown> = {}) => ({
  mode: "online", date: "2026-10-21", time: "13:30", name: "山田太郎", email: "yamada@example.com", company: "株式会社テスト", ...o,
});
export { meetUrlOf };
