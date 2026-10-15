import { $, api, clear, createPicker, fmtRange, h, MODE_LABEL } from "./common.js";

const app = $("#app");
const q = new URLSearchParams(location.search);
let tab = "bookings";

async function boot() {
  try { await api("/api/admin/me"); } catch { return login(); }
  shell();
}

function login() {
  const errs = { forbidden: "このGoogleアカウントは管理者として登録されていません。", denied: "Googleの認証がキャンセルされました。" };
  clear(app).append(h("div", { class: "wrap" },
    h("header", { class: "brand" }, h("img", { src: "/brand/logo.svg", alt: "TUMIKI" })),
    h("h1", { text: "予約管理" }),
    q.get("error") ? h("p", { class: "alert", text: errs[q.get("error")] || "ログインできませんでした。" }) : null,
    h("a", { class: "btn", href: "/api/admin/login", text: "Googleでログイン" }),
    h("p", { class: "hint center", text: "初回は、Googleカレンダーとの連携の許可も行います。" }),
  ));
}

function shell() {
  const tabs = [["bookings", "予約一覧"], ["settings", "予約設定"], ["google", "Google連携"], ["mail", "メール履歴"]];
  clear(app).append(
    h("div", { class: "topbar" }, h("img", { src: "/brand/logo.svg", alt: "TUMIKI" }),
      h("div", {}, h("a", { class: "btn small ghost", href: "/", target: "_blank", rel: "noopener", text: "予約画面" }), " ",
        h("button", { class: "btn small ghost", type: "button", text: "ログアウト", onclick: async () => { await api("/api/admin/logout", { method: "POST" }); location.href = "/admin"; } }))),
    h("div", { class: "tabs", role: "tablist" }, tabs.map(([k, l]) => h("button", { class: "tab", role: "tab", "aria-selected": String(k === tab), text: l, onclick: () => { tab = k; shell(); } }))),
    h("div", { id: "pane" }),
  );
  ({ bookings: viewBookings, settings: viewSettings, google: viewGoogle, mail: viewMail })[tab]($("#pane"));
}

const toast = (el, msg, kind = "ok") => { const n = h("div", { class: `alert ${kind}`, text: msg }); el.prepend(n); setTimeout(() => n.remove(), 6000); };

// ---- 予約一覧 ----------------------------------------------------------------------
async function viewBookings(pane) {
  let view = "upcoming";
  const list = h("div");
  const seg = h("div", { class: "tabs" });
  async function load() {
    clear(seg).append(...[["upcoming", "これから"], ["past", "過去"], ["all", "すべて"]].map(([k, l]) => h("button", { class: "tab", "aria-selected": String(k === view), text: l, onclick: () => { view = k; load(); } })));
    clear(list).append(h("div", { class: "loading", text: "読み込み中…" }));
    let r;
    try { r = await api(`/api/admin/bookings?view=${view}`); } catch (e) { return clear(list).append(h("div", { class: "alert", text: e.message })); }
    clear(list);
    if (!r.bookings.length) list.append(h("div", { class: "empty", text: "予約はありません" }));
    for (const b of r.bookings) list.append(card(b));
  }
  function card(b) {
    const badges = [];
    if (b.status === "cancelled") badges.push(h("span", { class: "badge gray", text: `キャンセル済み${b.cancelledBy === "calendar" ? "（Googleカレンダーで削除）" : ""}` }));
    else if (b.status === "failed") badges.push(h("span", { class: "badge bad", text: "失敗" }));
    else badges.push(h("span", { class: "badge", text: "確定" }));
    if (b.mode === "visit" && b.addressUnconfirmed) badges.push(h("span", { class: "badge warn", text: "住所未確認" }));
    if (b.mode === "visit") badges.push(h("span", { class: "badge gray", text: b.locationSource === "customer" ? "場所：お客様指定" : "場所：管理者指定" }));
    if (b.externallyChanged) badges.push(h("span", { class: "badge warn", text: "Googleカレンダーで日時変更あり" }));
    if (b.mailStatus === "failed") badges.push(h("span", { class: "badge bad", text: "メール送信失敗" }));
    const place = b.mode === "online" ? (b.meetUrl ? b.meetUrl : "") : b.mode === "office" ? `${b.locationName} ${b.locationAddress}` : [b.locationName, b.locationAddress].filter(Boolean).join(" ");
    const el = h("div", { class: `bk ${b.status === "cancelled" ? "cancelled" : ""}` },
      h("div", { class: "when", text: fmtRange(b) }),
      h("div", { class: "who", text: `${b.company ? b.company + " / " : ""}${b.name} 様` }),
      h("div", { class: "meta", text: `${MODE_LABEL[b.mode]}${place ? "　" + place : ""}` }),
      h("div", { class: "meta", text: b.email + (b.note ? `　備考: ${b.note}` : "") }),
      h("div", { class: "badges" }, badges),
    );
    if (b.status === "confirmed") {
      el.append(h("div", { class: "actions" },
        h("button", { class: "btn small ghost", type: "button", text: "日時変更", onclick: () => rescheduleModal(b, load) }),
        b.mode === "visit" ? h("button", { class: "btn small ghost", type: "button", text: "場所を編集", onclick: () => locationModal(b, load) }) : null,
        h("button", { class: "btn small ghost", type: "button", text: "お客様へ再通知", onclick: async (e) => { e.target.disabled = true; try { const r = await api(`/api/admin/bookings/${b.id}/resend`, { method: "POST" }); toast(pane, r.message); } catch (x) { toast(pane, x.message, ""); } e.target.disabled = false; load(); } }),
        h("button", { class: "btn small danger", type: "button", text: "キャンセル", onclick: async () => { if (!confirm(`${fmtRange(b)} ${b.name}様の予約をキャンセルします。お客様にも通知されます。`)) return; try { await api(`/api/admin/bookings/${b.id}/cancel`, { method: "POST" }); load(); } catch (x) { toast(pane, x.message, ""); } } }),
      ));
    }
    return el;
  }
  pane.append(seg, list);
  load();
}

function modal(title, ...body) {
  const m = h("div", { class: "modal", onclick: (e) => { if (e.target === m) m.remove(); } }, h("div", {}, h("h2", { text: title }), ...body));
  document.body.append(m);
  return m;
}

async function rescheduleModal(b, done) {
  const cfg = await api("/api/public/config");
  let slot = null;
  const err = h("div");
  const go = h("button", { class: "btn", type: "button", disabled: true, text: "この日時に変更（お客様に通知）" });
  const picker = createPicker({ firstDate: cfg.firstDate, lastDate: cfg.lastDate, today: cfg.today,
    fetchDays: async (from, to) => (await api(`/api/admin/availability?from=${from}&to=${to}&exclude=${b.id}`)).days,
    onPick: (s) => { slot = s; go.disabled = !s; } });
  const m = modal("日時変更", h("p", { class: "hint", text: `現在：${fmtRange(b)}` }), picker.el, err, go,
    h("button", { class: "btn ghost", type: "button", text: "閉じる", onclick: () => m.remove() }));
  go.addEventListener("click", async () => {
    go.disabled = true;
    try { await api(`/api/admin/bookings/${b.id}/reschedule`, { method: "POST", body: slot }); m.remove(); done(); }
    catch (e) { go.disabled = false; clear(err).append(h("div", { class: "alert", text: e.message })); picker.refresh(); }
  });
}

function locationModal(b, done) {
  const err = h("div");
  const name = h("input", { type: "text", maxlength: "100", value: b.locationName });
  const addr = h("input", { type: "text", maxlength: "300", value: b.locationAddress });
  const m = modal("訪問場所の編集",
    h("label", { class: "f" }, "店舗名・施設名", name), h("label", { class: "f" }, "住所", addr),
    h("p", { class: "hint", text: "保存するとGoogleカレンダーの場所欄にも反映されます。" }), err,
    h("button", { class: "btn", type: "button", text: "保存", onclick: async () => {
      try { await api(`/api/admin/bookings/${b.id}`, { method: "PATCH", body: { locationName: name.value, locationAddress: addr.value } }); m.remove(); done(); }
      catch (e) { clear(err).append(h("div", { class: "alert", text: e.message })); }
    } }),
    h("button", { class: "btn ghost", type: "button", text: "閉じる", onclick: () => m.remove() }));
}

// ---- 予約設定 ----------------------------------------------------------------------
async function viewSettings(pane) {
  const [{ settings: s }, g] = await Promise.all([api("/api/admin/settings"), api("/api/admin/google/status")]);
  const wd = ["日", "月", "火", "水", "木", "金", "土"];
  const num = (k, label, o = {}) => h("label", { class: "f" }, label, h("input", { type: "number", id: `s-${k}`, value: s[k], min: o.min ?? 0, max: o.max, inputmode: "numeric" }), o.hint ? h("p", { class: "hint", text: o.hint }) : null);
  const txt = (k, label, o = {}) => h("label", { class: "f" }, label, o.area ? h("textarea", { id: `s-${k}` }, s[k]) : h("input", { type: "text", id: `s-${k}`, value: s[k] }), o.hint ? h("p", { class: "hint", text: o.hint }) : null);
  const chk = (k, label) => h("label", { class: "f" }, h("span", { class: "checks" }, h("label", {}, h("input", { type: "checkbox", id: `s-${k}`, checked: s[k] }), label)));
  const step = h("select", { id: "s-stepMin" }, [5, 10, 15, 20, 30, 60].map((n) => h("option", { value: n, selected: n === s.stepMin, text: `${n}分` })));
  const loc = h("select", { id: "s-visitLocationBy" }, [["customer", "お客様が入力（初期設定）"], ["admin", "管理者が後から指定"]].map(([v, t]) => h("option", { value: v, selected: v === s.visitLocationBy, text: t })));
  const target = h("select", { id: "s-targetCalendarId" }, g.calendars.length
    ? g.calendars.map((c) => { const v = c.primary ? "primary" : c.id; return h("option", { value: v, selected: v === s.targetCalendarId, text: c.summary + (c.primary ? "（メイン・初期設定）" : "") }); })
    : [h("option", { value: s.targetCalendarId, text: s.targetCalendarId })]);
  const busy = h("div", { class: "checks", id: "s-busy" }, g.calendars.filter((c) => !c.primary).map((c) => h("label", {}, h("input", { type: "checkbox", value: c.id, checked: s.busyCalendarIds.includes(c.id) }), c.summary)));
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    const v = (k) => $(`#s-${k}`).value, n = (k) => Number(v(k)), c = (k) => $(`#s-${k}`).checked;
    const body = {
      durationMin: n("durationMin"), stepMin: n("stepMin"), bufferBeforeMin: n("bufferBeforeMin"), bufferAfterMin: n("bufferAfterMin"),
      weekdays: [...document.querySelectorAll("#s-weekdays input:checked")].map((i) => Number(i.value)),
      dayStart: v("dayStart"), dayEnd: v("dayEnd"), horizonDays: n("horizonDays"), allowSameDay: c("allowSameDay"), cutoffMin: Math.round(n("cutoffHours") * 60),
      officeName: v("officeName"), officeAddress: v("officeAddress"), visitLocationBy: v("visitLocationBy"),
      busyCalendarIds: [...document.querySelectorAll("#s-busy input:checked")].map((i) => i.value), targetCalendarId: v("targetCalendarId"),
      googleInvite: c("googleInvite"), sendOwnMail: c("sendOwnMail"), adminNotifyEmail: v("adminNotifyEmail"), replyTo: v("replyTo"), privacyText: v("privacyText"),
    };
    try { await api("/api/admin/settings", { method: "PUT", body }); toast(pane, "保存しました"); } catch (x) { toast(pane, x.message, ""); }
  } },
    h("section", { class: "card" }, h("h2", { text: "受付できる日時" }),
      h("div", { class: "f" }, "予約を受け付ける曜日", h("div", { class: "checks", id: "s-weekdays" }, wd.map((w, i) => h("label", {}, h("input", { type: "checkbox", value: i, checked: s.weekdays.includes(i) }), w)))),
      h("div", { class: "grid2" }, h("label", { class: "f" }, "受付開始時刻", h("input", { type: "time", id: "s-dayStart", value: s.dayStart })), h("label", { class: "f" }, "受付終了時刻（この時刻までに終了）", h("input", { type: "time", id: "s-dayEnd", value: s.dayEnd }))),
      h("div", { class: "grid2" }, num("durationMin", "予約枠の長さ（分）", { min: 15, max: 480 }), h("label", { class: "f" }, "開始時刻の刻み幅", step)),
      h("div", { class: "grid2" }, num("bufferBeforeMin", "予約の前の余裕（分）"), num("bufferAfterMin", "予約の後の余裕（分）")),
      h("div", { class: "grid2" }, num("horizonDays", "何日先まで予約可能", { min: 1, max: 90 }),
        h("label", { class: "f" }, "締切（開始の何時間前まで）", h("input", { type: "number", id: "s-cutoffHours", value: s.cutoffMin / 60, min: 0, step: "0.5" }))),
      chk("allowSameDay", "当日の予約を受け付ける")),
    h("section", { class: "card" }, h("h2", { text: "開催場所" }), txt("officeName", "事務所名"), txt("officeAddress", "事務所住所", { hint: "「対面（事務所）」の予約画面・メール・Googleカレンダーの場所欄に表示されます。" }),
      h("label", { class: "f" }, "「店舗・指定場所」の場所の決め方", loc)),
    h("section", { class: "card" }, h("h2", { text: "Googleカレンダー" }),
      h("label", { class: "f" }, "予約の登録先カレンダー", target),
      h("div", { class: "f" }, "空き時間の判定に加えるカレンダー", h("p", { class: "hint", text: "登録先は常に判定されます。他のカレンダーの予定も避けたい場合に選びます。" }), busy),
      chk("googleInvite", "Googleカレンダーの招待通知をお客様に送る")),
    h("section", { class: "card" }, h("h2", { text: "メール" }), chk("sendOwnMail", "TUMIKIの確認メール（変更・キャンセルのリンク付き）を送る"),
      txt("adminNotifyEmail", "予約が入った時に通知を受け取るメール", { hint: "空欄なら通知しません" }), txt("replyTo", "返信先メールアドレス"),
      txt("privacyText", "個人情報の利用目的（予約画面に表示）", { area: true })),
    h("button", { class: "btn", type: "submit", text: "保存する" }),
  );
  pane.append(form);
}

// ---- Google連携 ----------------------------------------------------------------------
async function viewGoogle(pane) {
  pane.append(h("div", { class: "loading", text: "確認中…" }));
  const g = await api("/api/admin/google/status");
  clear(pane);
  const row = (k, v) => h("div", { class: "f" }, k, h("div", { text: v, class: "hint" }));
  const fmtTs = (t) => (t ? new Date(t).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "未実施");
  pane.append(
    h("section", { class: "card" }, h("h2", { text: "Googleアカウント" }),
      g.connected ? h("p", { class: "alert ok", text: `接続中：${g.account}` }) : h("p", { class: "alert", text: g.error || "未接続です" }),
      g.connected ? null : h("a", { class: "btn", href: "/api/admin/login?reconnect=1", text: "Googleアカウントを接続" }),
      g.connected ? h("a", { class: "btn ghost", href: "/api/admin/login?reconnect=1", text: "再接続（許可をやり直す）" }) : null,
      g.connected ? h("button", { class: "btn danger", type: "button", text: "連携を解除", onclick: async () => { if (!confirm("Googleとの連携を解除します。解除中は新しい予約を受け付けられません。")) return; await api("/api/admin/google/disconnect", { method: "POST" }); viewTab("google"); } }) : null),
    h("section", { class: "card" }, h("h2", { text: "同期の状態" }),
      row("カレンダー変更通知", g.watch.active ? `有効（期限 ${fmtTs(g.watch.expiration)}）` : g.publicBaseUrl.startsWith("https://") ? "未登録（「今すぐ同期」で登録）" : "HTTPSの公開URLが必要です"),
      row("最後の同期", g.lastSync ? fmtTs(g.lastSync * 1000) : "未実施"),
      h("button", { class: "btn ghost", type: "button", text: "今すぐ同期", onclick: async (e) => { e.target.disabled = true; try { const r = await api("/api/admin/google/sync", { method: "POST" }); toast(pane, `同期しました（キャンセル反映 ${r.result.cancelled}件・日時変更反映 ${r.result.moved}件）`); } catch (x) { toast(pane, x.message, ""); } e.target.disabled = false; } })),
    h("section", { class: "card" }, h("h2", { text: "メール送信" }),
      g.mailConfigured ? h("p", { class: "alert ok", text: `送信方法：${g.mailProvider === "gmail" ? "Gmail（連携アカウントから送信）" : "Resend"}` }) : h("p", { class: "alert warn", text: "メール送信が未設定です。docs/SETUP.md の手順で設定してください。" }),
      g.mailProvider === "gmail" && !g.gmailScope ? h("a", { class: "btn ghost", href: "/api/admin/login?reconnect=1&gmail=1", text: "Gmail送信を許可する" }) : null),
  );
}
function viewTab(k) { tab = k; shell(); }

// ---- メール履歴 ----------------------------------------------------------------------
async function viewMail(pane) {
  const r = await api("/api/admin/mail-log");
  const kinds = { confirmed: "予約確定", changed: "変更", cancelled: "キャンセル", admin_new: "管理者通知(新規)", admin_cancelled: "管理者通知(取消)" };
  pane.append(h("section", { class: "card" }, h("h2", { text: "最近のメール（失敗は赤）" }),
    r.logs.length ? h("table", { class: "log" }, h("tr", {}, ["日時", "種類", "宛先", "結果"].map((t) => h("th", { text: t }))),
      r.logs.map((l) => h("tr", {}, h("td", { text: new Date(l.created_at * 1000).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }) }), h("td", { text: kinds[l.kind] || l.kind }), h("td", { text: l.to_email }),
        h("td", {}, h("span", { class: `badge ${l.status === "sent" ? "" : "bad"}`, text: l.status === "sent" ? "送信済み" : "失敗" }), l.error ? h("div", { class: "meta", text: l.error }) : null)))) : h("div", { class: "empty", text: "まだありません" }),
    h("p", { class: "hint", text: "失敗したメールは、予約一覧の「お客様へ再通知」から再送できます。" })));
}

boot();
