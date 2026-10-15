// Google OAuth 2.0 / Calendar API（REST直接呼び出し）
import { decryptSecret } from "./crypto.ts";
import type { DB } from "./db.ts";
import { zonedToTs, type Interval } from "./time.ts";

export type GoogleEnv = {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ENCRYPTION_KEY: string;
  PUBLIC_BASE_URL: string;
};

export const CAL_API = "https://www.googleapis.com/calendar/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const BASE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
];
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export class GoogleError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function authUrl(env: GoogleEnv, state: string, scopes: string[], forceConsent: boolean): string {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.PUBLIC_BASE_URL}/api/admin/oauth/callback`,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: forceConsent ? "consent select_account" : "select_account", // 接続時は refresh_token を確実に受け取る
    include_granted_scopes: "true",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(env: GoogleEnv, code: string) {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.PUBLIC_BASE_URL}/api/admin/oauth/callback`, grant_type: "authorization_code",
    }),
  });
  if (!r.ok) throw new GoogleError(r.status, `token exchange failed: ${await r.text()}`);
  return (await r.json()) as { access_token: string; refresh_token?: string; id_token?: string; scope?: string; expires_in: number };
}

export function emailFromIdToken(idToken: string | undefined): { email: string; verified: boolean } | null {
  if (!idToken) return null; // 直接Googleのトークンエンドポイントから受け取ったものなので署名検証は省略可
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return { email: String(payload.email ?? "").toLowerCase(), verified: payload.email_verified === true };
  } catch {
    return null;
  }
}

/** アクセストークンの取得（isolate内で短時間キャッシュ） */
const tokenCache = new Map<string, { token: string; exp: number }>();

export async function getAccessToken(env: GoogleEnv, db: DB): Promise<string> {
  const acct = await db.prepare("SELECT refresh_token_enc FROM google_account WHERE id = 1").first<{ refresh_token_enc: string }>();
  if (!acct) throw new GoogleError(412, "Googleアカウントが未接続です");
  const cached = tokenCache.get(acct.refresh_token_enc);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const refresh = await decryptSecret(acct.refresh_token_enc, env.ENCRYPTION_KEY);
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new GoogleError(r.status === 400 ? 401 : r.status, `token refresh failed: ${await r.text()}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  tokenCache.set(acct.refresh_token_enc, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

export async function revokeToken(env: GoogleEnv, db: DB): Promise<void> {
  const acct = await db.prepare("SELECT refresh_token_enc FROM google_account WHERE id = 1").first<{ refresh_token_enc: string }>();
  if (!acct) return;
  try {
    const refresh = await decryptSecret(acct.refresh_token_enc, env.ENCRYPTION_KEY);
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }),
    });
  } catch { /* 失効済みでも切断は続行 */ }
  tokenCache.delete(acct.refresh_token_enc);
}

// ---- Calendar ---------------------------------------------------------------

export type GEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  transparency?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType: string; uri: string }[]; createRequest?: { status?: { statusCode: string } } };
  attendees?: { email: string; self?: boolean; responseStatus?: string }[];
  extendedProperties?: { private?: Record<string, string> };
  updated?: string;
};

export interface CalendarApi {
  /** 登録先カレンダーの埋まり時間（excludeEventId を除く）。詳細が見られる自分のカレンダー用 */
  busyFromEvents(calendarId: string, range: Interval, tz: string, excludeEventId?: string): Promise<Interval[]>;
  /** 追加カレンダーの埋まり時間（freeBusy API） */
  busyFromFreeBusy(calendarIds: string[], range: Interval): Promise<Interval[]>;
  insertEvent(calendarId: string, event: object, opts: { meet: boolean; sendUpdates: "all" | "none" }): Promise<GEvent>;
  patchEvent(calendarId: string, eventId: string, patch: object, opts: { sendUpdates: "all" | "none" }): Promise<GEvent>;
  getEvent(calendarId: string, eventId: string): Promise<GEvent | null>;
  deleteEvent(calendarId: string, eventId: string, opts: { sendUpdates: "all" | "none" }): Promise<void>;
  listChanges(calendarId: string, syncToken: string | null, timeMin: string): Promise<{ events: GEvent[]; nextSyncToken: string } | "expired">;
  watch(calendarId: string, channel: { id: string; address: string; token: string }): Promise<{ resourceId: string; expiration: number }>;
  stopChannel(id: string, resourceId: string): Promise<void>;
  listCalendars(): Promise<{ id: string; summary: string; primary: boolean; accessRole: string }[]>;
}

/** イベントが「予定あり」(予約を妨げる)かどうか。予定なし(transparent)・キャンセル・辞退は妨げない */
export function eventBlocks(e: GEvent): boolean {
  if (e.status === "cancelled") return false;
  if (e.transparency === "transparent") return false;
  const self = e.attendees?.find((a) => a.self);
  if (self?.responseStatus === "declined") return false;
  return true;
}

/** イベントの時間帯。終日予定はタイムゾーンの0:00〜（終日はendが翌日0:00で排他的） */
export function eventInterval(e: GEvent, tz: string): Interval | null {
  if (e.start?.dateTime && e.end?.dateTime) {
    return { start: Math.floor(Date.parse(e.start.dateTime) / 1000), end: Math.floor(Date.parse(e.end.dateTime) / 1000) };
  }
  if (e.start?.date && e.end?.date) {
    return { start: zonedToTs(e.start.date, "00:00", tz), end: zonedToTs(e.end.date, "00:00", tz) };
  }
  return null;
}

export function meetUrlOf(e: GEvent): string {
  return e.hangoutLink || e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri || "";
}

export class GoogleCalendar implements CalendarApi {
  constructor(private env: GoogleEnv, private db: DB) {}

  private async call<T>(method: string, url: string, body?: unknown, okStatuses: number[] = []): Promise<T | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = await getAccessToken(this.env, this.db);
      const r = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.ok) return r.status === 204 ? null : ((await r.json()) as T);
      if (okStatuses.includes(r.status)) return null;
      if ((r.status === 429 || r.status >= 500) && attempt < 2) {
        await new Promise((res) => setTimeout(res, 300 * 2 ** attempt));
        continue;
      }
      throw new GoogleError(r.status, `${method} ${url.split("?")[0]} -> ${r.status} ${await r.text()}`);
    }
    throw new GoogleError(500, "unreachable");
  }

  async busyFromEvents(calendarId: string, range: Interval, tz: string, excludeEventId?: string): Promise<Interval[]> {
    const out: Interval[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        timeMin: new Date(range.start * 1000).toISOString(), timeMax: new Date(range.end * 1000).toISOString(),
        singleEvents: "true", maxResults: "250", showDeleted: "false",
        fields: "nextPageToken,items(id,status,transparency,start,end,attendees(self,responseStatus))",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const j = await this.call<{ items?: GEvent[]; nextPageToken?: string }>("GET", `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      for (const e of j?.items ?? []) {
        if (e.id === excludeEventId || !eventBlocks(e)) continue;
        const iv = eventInterval(e, tz);
        if (iv) out.push(iv);
      }
      pageToken = j?.nextPageToken;
    } while (pageToken);
    return out;
  }

  async busyFromFreeBusy(calendarIds: string[], range: Interval): Promise<Interval[]> {
    if (!calendarIds.length) return [];
    const j = await this.call<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>(
      "POST", `${CAL_API}/freeBusy`,
      { timeMin: new Date(range.start * 1000).toISOString(), timeMax: new Date(range.end * 1000).toISOString(), items: calendarIds.map((id) => ({ id })) },
    );
    const out: Interval[] = [];
    for (const [id, c] of Object.entries(j?.calendars ?? {})) {
      // 読めないカレンダーは「空き」と誤判定しないよう、失敗として扱う
      if (c.errors?.length) throw new GoogleError(403, `freeBusy error for ${id}: ${JSON.stringify(c.errors)}`);
      for (const b of c.busy ?? []) out.push({ start: Math.floor(Date.parse(b.start) / 1000), end: Math.floor(Date.parse(b.end) / 1000) });
    }
    return out;
  }

  async insertEvent(calendarId: string, event: object, opts: { meet: boolean; sendUpdates: "all" | "none" }): Promise<GEvent> {
    const q = new URLSearchParams({ sendUpdates: opts.sendUpdates, conferenceDataVersion: opts.meet ? "1" : "0" });
    const url = `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${q}`;
    try {
      return (await this.call<GEvent>("POST", url, event))!;
    } catch (e) {
      // 同じイベントidでの再実行(409)は既存イベントを採用 → 重複しない
      const id = (event as { id?: string }).id;
      if (e instanceof GoogleError && e.status === 409 && id) {
        const existing = await this.getEvent(calendarId, id);
        if (existing && existing.status !== "cancelled") return existing;
      }
      throw e;
    }
  }

  async patchEvent(calendarId: string, eventId: string, patch: object, opts: { sendUpdates: "all" | "none" }): Promise<GEvent> {
    const q = new URLSearchParams({ sendUpdates: opts.sendUpdates, conferenceDataVersion: "1" });
    return (await this.call<GEvent>("PATCH", `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?${q}`, patch))!;
  }

  async getEvent(calendarId: string, eventId: string): Promise<GEvent | null> {
    return this.call<GEvent>("GET", `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, undefined, [404, 410]);
  }

  async deleteEvent(calendarId: string, eventId: string, opts: { sendUpdates: "all" | "none" }): Promise<void> {
    await this.call("DELETE", `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${opts.sendUpdates}`, undefined, [404, 410]);
  }

  async listChanges(calendarId: string, syncToken: string | null, timeMin: string) {
    const events: GEvent[] = [];
    let pageToken: string | undefined;
    let next = "";
    do {
      const q = new URLSearchParams({ maxResults: "250", showDeleted: "true", singleEvents: "false" });
      if (syncToken) q.set("syncToken", syncToken);
      else q.set("timeMin", timeMin);
      if (pageToken) q.set("pageToken", pageToken);
      let j: { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string } | null;
      try {
        j = await this.call("GET", `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      } catch (e) {
        if (e instanceof GoogleError && e.status === 410) return "expired" as const;
        throw e;
      }
      events.push(...(j?.items ?? []));
      pageToken = j?.nextPageToken;
      if (j?.nextSyncToken) next = j.nextSyncToken;
    } while (pageToken);
    return { events, nextSyncToken: next };
  }

  async watch(calendarId: string, ch: { id: string; address: string; token: string }) {
    const j = await this.call<{ resourceId: string; expiration: string }>(
      "POST", `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
      { id: ch.id, type: "web_hook", address: ch.address, token: ch.token },
    );
    return { resourceId: j!.resourceId, expiration: Number(j!.expiration) };
  }

  async stopChannel(id: string, resourceId: string): Promise<void> {
    await this.call("POST", `${CAL_API}/channels/stop`, { id, resourceId }, [404]);
  }

  async listCalendars() {
    const j = await this.call<{ items?: { id: string; summary?: string; primary?: boolean; accessRole: string }[] }>(
      "GET", `${CAL_API}/users/me/calendarList?minAccessRole=freeBusyReader&fields=items(id,summary,primary,accessRole)`,
    );
    return (j?.items ?? []).map((c) => ({ id: c.id, summary: c.summary ?? c.id, primary: !!c.primary, accessRole: c.accessRole }));
  }
}
