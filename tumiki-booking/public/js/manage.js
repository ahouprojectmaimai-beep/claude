import { $, api, clear, createPicker, fmtRange, h, MODE_LABEL } from "./common.js";

const app = $("#app"), brand = $("header.brand");
const q = new URLSearchParams(location.search);
const id = q.get("b") || "", t = q.get("t") || "";
const base = `/api/public/bookings/${encodeURIComponent(id)}`;
const mount = (...n) => { clear(app).append(brand, ...n.flat().filter(Boolean)); window.scrollTo(0, 0); };

async function load() {
  let r, cfg;
  try { [r, cfg] = await Promise.all([api(`${base}?t=${encodeURIComponent(t)}`), api("/api/public/config")]); }
  catch (e) { return mount(h("h1", { text: "予約の確認" }), h("p", { class: "alert", text: e.message })); }
  view(r.booking, r.canChange, cfg);
}

function view(b, canChange, cfg) {
  const dl = h("dl", { class: "sum" });
  const add = (k, v) => { if (v) dl.append(h("dt", { text: k }), h("dd", { text: v })); };
  add("日時", fmtRange(b)); add("開催方法", MODE_LABEL[b.mode]);
  if (b.mode === "online") add("参加URL", b.meetUrl);
  else add("開催場所", [b.locationName, b.addressUnconfirmed || !b.locationAddress ? "※場所の詳細は確認のうえ、改めてご連絡します。" : b.locationAddress].filter(Boolean).join("\n"));
  add("お名前", b.name); add("会社名・店舗名", b.company); add("メールアドレス", b.email);
  const cancelled = b.status !== "confirmed";
  const err = h("div");
  mount(
    h("h1", { text: cancelled ? "この予約はキャンセル済みです" : "ご予約の内容" }),
    h("section", { class: "card" }, dl),
    err,
    cancelled ? h("a", { class: "btn", href: "/", text: "あらためて予約する" }) : [
      canChange ? h("button", { class: "btn", type: "button", text: "日時を変更する", onclick: () => reschedule(b, cfg) }) : h("p", { class: "alert warn", text: "開始時刻が近いため、オンラインでの変更・キャンセルはできません。お手数ですが直接ご連絡ください。" }),
      canChange ? h("button", { class: "btn danger", type: "button", text: "予約をキャンセルする", onclick: async (e) => {
        if (!confirm("この予約をキャンセルします。よろしいですか？")) return;
        e.target.disabled = true;
        try { await api(`${base}/cancel`, { method: "POST", body: { t } }); load(); } catch (x) { e.target.disabled = false; clear(err).append(h("div", { class: "alert", text: x.message })); }
      } }) : null,
    ],
  );
}

function reschedule(b, cfg) {
  let slot = null;
  const err = h("div");
  const go = h("button", { class: "btn", type: "button", disabled: true, text: "この日時に変更する" });
  const picker = createPicker({
    firstDate: cfg.firstDate, lastDate: cfg.lastDate, today: cfg.today,
    fetchDays: async (from, to) => (await api(`${base}/availability?t=${encodeURIComponent(t)}&from=${from}&to=${to}`)).days,
    onPick: (s) => { slot = s; go.disabled = !s; },
  });
  go.addEventListener("click", async () => {
    go.disabled = true; clear(err);
    try { await api(`${base}/reschedule`, { method: "POST", body: { t, ...slot } }); load(); }
    catch (e) { go.disabled = false; clear(err).append(h("div", { class: "alert", text: e.message })); picker.refresh(); }
  });
  mount(h("h1", { text: "日時の変更" }), h("p", { class: "lead", text: `現在：${fmtRange(b)}` }), h("section", { class: "card" }, picker.el), err, go,
    h("button", { class: "btn ghost", type: "button", text: "戻る", onclick: load }));
}

load();
