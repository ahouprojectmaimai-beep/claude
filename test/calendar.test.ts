import { describe, expect, it } from "vitest";
import { resolveYear, todayJST } from "../src/domain/calendar";
import { loadDefaultCalendar } from "../src/config/load";

const cal = loadDefaultCalendar();

describe("年の表記（書類ごとに設定で決める）", () => {
  it("和暦2桁: 08 → 令和8年 = 2026", () => expect(resolveYear("08", "reiwa2")).toBe(2026));
  it("西暦2桁: 26 → 2026", () => expect(resolveYear("26", "western2")).toBe(2026));
  it("西暦4桁", () => expect(resolveYear("2026", "western4")).toBe(2026));
  it("形式が合わなければ null", () => {
    expect(resolveYear("2026", "western2")).toBeNull();
    expect(resolveYear("26", "western4")).toBeNull();
  });
});

describe("銀行営業日", () => {
  it("2026年シルバーウィーク(9/19〜9/23)明けは 9/24", () => {
    expect(cal.nextBankBusinessDayAfter("2026-09-18")).toBe("2026-09-24");
    expect(cal.nextBankBusinessDayAfter("2026-09-22")).toBe("2026-09-24");
    expect(cal.firstBankBusinessDayOnOrAfter("2026-09-22")).toBe("2026-09-24");
  });
  it("平日はその日", () => expect(cal.firstBankBusinessDayOnOrAfter("2026-09-29")).toBe("2026-09-29"));
  it("年末年始(12/31〜1/3)は休業", () => expect(cal.nextBankBusinessDayAfter("2026-12-30")).toBe("2027-01-04"));
  it("3銀行営業日後", () => expect(cal.addBankBusinessDays("2026-09-18", 3)).toBe("2026-09-28"));
  it("JSTの今日", () => expect(todayJST(new Date("2026-10-02T15:30:00Z"))).toBe("2026-10-03"));
});
