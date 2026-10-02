import { describe, expect, it } from "vitest";
import { analyzeExtractions } from "../src/pipeline/analyze";
import { loadDefaultConfig } from "../src/config/load";
import { parseConfig } from "../src/config/config";
import { analyze2, ex, f, passbook, salesRaw, testConfig } from "./helpers";

const TODAY = "2026-09-29";
const doshisha = (over: Partial<Parameters<typeof salesRaw>[0]> = {}) =>
  salesRaw({
    storeName: "アホウどり 同志社前店",
    businessDate: "2026/9/28 (月)",
    deposit: 65320,
    onHand: 115320,
    float: 50000,
    denoms: [270, 50, 2000, 68000, 15000, 30000],
    rows: passbook(200000, [["08-09-28", 55000], ["08-09-29", 65000]]),
    ...over,
  });

const codes = (r: { issues: { code: string }[] }) => r.issues.map((i) => i.code);

describe("画像解析の安全装置", () => {
  it("正常な画像は問題なし", () => {
    const r = analyze2(doshisha(), "doshisha", TODAY);
    expect(r.issues).toEqual([]);
    expect(r.severity).toBe("ok");
    expect(r.doc?.kind).toBe("sales");
    if (r.doc?.kind === "sales") {
      expect(r.doc.businessDate).toBe("2026-09-28");
      expect(r.doc.depositAmount).toBe(65320);
      expect(r.doc.rows.at(-1)).toMatchObject({ date: "2026-09-29", deposit: 65000, chainVerified: true });
    }
  });

  it("ボヤけた写真は「画像判読不能」", () => {
    const raw = doshisha();
    raw.image_quality.blurry = true;
    expect(analyze2(raw, "doshisha", TODAY).severity).toBe("unreadable");
  });

  it("1桁でも自信がない欄があれば「画像判読不能」", () => {
    const raw = doshisha();
    raw.register_report!.deposit_amount = f("¥65,320", "unclear", 0.6);
    expect(analyze2(raw, "doshisha", TODAY).severity).toBe("unreadable");
  });

  it("confidence が閾値未満なら「画像判読不能」", () => {
    const raw = doshisha();
    raw.register_report!.business_date = f("2026/9/28", "clear", 0.5);
    expect(analyze2(raw, "doshisha", TODAY).severity).toBe("unreadable");
  });

  it("2系統の読み取りが食い違えば「画像判読不能」", () => {
    const r = analyze2(doshisha(), "doshisha", TODAY, testConfig(), doshisha({ deposit: 65820 }));
    expect(r.severity).toBe("unreadable");
    expect(codes(r)).toContain("FIELDS_DISAGREE");
  });

  it("読み取りが1系統しかなければOKにしない", () => {
    const r = analyzeExtractions([ex(doshisha())], "doshisha", testConfig(), TODAY);
    expect(r.severity).toBe("unreadable");
  });

  it("AI呼び出しが失敗したら要確認", () => {
    const r = analyzeExtractions([ex(doshisha()), ex(null, "B", "timeout")], "doshisha", testConfig(), TODAY);
    expect(r.severity).toBe("review");
    expect(r.doc).toBeNull();
  });

  it("通帳の行が2系統で食い違えば、その行は照合に使わない（disputed）", () => {
    const b = doshisha();
    b.passbook_rows.at(-1)!.deposit = f("*66,000");
    b.passbook_rows.at(-1)!.balance = f("*322,000");
    const r = analyze2(doshisha(), "doshisha", TODAY, testConfig(), b);
    expect(r.doc?.rows.filter((x) => x.disputed).length).toBe(2);
  });

  it("残高の計算が合わない行は検証済みにしない", () => {
    const raw = doshisha();
    raw.passbook_rows.at(-1)!.deposit = f("*56,000");
    const r = analyze2(raw, "doshisha", TODAY);
    expect(r.doc?.rows.at(-1)?.chainVerified).toBe(false);
  });

  it("レジ精算票の検算（在高実績−翌準備金）が合わなければ要確認", () => {
    const r = analyze2(doshisha({ float: 40000 }), "doshisha", TODAY);
    expect(codes(r)).toContain("RECEIPT_FLOAT_MISMATCH");
    expect(r.severity).toBe("review");
  });

  it("金種の合計が合わなければ要確認", () => {
    const r = analyze2(doshisha({ denoms: [270, 50, 2000, 68000, 15000, 20000] }), "doshisha", TODAY);
    expect(codes(r)).toContain("RECEIPT_DENOM_MISMATCH");
  });

  it("投稿の店舗名と画像内の店舗名が違えば要確認", () => {
    const r = analyze2(doshisha(), "hakubaicho", TODAY);
    expect(codes(r)).toContain("STORE_MISMATCH");
  });

  it("書式未登録の店舗は必ず要確認", () => {
    const raw = structuredClone(loadDefaultConfig()) as any;
    raw.stores.find((s: any) => s.id === "kyodaimae").receipt.labels = null;
    const r = analyze2(salesRaw({ businessDate: "2026/9/28", deposit: 1000, rows: passbook(0, [["08-09-29", 1000]]) }), "kyodaimae", TODAY, parseConfig(raw));
    expect(codes(r)).toContain("RECEIPT_FORMAT_UNREGISTERED");
  });

  it("入金対象の項目名が設定と違えば要確認", () => {
    const r = analyze2(doshisha({ label: "現金受領" }), "doshisha", TODAY);
    expect(codes(r)).toContain("DEPOSIT_LABEL_MISMATCH");
  });

  it("営業日が想定範囲外（未来・古すぎ）なら要確認", () => {
    expect(codes(analyze2(doshisha({ businessDate: "2026/10/28" }), "doshisha", TODAY))).toContain("DATE_OUT_OF_RANGE");
    expect(codes(analyze2(doshisha({ businessDate: "2025/9/28" }), "doshisha", TODAY))).toContain("DATE_OUT_OF_RANGE");
  });

  it("書類の種類が不明なら要確認", () => {
    const raw = doshisha();
    raw.document_type = "other";
    expect(analyze2(raw, "doshisha", TODAY).severity).not.toBe("ok");
  });
});
