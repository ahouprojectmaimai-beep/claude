import { describe, expect, it } from "vitest";
import { daySlots, rangeSlots } from "../src/lib/availability.ts";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings.ts";
import { addDays, formatRange, tsToDate, tsToHHMM, weekdayOf, zonedToTs } from "../src/lib/time.ts";
import { NOW } from "./helpers.ts";

const s = DEFAULT_SETTINGS;
const iv = (d: string, a: string, b: string) => ({ start: zonedToTs(d, a, s.timezone), end: zonedToTs(d, b, s.timezone) });

describe("time", () => {
  it("JSTの変換と表示", () => {
    const ts = zonedToTs("2026-10-20", "13:30", "Asia/Tokyo");
    expect(new Date(ts * 1000).toISOString()).toBe("2026-10-20T04:30:00.000Z");
    expect(tsToDate(ts, "Asia/Tokyo")).toBe("2026-10-20");
    expect(tsToHHMM(ts, "Asia/Tokyo")).toBe("13:30");
    expect(formatRange(ts, ts + 3600, "Asia/Tokyo")).toBe("10月20日（火）13:30〜14:30");
  });
  it("日付変更をまたぐ(UTC→JST)", () => {
    const ts = Date.parse("2026-10-20T16:00:00Z") / 1000;
    expect(tsToDate(ts, "Asia/Tokyo")).toBe("2026-10-21");
  });
  it("サマータイム地域でも正しい(America/New_York)", () => {
    expect(new Date(zonedToTs("2026-07-01", "09:00", "America/New_York") * 1000).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(new Date(zonedToTs("2026-12-01", "09:00", "America/New_York") * 1000).toISOString()).toBe("2026-12-01T14:00:00.000Z");
  });
  it("曜日・日付加算", () => {
    expect(weekdayOf("2026-10-20")).toBe(2);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
  });
});

describe("daySlots", () => {
  it("予定が無ければ10:00〜17:00開始(15分刻み・60分枠)", () => {
    const slots = daySlots(s, "2026-10-21", [], [], NOW);
    expect(slots[0]).toBe("10:00");
    expect(slots[1]).toBe("10:15");
    expect(slots.at(-1)).toBe("17:00"); // 18:00終了に収まる最後
    expect(slots).not.toContain("17:15");
  });
  it("既存予定と重なる開始時刻は出ない/どの開始時刻でも60分連続が条件", () => {
    const slots = daySlots(s, "2026-10-21", [iv("2026-10-21", "11:00", "12:00")], [], NOW);
    expect(slots).toContain("10:00"); // 10:00-11:00
    expect(slots).not.toContain("10:15"); // 10:15-11:15 は重なる
    expect(slots).not.toContain("11:45");
    expect(slots).toContain("12:00");
  });
  it("終日予定(その日全体が埋まる)", () => {
    const allDay = { start: zonedToTs("2026-10-21", "00:00", s.timezone), end: zonedToTs("2026-10-22", "00:00", s.timezone) };
    expect(daySlots(s, "2026-10-21", [allDay], [], NOW)).toEqual([]);
  });
  it("刻み幅を変更できる", () => {
    const s30 = normalizeSettings({ stepMin: 30 });
    const slots = daySlots(s30, "2026-10-21", [], [], NOW);
    expect(slots.slice(0, 3)).toEqual(["10:00", "10:30", "11:00"]);
  });
  it("前後の余裕時間", () => {
    const sb = normalizeSettings({ bufferBeforeMin: 30, bufferAfterMin: 30, stepMin: 15 });
    const slots = daySlots(sb, "2026-10-21", [iv("2026-10-21", "12:00", "13:00")], [], NOW);
    expect(slots).toContain("10:30"); // 終了11:30 + 余裕30分 = 12:00 ちょうどまで
    expect(slots).not.toContain("10:45");
    expect(slots).not.toContain("13:15"); // 13:00 + 余裕30分 = 13:30 から
    expect(slots).toContain("13:30");
  });
  it("曜日・過去・期間外・当日・締切", () => {
    expect(daySlots(s, "2026-10-24", [], [], NOW)).toEqual([]); // 土曜
    expect(daySlots(s, "2026-10-19", [], [], NOW)).toEqual([]); // 過去
    expect(daySlots(s, "2026-12-30", [], [], NOW)).toEqual([]); // 30日超
    const today = daySlots(s, "2026-10-20", [], [], NOW); // 現在9:00 + 2時間 = 11:00以降
    expect(today[0]).toBe("11:00");
    expect(daySlots(normalizeSettings({ allowSameDay: false }), "2026-10-20", [], [], NOW)).toEqual([]);
  });
  it("rangeSlots は空き日だけ返す", () => {
    const r = rangeSlots(s, "2026-10-21", "2026-10-26", [], [], NOW);
    expect(Object.keys(r)).toEqual(["2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26"]);
  });
});
