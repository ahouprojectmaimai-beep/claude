// メール送信（Resend / Gmail API）とテンプレート
import { b64u } from "./crypto.ts";
import type { DB } from "./db.ts";
import { nowSec } from "./db.ts";
import { getAccessToken, type GoogleEnv } from "./google.ts";
import type { Settings } from "./settings.ts";
import { formatDateLong, formatRange } from "./time.ts";

export type MailMessage = { to: string; subject: string; text: string; html: string; replyTo?: string };
export interface Mailer {
  send(m: MailMessage): Promise<void>;
}

export type MailEnv = GoogleEnv & {
  MAIL_PROVIDER?: string; // "resend"(既定) | "gmail"
  RESEND_API_KEY?: string;
  MAIL_FROM?: string; // 例: "TUMIKI <booking@example.com>"
};

const encodeHeader = (s: string) => `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`;

export class ResendMailer implements Mailer {
  constructor(private key: string, private from: string) {}
  async send(m: MailMessage) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, reply_to: m.replyTo || undefined }),
    });
    if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
  }
}

/** 管理者のGoogleアカウントから送る（独自ドメイン不要）。連携時に gmail.send を許可した場合のみ */
export class GmailMailer implements Mailer {
  constructor(private env: GoogleEnv, private db: DB) {}
  async send(m: MailMessage) {
    const boundary = `b_${crypto.randomUUID()}`;
    const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/(.{76})/g, "$1\r\n");
    const headers = [
      `To: ${m.to}`,
      m.replyTo ? `Reply-To: ${m.replyTo}` : "",
      `Subject: ${encodeHeader(m.subject)}`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ].filter(Boolean); // From は省略 → Gmail が認証済みアカウントのアドレスを設定する
    const raw = [
      ...headers, "",
      `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(m.text),
      `--${boundary}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(m.html),
      `--${boundary}--`,
    ].join("\r\n");
    const token = await getAccessToken(this.env, this.db);
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: b64u.enc(new TextEncoder().encode(raw)) }),
    });
    if (!r.ok) throw new Error(`Gmail ${r.status}: ${await r.text()}`);
  }
}

export function createMailer(env: MailEnv, db: DB): Mailer {
  if (env.MAIL_PROVIDER === "gmail") return new GmailMailer(env, db);
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error("メール送信が未設定です (RESEND_API_KEY / MAIL_FROM)");
  return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
}

// ---- テンプレート ----------------------------------------------------------

export type MailBooking = {
  id: string; mode: "online" | "office" | "visit"; name: string; company: string; email: string; note: string;
  start_ts: number; end_ts: number; meet_url: string; location_name: string; location_address: string;
  address_unconfirmed: number; location_source: string;
};
export type MailKind = "confirmed" | "changed" | "cancelled" | "admin_new" | "admin_cancelled";

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const MODE_LABEL = { online: "オンライン（Google Meet）", office: "対面（事務所）", visit: "対面（店舗・指定場所）" } as const;

/** 開催場所の表示行。対面で住所未確認なら確認する旨を案内 */
export function locationLines(b: MailBooking, s: Settings): { label: string; value: string }[] {
  if (b.mode === "online") return b.meet_url ? [{ label: "参加URL", value: b.meet_url }] : [{ label: "参加URL", value: "（準備中です。確定後にご案内します）" }];
  if (b.mode === "office") {
    return [{ label: "開催場所", value: [s.officeName, s.officeAddress].filter(Boolean).join("\n") || "事務所（詳細は別途ご案内します）" }];
  }
  const place = [b.location_name, b.location_address].filter(Boolean).join("\n");
  if (b.address_unconfirmed || !b.location_address) {
    return [{ label: "開催場所", value: `${b.location_name || "（未定）"}\n※場所の詳細は、確認のうえ改めてご連絡いたします。` }];
  }
  return [{ label: "開催場所", value: place }];
}

const SUBJECT: Record<MailKind, string> = {
  confirmed: "【TUMIKI】お打ち合わせ予約が確定しました",
  changed: "【TUMIKI】お打ち合わせ日時を変更しました",
  cancelled: "【TUMIKI】お打ち合わせ予約をキャンセルしました",
  admin_new: "【TUMIKI】新しい予約が入りました",
  admin_cancelled: "【TUMIKI】予約がキャンセルされました",
};

export function buildMail(
  kind: MailKind, b: MailBooking, s: Settings,
  opts: { manageUrl?: string; baseUrl: string; to?: string },
): MailMessage {
  const when = formatRange(b.start_ts, b.end_ts, s.timezone);
  const longDate = formatDateLong(b.start_ts, s.timezone);
  const isAdmin = kind === "admin_new" || kind === "admin_cancelled";
  const greet = isAdmin ? "TUMIKI ご担当者様" : `${b.name}様`;
  const intro: Record<MailKind, string> = {
    confirmed: "この度はTUMIKIのお打ち合わせをご予約いただき、ありがとうございます。\n以下の日程でご予約を承りました。",
    changed: "お打ち合わせの日時を変更しました。\n変更後の内容は以下のとおりです。",
    cancelled: "以下のお打ち合わせ予約をキャンセルしました。\nまたのご予約をお待ちしております。",
    admin_new: "新しい予約が入りました。Googleカレンダーに登録済みです。",
    admin_cancelled: "予約がキャンセルされました。Googleカレンダーからも削除済みです。",
  };
  const rows: { label: string; value: string }[] = [{ label: "日時", value: when }];
  if (kind !== "cancelled" && kind !== "admin_cancelled") {
    rows.push({ label: "開催方法", value: MODE_LABEL[b.mode] }, ...locationLines(b, s));
  }
  if (isAdmin) {
    rows.push({ label: "お客様", value: [b.company, b.name].filter(Boolean).join(" ") + `\n${b.email}` });
    if (b.note) rows.push({ label: "備考", value: b.note });
    if (b.mode === "visit" && (b.address_unconfirmed || !b.location_address)) rows.push({ label: "要確認", value: "訪問先の住所が未確認です" });
  }
  const footerLink = !isAdmin && kind !== "cancelled" && opts.manageUrl;
  const ending = kind === "confirmed" ? "当日はどうぞよろしくお願いいたします。" : kind === "changed" ? "引き続きよろしくお願いいたします。" : "";

  const text = [
    greet, "", intro[kind], "",
    ...rows.flatMap((r) => [`【${r.label}】`, r.value, ""]),
    footerLink ? `【予約内容の確認・変更・キャンセル】\n${opts.manageUrl}\n` : "",
    ending, "", "TUMIKI",
  ].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");

  const html = `<!doctype html><html lang="ja"><body style="margin:0;background:#FBF7F0;font-family:-apple-system,'Hiragino Sans','Noto Sans JP',sans-serif;color:#3B3228">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="text-align:center;padding:8px 0 20px"><img src="${opts.baseUrl}/brand/logo.png" alt="TUMIKI" height="40" style="height:40px" onerror="this.style.display='none'"></div>
<div style="background:#fff;border-radius:16px;padding:28px 24px;border:1px solid #EFE6D8">
<p style="margin:0 0 4px;font-weight:700;font-size:16px">${esc(greet)}</p>
<p style="margin:12px 0 20px;line-height:1.8;font-size:14px">${esc(intro[kind]).replace(/\n/g, "<br>")}</p>
${rows.map((r) => `<div style="margin:0 0 14px"><div style="font-size:12px;color:#8A7B68;margin-bottom:2px">${esc(r.label)}</div><div style="font-size:15px;font-weight:600;line-height:1.6">${
    /^https?:\/\//.test(r.value) ? `<a href="${esc(r.value)}" style="color:#E8833A">${esc(r.value)}</a>` : esc(r.value).replace(/\n/g, "<br>")
  }</div></div>`).join("")}
${footerLink ? `<div style="text-align:center;margin:26px 0 6px"><a href="${esc(opts.manageUrl!)}" style="display:inline-block;background:#E8833A;color:#fff;text-decoration:none;font-weight:700;padding:14px 26px;border-radius:999px;font-size:15px">予約の確認・変更・キャンセル</a></div>` : ""}
${ending ? `<p style="margin:20px 0 0;font-size:14px;line-height:1.8">${esc(ending)}</p>` : ""}
</div>
<p style="text-align:center;color:#8A7B68;font-size:12px;margin:18px 0 0">TUMIKI（${esc(longDate)} のご案内）</p>
</div></body></html>`;

  return { to: opts.to ?? b.email, subject: SUBJECT[kind], text, html, replyTo: s.replyTo || undefined };
}

/** 送信して履歴に残す。失敗しても例外は投げず、管理画面から再送できるようにする */
export async function sendAndLog(
  db: DB, mailer: Mailer | null, bookingId: string, kind: MailKind, msg: MailMessage,
): Promise<boolean> {
  let status: "sent" | "failed" = "sent";
  let error = "";
  try {
    if (!mailer) throw new Error("メール送信が未設定です");
    await mailer.send(msg);
  } catch (e) {
    status = "failed";
    error = String((e as Error).message ?? e).slice(0, 500);
  }
  await db
    .prepare("INSERT INTO mail_log (booking_id, kind, to_email, status, error, created_at) VALUES (?,?,?,?,?,?)")
    .bind(bookingId, kind, msg.to, status, error, nowSec())
    .run();
  return status === "sent";
}
