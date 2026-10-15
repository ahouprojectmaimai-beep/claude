// 共通: DOM生成(textContent のみ使用=XSS対策)・API・カレンダー選択
export const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
export const $ = (s, r = document) => r.querySelector(s);
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export async function api(path, { method = "GET", body } = {}) {
  const r = await fetch(path, {
    method, credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch { /* 空レスポンス */ }
  if (!r.ok) { const e = new Error(data.message || "エラーが発生しました"); e.status = r.status; e.data = data; throw e; }
  return data;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
export const MODE_LABEL = { online: "オンライン（Google Meet）", office: "対面（事務所）", visit: "対面（店舗・指定場所）" };
export const fmtDate = (d) => { const [y, m, dd] = d.split("-").map(Number); return `${m}月${dd}日（${WD[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}）`; };
export const fmtRange = (b) => `${fmtDate(b.date)} ${b.time}〜${b.endTime}`;
export const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** 日付→時間を選ぶピッカー。fetchDays(from,to) は {日付: [時刻...]} を返す */
export function createPicker({ firstDate, lastDate, today, fetchDays, onPick }) {
  const root = h("div");
  const cache = new Map(); // "YYYY-MM" -> days
  let [vy, vm] = firstDate.split("-").map(Number);
  let selDate = null, selTime = null;
  const lastYM = lastDate.slice(0, 7), firstYM = firstDate.slice(0, 7);

  async function month(y, m) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (!cache.has(key)) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      cache.set(key, await fetchDays(ymd(y, m, 1), ymd(y, m, last)));
    }
    return cache.get(key);
  }

  async function render() {
    const key = `${vy}-${String(vm).padStart(2, "0")}`;
    clear(root).append(h("div", { class: "loading", text: "空き状況を確認中…" }));
    let days;
    try { days = await month(vy, vm); } catch (e) { clear(root).append(h("div", { class: "alert", text: e.message })); return; }
    const first = new Date(Date.UTC(vy, vm - 1, 1)).getUTCDay();
    const dim = new Date(Date.UTC(vy, vm, 0)).getUTCDate();
    const cells = WD.map((w) => h("div", { class: "cal-dow", text: w }));
    for (let i = 0; i < first; i++) cells.push(h("div"));
    for (let d = 1; d <= dim; d++) {
      const date = ymd(vy, vm, d), ok = !!days[date]?.length;
      cells.push(h("button", {
        type: "button", class: `cal-day${ok ? " ok" : ""}${date === selDate ? " sel" : ""}${date === today ? " today" : ""}`,
        disabled: !ok, "aria-label": `${fmtDate(date)}${ok ? "" : "（予約不可）"}`, text: String(d),
        onclick: () => { selDate = date; selTime = null; onPick(null); render(); },
      }));
    }
    const nav = (dy, label, dis) => h("button", { type: "button", class: "cal-nav", "aria-label": label, disabled: dis, onclick: () => { vm += dy; if (vm < 1) { vm = 12; vy--; } if (vm > 12) { vm = 1; vy++; } render(); } }, dy < 0 ? "‹" : "›");
    const times = selDate && days[selDate] ? days[selDate] : [];
    clear(root).append(...[
      h("div", { class: "cal-head" }, nav(-1, "前の月", key <= firstYM), h("b", { text: `${vy}年${vm}月` }), nav(1, "次の月", key >= lastYM)),
      h("div", { class: "cal-grid" }, cells),
      Object.keys(days).length === 0 ? h("div", { class: "empty", text: "この月に予約できる日はありません。次の月をご確認ください。" }) : null,
      selDate ? h("div", { class: "hint center", text: `${fmtDate(selDate)} のご都合の良い時間を選んでください` }) : null,
      selDate ? h("div", { class: "times" }, times.map((t) => h("button", {
        type: "button", class: "time", "aria-pressed": String(t === selTime), text: t,
        onclick: () => { selTime = t; onPick({ date: selDate, time: t }); render(); },
      }))) : null,
    ].filter(Boolean));
  }
  render();
  return { el: root, refresh: () => { cache.clear(); return render(); }, get value() { return selDate && selTime ? { date: selDate, time: selTime } : null; } };
}
