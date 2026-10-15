import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  adminUpdateDetails, BookingError, cancelBooking, cleanupPending, createBooking, getAvailability, getBooking,
  getBookingByToken, publicView, rescheduleBooking, resendConfirmation, type Deps,
} from "../lib/booking.ts";
import { randomToken, encryptSecret, signPayload, verifyPayload } from "../lib/crypto.ts";
import type { DB } from "../lib/db.ts";
import { nowSec } from "../lib/db.ts";
import {
  authUrl, BASE_SCOPES, emailFromIdToken, exchangeCode, GMAIL_SCOPE, GoogleCalendar, GoogleError, revokeToken,
} from "../lib/google.ts";
import { createMailer, type Mailer } from "../lib/mail.ts";
import { allow, purgeRateLimits } from "../lib/ratelimit.ts";
import { loadSettings, normalizeSettings, saveSettings, type Settings } from "../lib/settings.ts";
import { ensureWatch, stopWatch, syncCalendar, verifyWebhook, watchStatus } from "../lib/sync.ts";
import { addDays, tsToDate } from "../lib/time.ts";
import { bookableRange } from "../lib/availability.ts";
import type { Env } from "./env.ts";

type C = Context<{ Bindings: Env }>;
const app = new Hono<{ Bindings: Env }>();

const dbOf = (env: Env) => env.DB as unknown as DB;
const baseUrl = (env: Env) => env.PUBLIC_BASE_URL.replace(/\/$/, "");

function depsOf(env: Env): Deps {
  const db = dbOf(env);
  let mailer: Mailer | null = null;
  try { mailer = createMailer(env, db); } catch { mailer = null; }
  return { db, cal: new GoogleCalendar(env, db), mailer, baseUrl: baseUrl(env) };
}

const STATUS: Record<BookingError["code"], 400 | 403 | 404 | 409 | 429 | 502> = {
  invalid: 400, forbidden: 403, not_found: 404, unavailable: 409, rate_limited: 429, google: 502,
};

app.onError((e, c) => {
  if (e instanceof BookingError) return c.json({ error: e.code, message: e.message, fields: e.fields }, STATUS[e.code]);
  if (e instanceof GoogleError && e.status === 412) return c.json({ error: "not_connected", message: "現在、予約を受け付けておりません。" }, 503);
  console.error("unhandled", e instanceof Error ? e.message : e); // 個人情報は出さない
  return c.json({ error: "server", message: "エラーが発生しました。時間をおいてもう一度お試しください。" }, 500);
});

// CSRF対策: ブラウザからの書き込み系は同一オリジンのみ
app.use("/api/*", async (c, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && !c.req.path.startsWith("/api/google/webhook")) {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(baseUrl(c.env)).origin) return c.json({ error: "forbidden", message: "forbidden" }, 403);
  }
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  await next();
});

// ---- 公開API --------------------------------------------------------------------

app.get("/api/public/config", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  const connected = !!(await dbOf(c.env).prepare("SELECT 1 AS x FROM google_account WHERE id = 1").first());
  const r = bookableRange(s, nowSec());
  return c.json({
    ready: connected, timezone: s.timezone, durationMin: s.durationMin, firstDate: r.first, lastDate: r.last, today: tsToDate(nowSec(), s.timezone),
    office: { name: s.officeName, address: s.officeAddress }, visitLocationBy: s.visitLocationBy, privacyText: s.privacyText,
  });
});

app.get("/api/public/availability", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await allow(dbOf(c.env), `avail:${ip}`, 60, 40))) throw new BookingError("rate_limited", "アクセスが集中しています。少し待ってからお試しください。");
  const s = await loadSettings(dbOf(c.env));
  const r = bookableRange(s, nowSec());
  const from = c.req.query("from") ?? r.first;
  const to = c.req.query("to") ?? addDays(from, 31);
  return c.json({ days: await getAvailability(depsOf(c.env), s, from < r.first ? r.first : from, to > r.last ? r.last : to) });
});

app.post("/api/public/bookings", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  const body = await c.req.json().catch(() => null);
  const res = await createBooking(depsOf(c.env), s, body, c.req.header("cf-connecting-ip") ?? "unknown");
  if (res.fake) return c.json({ ok: true, booking: null });
  return c.json({ ok: true, booking: res.booking, manageUrl: `${baseUrl(c.env)}/manage?b=${res.id}&t=${res.token}` }, 201);
});

async function authedBooking(c: C) {
  const id = c.req.param("id") ?? "";
  const token = c.req.query("t") ?? ((await c.req.json().catch(() => ({}))) as { t?: string }).t ?? "";
  if (!(await allow(dbOf(c.env), `manage:${c.req.header("cf-connecting-ip") ?? "x"}`, 600, 60))) throw new BookingError("rate_limited", "アクセスが集中しています");
  const b = await getBookingByToken(dbOf(c.env), id, token);
  if (!b) throw new BookingError("not_found", "予約が見つかりません。リンクをご確認ください。");
  return { b, token };
}

app.get("/api/public/bookings/:id", async (c) => {
  const { b } = await authedBooking(c);
  const s = await loadSettings(dbOf(c.env));
  return c.json({ booking: publicView(b, s), canChange: b.status === "confirmed" && b.start_ts - nowSec() >= s.cutoffMin * 60 });
});

app.get("/api/public/bookings/:id/availability", async (c) => {
  const { b } = await authedBooking(c);
  const s = await loadSettings(dbOf(c.env));
  const r = bookableRange(s, nowSec());
  const from = c.req.query("from") ?? r.first;
  const to = c.req.query("to") ?? addDays(from, 31);
  return c.json({ days: await getAvailability(depsOf(c.env), s, from < r.first ? r.first : from, to > r.last ? r.last : to, b.id) });
});

app.post("/api/public/bookings/:id/reschedule", async (c) => {
  const body = (await c.req.raw.clone().json().catch(() => ({}))) as { t?: string; date?: string; time?: string };
  const { b, token } = await authedBooking(c);
  const s = await loadSettings(dbOf(c.env));
  return c.json({ ok: true, booking: await rescheduleBooking(depsOf(c.env), s, b.id, body.date ?? "", body.time ?? "", "customer", token) });
});

app.post("/api/public/bookings/:id/cancel", async (c) => {
  const { b, token } = await authedBooking(c);
  const s = await loadSettings(dbOf(c.env));
  return c.json({ ok: true, booking: await cancelBooking(depsOf(c.env), s, b.id, "customer", token) });
});

// ---- Google Calendar 通知(Webhook) -------------------------------------------------

app.post("/api/google/webhook", async (c) => {
  const db = dbOf(c.env);
  if (!(await verifyWebhook(db, c.req.header("x-goog-channel-id") ?? null, c.req.header("x-goog-channel-token") ?? null))) {
    return c.body(null, 404);
  }
  if (c.req.header("x-goog-resource-state") === "exists") {
    c.executionCtx.waitUntil(
      loadSettings(db).then((s) => syncCalendar(depsOf(c.env), s)).catch((e) => console.error("webhook sync failed", String(e?.message ?? e))),
    );
  }
  return c.body(null, 204);
});

// ---- 管理者認証 ---------------------------------------------------------------------

const COOKIE = "tumiki_admin";
type Session = { email: string; exp: number };

async function requireAdmin(c: C): Promise<Session> {
  const sess = await verifyPayload<Session>(getCookie(c, COOKIE), c.env.SESSION_SECRET);
  if (!sess || sess.exp < nowSec() || !c.env.ADMIN_EMAIL || sess.email !== c.env.ADMIN_EMAIL.toLowerCase()) {
    throw new HttpAuth();
  }
  return sess;
}
class HttpAuth extends Error {}

app.use("/api/admin/*", async (c, next) => {
  const p = c.req.path;
  if (p === "/api/admin/login" || p === "/api/admin/oauth/callback") return next();
  try { await requireAdmin(c); } catch { return c.json({ error: "unauthorized", message: "ログインが必要です" }, 401); }
  return next();
});

app.get("/api/admin/login", async (c) => {
  const db = dbOf(c.env);
  if (!(await allow(db, `login:${c.req.header("cf-connecting-ip") ?? "x"}`, 600, 20))) return c.text("Too many requests", 429);
  const connected = !!(await db.prepare("SELECT 1 AS x FROM google_account WHERE id = 1").first());
  const reconnect = c.req.query("reconnect") === "1" || !connected;
  const withGmail = c.req.query("gmail") === "1" || c.env.MAIL_PROVIDER === "gmail";
  const state = await signPayload({ n: randomToken(12), exp: nowSec() + 600, connect: reconnect }, c.env.SESSION_SECRET);
  setCookie(c, "tumiki_oauth", state, { httpOnly: true, secure: true, sameSite: "Lax", path: "/api/admin", maxAge: 600 });
  return c.redirect(authUrl(c.env, state, withGmail ? [...BASE_SCOPES, GMAIL_SCOPE] : BASE_SCOPES, reconnect));
});

app.get("/api/admin/oauth/callback", async (c) => {
  const db = dbOf(c.env);
  const state = c.req.query("state") ?? "";
  const st = await verifyPayload<{ exp: number; connect: boolean }>(state, c.env.SESSION_SECRET);
  if (!st || st.exp < nowSec() || getCookie(c, "tumiki_oauth") !== state) return c.text("認証の有効期限が切れました。もう一度やり直してください。", 400);
  deleteCookie(c, "tumiki_oauth", { path: "/api/admin" });
  const code = c.req.query("code");
  if (!code) return c.redirect("/admin?error=denied");
  const tok = await exchangeCode(c.env, code);
  const who = emailFromIdToken(tok.id_token);
  if (!who || !who.verified || !c.env.ADMIN_EMAIL || who.email !== c.env.ADMIN_EMAIL.toLowerCase()) {
    return c.redirect("/admin?error=forbidden");
  }
  if (tok.refresh_token) {
    await db
      .prepare(
        "INSERT INTO google_account (id, email, refresh_token_enc, scopes, connected_at) VALUES (1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email, refresh_token_enc=excluded.refresh_token_enc, scopes=excluded.scopes, connected_at=excluded.connected_at",
      )
      .bind(who.email, await encryptSecret(tok.refresh_token, c.env.ENCRYPTION_KEY), tok.scope ?? "", nowSec())
      .run();
    // 接続直後に通知チャンネルと同期を初期化（失敗しても接続自体は成功）
    c.executionCtx.waitUntil((async () => {
      try { const s = await loadSettings(db); const d = depsOf(c.env); await ensureWatch(d.cal, db, s, d.baseUrl); await syncCalendar(d, s); } catch (e) { console.error("post-connect init failed", String((e as Error).message)); }
    })());
  }
  setCookie(c, COOKIE, await signPayload({ email: who.email, exp: nowSec() + 8 * 3600 }, c.env.SESSION_SECRET), {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 8 * 3600,
  });
  return c.redirect("/admin");
});

app.post("/api/admin/logout", (c) => { deleteCookie(c, COOKIE, { path: "/" }); return c.json({ ok: true }); });
app.get("/api/admin/me", async (c) => c.json({ email: (await requireAdmin(c)).email }));

// ---- 管理API ------------------------------------------------------------------------

type BookingRow = NonNullable<Awaited<ReturnType<typeof getBooking>>>;
const adminRow = (b: BookingRow, s: Settings) => ({
  ...publicView(b, s),
  locationName: b.location_name, locationAddress: b.location_address, locationSource: b.location_source,
  status: b.status, cancelledBy: b.cancelled_by, externallyChanged: !!b.externally_changed, failReason: b.fail_reason,
  eventId: b.event_id, createdAt: b.created_at,
});

app.get("/api/admin/bookings", async (c) => {
  const db = dbOf(c.env);
  const s = await loadSettings(db);
  const view = c.req.query("view") ?? "upcoming";
  const where = view === "past" ? "status IN ('confirmed','cancelled') AND start_ts <= ?" : view === "all" ? "status IN ('confirmed','cancelled','failed') AND ? = ?" : "status = 'confirmed' AND start_ts > ?";
  const now = nowSec();
  const q = db.prepare(`SELECT b.*, (SELECT status FROM mail_log m WHERE m.booking_id=b.id AND m.kind IN ('confirmed','changed','cancelled') ORDER BY m.id DESC LIMIT 1) AS mail_status FROM bookings b WHERE ${where} ORDER BY start_ts ${view === "upcoming" ? "ASC" : "DESC"} LIMIT 300`);
  const { results } = await (view === "all" ? q.bind(1, 1) : q.bind(now)).all<BookingRow & { mail_status: string | null }>();
  return c.json({ bookings: results.map((b) => ({ ...adminRow(b, s), mailStatus: b.mail_status })) });
});

app.patch("/api/admin/bookings/:id", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  const body = (await c.req.json().catch(() => ({}))) as { locationName?: string; locationAddress?: string };
  const b = await adminUpdateDetails(depsOf(c.env), s, c.req.param("id"), body);
  return c.json({ ok: true, booking: adminRow(b, s) });
});

app.post("/api/admin/bookings/:id/cancel", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  return c.json({ ok: true, booking: await cancelBooking(depsOf(c.env), s, c.req.param("id"), "admin") });
});

app.post("/api/admin/bookings/:id/reschedule", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  const body = (await c.req.json().catch(() => ({}))) as { date?: string; time?: string };
  return c.json({ ok: true, booking: await rescheduleBooking(depsOf(c.env), s, c.req.param("id"), body.date ?? "", body.time ?? "", "admin") });
});

app.post("/api/admin/bookings/:id/resend", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  const ok = await resendConfirmation(depsOf(c.env), s, c.req.param("id"));
  return c.json({ ok, message: ok ? "再送しました" : "送信に失敗しました（メール履歴をご確認ください）" }, ok ? 200 : 502);
});

app.get("/api/admin/availability", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  const r = bookableRange(s, nowSec());
  const from = c.req.query("from") ?? r.first;
  return c.json({ days: await getAvailability(depsOf(c.env), s, from < r.first ? r.first : from, c.req.query("to") ?? addDays(from, 31), c.req.query("exclude") ?? "") });
});

app.get("/api/admin/mail-log", async (c) => {
  const only = c.req.query("status") === "failed";
  const { results } = await dbOf(c.env)
    .prepare(`SELECT id, booking_id, kind, to_email, status, error, created_at FROM mail_log ${only ? "WHERE status='failed'" : ""} ORDER BY id DESC LIMIT 100`)
    .all();
  return c.json({ logs: results });
});

app.get("/api/admin/settings", async (c) => c.json({ settings: await loadSettings(dbOf(c.env)) }));
app.put("/api/admin/settings", async (c) => {
  const db = dbOf(c.env);
  const before = await loadSettings(db);
  const next = normalizeSettings(await c.req.json().catch(() => ({})), before);
  await saveSettings(db, next);
  if (next.targetCalendarId !== before.targetCalendarId) {
    // 登録先を変えたら差分トークン・通知チャンネルを作り直す
    await db.prepare("DELETE FROM sync_state WHERE key LIKE 'sync_token:%'").run();
    c.executionCtx.waitUntil((async () => { const d = depsOf(c.env); try { await stopWatch(d.cal, db); await ensureWatch(d.cal, db, next, d.baseUrl); } catch { /* cronで再試行 */ } })());
  }
  return c.json({ ok: true, settings: next });
});

app.get("/api/admin/google/status", async (c) => {
  const db = dbOf(c.env);
  const acct = await db.prepare("SELECT email, scopes, connected_at FROM google_account WHERE id = 1").first<{ email: string; scopes: string; connected_at: number }>();
  let calendars: unknown[] = [], error = "";
  if (acct) {
    try { calendars = await depsOf(c.env).cal.listCalendars(); } catch (e) { error = e instanceof GoogleError ? `Google接続エラー (${e.status})。再接続してください。` : "取得に失敗しました"; }
  }
  const last = await db.prepare("SELECT updated_at FROM sync_state WHERE key LIKE 'sync_token:%' ORDER BY updated_at DESC LIMIT 1").first<{ updated_at: number }>();
  return c.json({
    connected: !!acct && !error, account: acct?.email ?? null, connectedAt: acct?.connected_at ?? null, gmailScope: !!acct?.scopes.includes("gmail.send"),
    mailProvider: c.env.MAIL_PROVIDER ?? "resend", mailConfigured: !!(c.env.MAIL_PROVIDER === "gmail" || (c.env.RESEND_API_KEY && c.env.MAIL_FROM)),
    publicBaseUrl: baseUrl(c.env), watch: await watchStatus(db), lastSync: last?.updated_at ?? null, calendars, error,
  });
});

app.post("/api/admin/google/sync", async (c) => {
  const s = await loadSettings(dbOf(c.env));
  const d = depsOf(c.env);
  const result = await syncCalendar(d, s);
  try { await ensureWatch(d.cal, dbOf(c.env), s, d.baseUrl); } catch (e) { console.error("watch failed", String((e as Error).message)); }
  return c.json({ ok: true, result });
});

app.post("/api/admin/google/disconnect", async (c) => {
  const db = dbOf(c.env);
  const d = depsOf(c.env);
  try { await stopWatch(d.cal, db); } catch { /* ignore */ }
  await revokeToken(c.env, db);
  await db.prepare("DELETE FROM google_account WHERE id = 1").run();
  await db.prepare("DELETE FROM sync_state").run();
  return c.json({ ok: true });
});

// ---- Cron ---------------------------------------------------------------------------

async function scheduled(env: Env) {
  const db = dbOf(env);
  if (!(await db.prepare("SELECT 1 AS x FROM google_account WHERE id = 1").first())) return;
  const s = await loadSettings(db);
  const d = depsOf(env);
  const step = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { console.error(`cron ${name} failed`, String((e as Error).message ?? e)); } };
  await step("cleanup", () => cleanupPending(d, s));
  await step("sync", () => syncCalendar(d, s));
  await step("watch", () => ensureWatch(d.cal, db, s, d.baseUrl));
  await step("ratelimit", () => purgeRateLimits(db));
}

export default {
  fetch: app.fetch,
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => { ctx.waitUntil(scheduled(env)); },
} satisfies ExportedHandler<Env>;
