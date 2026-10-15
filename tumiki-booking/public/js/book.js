import { $, api, clear, createPicker, fmtRange, h, MODE_LABEL } from "./common.js";

const app = $("#app");
const brand = $("header.brand");
const state = { cfg: null, mode: null, slot: null, picker: null };
const val = (id) => ($(`#${id}`)?.value ?? "").trim();

function mount(...nodes) { clear(app).append(brand, ...nodes.flat().filter(Boolean)); window.scrollTo(0, 0); }

async function boot() {
  try { state.cfg = await api("/api/public/config"); } catch (e) { return mount(h("p", { class: "alert", text: e.message })); }
  if (!state.cfg.ready) return mount(h("h1", { text: "お打ち合わせのご予約" }), h("p", { class: "alert warn", text: "ただいま準備中です。しばらくしてからもう一度お試しください。" }));
  renderForm();
}

function sectionTitle(n, t) { return h("h2", {}, h("span", { class: "step", text: n }), t); }

function renderForm() {
  const cfg = state.cfg;
  const modeBtns = [
    ["online", "オンライン", "Google Meet で参加（URLをお送りします）"],
    ["office", "対面（事務所）", "TUMIKI事務所にお越しください"],
    ["visit", "対面（店舗・指定場所）", cfg.visitLocationBy === "customer" ? "ご指定の店舗・場所に伺います" : "場所は担当者から改めてご相談します"],
  ].map(([m, t, sub]) => h("button", { type: "button", class: "mode", "aria-pressed": "false", "data-mode": m, onclick: () => pickMode(m) }, h("b", { text: t }), h("small", { text: sub })));

  const picker = createPicker({
    firstDate: cfg.firstDate, lastDate: cfg.lastDate, today: cfg.today,
    fetchDays: async (from, to) => (await api(`/api/public/availability?from=${from}&to=${to}`)).days,
    onPick: (s) => { state.slot = s; unlock("s-info", !!s); updateSubmit(); },
  });
  state.picker = picker;

  mount(
    h("h1", { text: "お打ち合わせのご予約" }),
    h("p", { class: "lead", text: "ご都合の良い日時をお選びください" }),
    h("p", { class: "center" }, h("span", { class: "chip-info", text: `所要時間：約${cfg.durationMin}分` })),

    h("section", { class: "card", id: "s-mode" }, sectionTitle("1", "開催方法"), h("div", { class: "modes" }, modeBtns), h("div", { id: "mode-extra" })),
    h("section", { class: "card locked", id: "s-date" }, sectionTitle("2", "日にち・時間"), picker.el),
    h("section", { class: "card locked", id: "s-info" },
      sectionTitle("3", "お客様情報"),
      field("name", "お名前", "text", { req: true, ph: "山田 太郎", ac: "name" }),
      field("email", "メールアドレス", "email", { req: true, ph: "example@mail.com", ac: "email", inputmode: "email" }),
      field("company", "会社名・店舗名", "text", { opt: true, ph: "株式会社〇〇", ac: "organization" }),
      h("label", { class: "f" }, "ご相談内容・備考", h("span", { class: "opt", text: "任意" }), h("textarea", { id: "note", maxlength: "1000", placeholder: "事前に共有しておきたいことがあればご記入ください" })),
      h("div", { class: "hp", "aria-hidden": "true" }, h("label", {}, "Website", h("input", { type: "text", id: "website", tabindex: "-1", autocomplete: "off" }))),
      h("p", { class: "privacy", text: cfg.privacyText }),
    ),
    h("div", { id: "form-err" }),
    h("button", { type: "button", class: "btn", id: "to-confirm", disabled: true, onclick: renderConfirm, text: "内容を確認する" }),
  );
  $("#email").addEventListener("blur", () => checkEmail());
  for (const id of ["name", "email"]) $(`#${id}`).addEventListener("input", updateSubmit);
}

function field(id, label, type, o) {
  return h("label", { class: "f" }, label, h("span", { class: o.req ? "req" : "opt", text: o.req ? "必須" : "任意" }),
    h("input", { type, id, placeholder: o.ph, autocomplete: o.ac, inputmode: o.inputmode, maxlength: "200", required: !!o.req }),
    h("div", { class: "err", id: `${id}-err`, hidden: true }));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function checkEmail() {
  const bad = val("email") && !EMAIL_RE.test(val("email"));
  const e = $("#email-err"); e.hidden = !bad; e.textContent = bad ? "メールアドレスの形式をご確認ください" : "";
  return !bad;
}

function unlock(id, on) { $(`#${id}`).classList.toggle("locked", !on); }

function pickMode(m) {
  state.mode = m;
  for (const b of document.querySelectorAll(".mode")) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
  const extra = clear($("#mode-extra")), cfg = state.cfg;
  if (m === "office") {
    extra.append(h("div", { class: "addr" }, `${cfg.office.name}\n${cfg.office.address || "（住所は確定後にご案内します）"}`));
  } else if (m === "visit" && cfg.visitLocationBy === "customer") {
    extra.append(
      h("label", { class: "f" }, "店舗名・施設名", h("span", { class: "req", text: "必須" }), h("input", { type: "text", id: "locName", maxlength: "100", placeholder: "例：〇〇店" })),
      h("label", { class: "f" }, "住所", h("span", { class: "opt", text: "任意" }), h("input", { type: "text", id: "locAddr", maxlength: "300", placeholder: "例：京都市上京区…" }), h("p", { class: "hint", text: "住所がわからなければ、店舗名だけでも大丈夫です。" })),
    );
    $("#locName").addEventListener("input", updateSubmit);
  } else if (m === "visit") {
    extra.append(h("div", { class: "addr", text: "訪問場所は、ご予約後に担当者から改めてご相談します。" }));
  }
  unlock("s-date", true);
  updateSubmit();
}

function updateSubmit() {
  const okMode = state.mode && (state.mode !== "visit" || state.cfg.visitLocationBy !== "customer" || val("locName"));
  const ok = okMode && state.slot && val("name") && EMAIL_RE.test(val("email"));
  const b = $("#to-confirm"); if (b) b.disabled = !ok;
}

function payload() {
  return {
    mode: state.mode, date: state.slot.date, time: state.slot.time, name: val("name"), email: val("email"), company: val("company"),
    note: $("#note")?.value.trim() ?? "", locationName: val("locName"), locationAddress: val("locAddr"), website: val("website"),
  };
}

function placeLines(p) {
  if (p.mode === "online") return "Google Meet（確定後にURLをお送りします）";
  if (p.mode === "office") return `${state.cfg.office.name}\n${state.cfg.office.address}`.trim();
  if (state.cfg.visitLocationBy === "admin") return "担当者から改めてご相談します";
  return [p.locationName, p.locationAddress || "（住所は後ほど確認します）"].join("\n");
}

function renderConfirm() {
  if (!checkEmail()) return;
  const p = payload();
  const dl = h("dl", { class: "sum" });
  const add = (t, v) => { if (v) dl.append(h("dt", { text: t }), h("dd", { text: v })); };
  add("日時", fmtRange({ date: p.date, time: p.time, endTime: addMin(p.time, state.cfg.durationMin) }));
  add("開催方法", MODE_LABEL[p.mode]);
  add("場所", placeLines(p));
  add("お名前", p.name); add("メールアドレス", p.email); add("会社名・店舗名", p.company); add("ご相談内容", p.note);
  const err = h("div");
  const submit = h("button", { type: "button", class: "btn", text: "予約を確定する" });
  submit.addEventListener("click", async () => {
    submit.disabled = true; submit.textContent = "予約を確定しています…"; clear(err);
    try {
      const r = await api("/api/public/bookings", { method: "POST", body: p });
      renderDone(r);
    } catch (e) {
      submit.disabled = false; submit.textContent = "予約を確定する";
      err.append(h("div", { class: "alert", text: e.message }));
      if (e.status === 409) { err.append(h("button", { type: "button", class: "btn ghost", text: "日時を選び直す", onclick: backToForm })); }
    }
  });
  mount(h("h1", { text: "予約内容のご確認" }), h("section", { class: "card" }, dl), err, submit,
    h("button", { type: "button", class: "btn ghost", text: "戻って修正する", onclick: backToForm }),
    h("p", { class: "privacy", text: state.cfg.privacyText }));
}

function addMin(hhmm, min) { const [h0, m0] = hhmm.split(":").map(Number); const t = h0 * 60 + m0 + min; return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; }

function backToForm() {
  const keep = state.mode && state.slot ? { ...payload() } : null;
  renderForm();
  if (!keep) return;
  pickMode(keep.mode);
  for (const [id, v] of [["name", keep.name], ["email", keep.email], ["company", keep.company], ["note", keep.note], ["locName", keep.locationName], ["locAddr", keep.locationAddress]]) { const el = $(`#${id}`); if (el) el.value = v; }
  unlock("s-info", false); state.slot = null; updateSubmit();
  state.picker.refresh(); // 最新の空きを再取得
}

function renderDone({ booking: b, manageUrl }) {
  if (!b) return mount(h("h1", { text: "ありがとうございました" }));
  const dl = h("dl", { class: "sum" });
  const add = (t, v) => { if (v) dl.append(h("dt", { text: t }), h("dd", { text: v })); };
  add("日時", fmtRange(b)); add("開催方法", MODE_LABEL[b.mode]);
  if (b.mode === "online") add("参加URL", b.meetUrl);
  else if (b.mode === "office") add("開催場所", `${b.locationName}\n${b.locationAddress}`.trim());
  else add("開催場所", b.addressUnconfirmed || !b.locationAddress ? `${b.locationName}\n※場所の詳細は確認のうえ、改めてご連絡します。` : `${b.locationName}\n${b.locationAddress}`);
  mount(
    h("div", { class: "center" }, h("div", { class: "done-icon", text: "✓" }), h("h1", { text: "ご予約が確定しました" }),
      h("p", { class: "lead", text: `${b.email} に確認メールをお送りしました` })),
    h("section", { class: "card" }, dl),
    h("a", { class: "btn ghost", href: manageUrl, text: "予約の確認・変更・キャンセル" }),
    h("p", { class: "privacy center", text: "メールが届かない場合は、迷惑メールフォルダもご確認ください。" }),
  );
}

boot();
