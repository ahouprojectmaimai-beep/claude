import { describe, expect, it } from "vitest";
import { applySubmission } from "../src/matching/engine";
import { Ledger, recordKey } from "../src/matching/ledger";
import { evaluateRecord } from "../src/matching/status";
import { loadDefaultCalendar, loadDefaultConfig } from "../src/config/load";
import { parseConfig } from "../src/config/config";
import type { RawExtraction } from "../src/extraction/schema";
import { analyze2, f, row } from "./helpers";

/**
 * 実際の書式（本番設定）で動くかの確認。金額はすべて架空。
 * - アホウどり4店舗: レジ精算（営業日・預入金・在高実績・翌準備金）
 * - ほりまる: funfo（レポート期間・銀行入金額・現金残高(点検)・繰越準備金）
 * - 通帳の摘要: 京都銀行「ATM」/ 京都信用金庫「ATM通帳」/ 京都中央信用金庫「預金機」
 */
const raw = structuredClone(loadDefaultConfig()) as any;
raw.cashCheck.clerkUserIds = ["U_clerk"];
const cfg = parseConfig(raw);
const ctx = { cfg, calendar: loadDefaultCalendar() };

function receipt(opts: { store: string; date: string; label: string; deposit: string; onHand: string; float: string; denoms: string[]; rows: RawExtraction["passbook_rows"] }): RawExtraction {
  return {
    document_type: "sales_report",
    image_quality: { blurry: false, obstructed: false, notes: "" },
    register_report: {
      store_name: f(opts.store),
      business_date: f(opts.date),
      deposit_amount: f(opts.deposit),
      deposit_amount_label: opts.label,
      cash_on_hand: f(opts.onHand),
      next_day_float: f(opts.float),
      denominations: opts.denoms.map((d, i) => ({ label: `金種${i}`, amount: d === "-" ? f("", "empty", 1) : f(d) })),
    },
    oil_receipt: null,
    passbook_rows: opts.rows,
  };
}

function judge(storeId: string, r: RawExtraction, businessDate: string, today: string) {
  const l = new Ledger();
  const analysis = analyze2(r, storeId, today, cfg);
  applySubmission(ctx, l, { sourceId: "s", storeId, postedOn: today, analysis });
  const rec = l.records.get(recordKey(storeId, businessDate));
  return { analysis, status: rec ? evaluateRecord(ctx, l, rec, today) : null };
}

describe("本番設定の書式", () => {
  it("ほりまる（funfo・京都信用金庫）: 振込の入金は売上の入金として扱わない", () => {
    const r = receipt({
      store: "元祖からあげ本舗ほりまる 堀川丸太町店",
      date: "2026年10月01日",
      label: "銀行入金額",
      deposit: "¥41,234",
      onHand: "¥91,234",
      float: "¥50,000",
      denoms: ["¥60,000", "-", "-", "¥10,000", "¥1,000", "¥10,100", "¥6,800", "¥2,400", "¥820", "¥114"],
      rows: [
        row("08.09.30", "*37,000", "¥100,000", { desc: "ATM通帳" }),
        row("08.10.02", "*41,234", "¥141,234", { desc: "振込 PAYPAY" }),
        row("08.10.02", "*41,234", "¥182,468", { desc: "ATM通帳" }),
      ],
    });
    const { analysis, status } = judge("horimaru", r, "2026-10-01", "2026-10-02");
    expect(analysis.issues).toEqual([]);
    expect(status).toMatchObject({ overall: "OK", deposited: 41234 });
  });

  it("京都銀行: 「繰越」行（日付が伏せ字・口座番号入り）を残高検算の起点にでき、口座番号は保存しない", () => {
    const carry = row("**-**-**", "", "*84,000", { desc: "繰越 999-99-1234567" });
    carry.date = f("**-**-**");
    const r = receipt({
      store: "アホウどり聖護院店",
      date: "2026/9/27 (日)",
      label: "預入金",
      deposit: "¥19,000",
      onHand: "¥69,000",
      float: "¥50,000",
      denoms: ["¥0", "¥0", "¥0", "¥0", "¥0", "¥0", "¥19,000", "¥0", "¥10,000", "¥40,000"],
      rows: [carry, row("08-09-28", "*19,000", "*103,000")],
    });
    const { analysis, status } = judge("shogoin", r, "2026-09-27", "2026-09-28");
    expect(analysis.issues).toEqual([]);
    expect(status?.overall).toBe("OK");
    expect(JSON.stringify(analysis.doc)).not.toContain("1234567");
  });

  it("京都中央信用金庫: 新しい通帳の1行目（繰越）が照合期間と同じ日付でも判定できる", () => {
    const carry = row("08.09.29", "", "¥27,000", { desc: "繰越" });
    const r = receipt({
      store: "アホウどり 京大前店",
      date: "2026/9/28 (月)",
      label: "預入金",
      deposit: "¥49,000",
      onHand: "¥99,000",
      float: "¥50,000",
      denoms: ["¥0", "¥0", "¥0", "¥0", "¥0", "¥0", "¥49,000", "¥0", "¥0", "¥50,000"],
      rows: [carry, row("08.09.29", "¥49,000", "¥76,000", { desc: "預金機" })],
    });
    const { analysis, status } = judge("kyodaimae", r, "2026-09-28", "2026-09-29");
    expect(analysis.issues).toEqual([]);
    expect(status?.overall).toBe("OK");
  });

  it("京都銀行: ポイント等の入金（摘要がATMでない）は売上の入金として扱わない", () => {
    const r = receipt({
      store: "アホウどり北野白梅町店",
      date: "2026/9/27 (日)",
      label: "預入金",
      deposit: "¥8,000",
      onHand: "¥58,000",
      float: "¥50,000",
      denoms: ["¥0", "¥0", "¥0", "¥0", "¥0", "¥0", "¥8,000", "¥0", "¥0", "¥50,000"],
      rows: [row("08-09-27", "*1,000", "*101,000"), row("08-09-28", "*8,000", "*109,000", { desc: "リクルートポイントプロク" })],
    });
    expect(judge("hakubaicho", r, "2026-09-27", "2026-09-28").status?.overall).toBe("NEEDS_REVIEW");
  });

  it("funfo の項目名（現金残高(点検) など）は全角かっこ・空白の違いを区別しない", () => {
    const r = receipt({
      store: "ほりまる",
      date: "2026年09月28日",
      label: "銀行 入金額",
      deposit: "¥30,500",
      onHand: "¥80,500",
      float: "¥50,000",
      denoms: ["¥80,500"],
      rows: [row("08.09.28", "*1,000", "¥10,000", { desc: "ATM通帳" }), row("08.09.29", "*30,500", "¥40,500", { desc: "ＡＴＭ通帳" })],
    });
    expect(judge("horimaru", r, "2026-09-28", "2026-09-29").status?.overall).toBe("OK");
  });
});
