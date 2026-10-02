import type { ExtractionRecord, Field, PassbookRow, RawExtraction } from "../src/extraction/schema";
import { loadDefaultCalendar, loadDefaultConfig } from "../src/config/load";
import { parseConfig, type AppConfig } from "../src/config/config";
import { analyzeExtractions } from "../src/pipeline/analyze";
import type { EngineContext } from "../src/matching/engine";

/** テストデータはすべて架空の金額・残高（実際の通帳の値は使わない） */

export function f(text: string, legibility: Field["legibility"] = "clear", confidence = 0.99): Field {
  return { text, legibility, confidence };
}
export const empty = (): Field => f("", "empty", 1);

export function row(date: string, deposit: string, balance: string, opts: { withdrawal?: string; desc?: string; note?: string } = {}): PassbookRow {
  return {
    line_no: "",
    date: f(date),
    description: opts.desc ?? "ATM",
    withdrawal: opts.withdrawal ? f(opts.withdrawal) : empty(),
    deposit: deposit ? f(deposit) : empty(),
    balance: f(balance),
    handwritten_note: opts.note ?? "",
  };
}

/** 残高を自動計算して通帳行を作る（[日付(和暦), お預り] の並び） */
export function passbook(start: number, entries: [string, number][]): PassbookRow[] {
  let bal = start;
  // 残高計算の起点となる行（その月の1日付け。照合期間に入らないようにする）
  const opening = entries[0]![0].replace(/(\d+)$/, "01");
  const rows: PassbookRow[] = [row(opening, "1,000", `*${bal.toLocaleString("en-US")}`, { desc: "ATM" })];
  for (const [d, amt] of entries) {
    bal += amt;
    rows.push(row(d, `*${amt.toLocaleString("en-US")}`, `*${bal.toLocaleString("en-US")}`));
  }
  return rows;
}

export function salesRaw(opts: {
  storeName?: string;
  businessDate: string;
  deposit: number;
  label?: string;
  onHand?: number;
  float?: number;
  denoms?: number[];
  rows: PassbookRow[];
}): RawExtraction {
  return {
    document_type: "sales_report",
    image_quality: { blurry: false, obstructed: false, notes: "" },
    register_report: {
      store_name: f(opts.storeName ?? ""),
      business_date: f(opts.businessDate),
      deposit_amount: f(`¥${opts.deposit.toLocaleString("en-US")}`),
      deposit_amount_label: opts.label ?? "預入金",
      cash_on_hand: opts.onHand !== undefined ? f(`¥${opts.onHand.toLocaleString("en-US")}`) : empty(),
      next_day_float: opts.float !== undefined ? f(`¥${opts.float.toLocaleString("en-US")}`) : empty(),
      denominations: (opts.denoms ?? []).map((v, i) => ({ label: `金種${i}`, amount: f(`¥${v.toLocaleString("en-US")}`) })),
    },
    oil_receipt: null,
    passbook_rows: opts.rows,
  };
}

export function oilRaw(opts: { addressee?: string; date: string; amount: string; bottles?: string; rows: PassbookRow[] }): RawExtraction {
  return {
    document_type: "oil_receipt",
    image_quality: { blurry: false, obstructed: false, notes: "" },
    register_report: null,
    oil_receipt: { addressee: f(opts.addressee ?? ""), date: f(opts.date), bottles: f(opts.bottles ?? "3本"), amount: f(opts.amount) },
    passbook_rows: opts.rows,
  };
}

export function ex(raw: RawExtraction | null, id = "A", error: string | null = null): ExtractionRecord {
  return { extractorId: id, model: "test", promptVersion: "test", startedAt: "", finishedAt: "", result: raw, error };
}

/** 全店舗の書式を登録済みにしたテスト用設定（本番設定は書式未登録の店舗あり） */
export function testConfig(overrides: (raw: any) => void = () => {}): AppConfig {
  const raw = structuredClone(loadDefaultConfig()) as any;
  for (const s of raw.stores) {
    if (s.receipt.depositLabel === null) {
      s.receipt.depositLabel = "預入金";
      s.receipt.allowWithoutChecks = true;
    }
  }
  raw.cashCheck.clerkUserIds = ["U_clerk"];
  overrides(raw);
  return parseConfig(raw);
}

export function testCtx(cfg: AppConfig = testConfig()): EngineContext {
  return { cfg, calendar: loadDefaultCalendar() };
}

/** 2系統が同じ結果を返したとして解析する */
export function analyze2(raw: RawExtraction, storeId: string, today: string, cfg = testConfig(), rawB: RawExtraction = raw) {
  return analyzeExtractions([ex(raw, "A"), ex(structuredClone(rawB), "B")], storeId, cfg, today);
}
