import { describe, expect, it } from "vitest";
import { applySubmission } from "../src/matching/engine";
import { Ledger, recordKey } from "../src/matching/ledger";
import { evaluateRecord, type OverallStatus } from "../src/matching/status";
import type { Field, RawExtraction } from "../src/extraction/schema";
import { parseConfig } from "../src/config/config";
import { loadDefaultConfig } from "../src/config/load";
import { analyze2, passbook, salesRaw, testConfig, testCtx } from "./helpers";

/**
 * 「AIが誤読したのにOKになる」を防ぐテスト。
 * 数字を1桁ずつ、あり得るすべての数字に読み間違えさせて網羅的に確認する。
 *
 * 1. 本当は入金が合っていない日 → どんな誤読でも OK 系にならない
 * 2. 本当に合っている日 → 誤読があっても「間違った数字のまま OK」にはならない
 */
const ctx = testCtx();
const POSITIVE: OverallStatus[] = ["OK", "FINAL_CONFIRMED", "CLERK_PENDING", "COIN_PENDING"];

function digitMutations(text: string): string[] {
  const out: string[] = [];
  [...text].forEach((ch, i) => {
    if (!/\d/.test(ch)) return;
    for (let d = 0; d <= 9; d++) if (String(d) !== ch) out.push(text.slice(0, i) + d + text.slice(i + 1));
  });
  return out;
}

interface Outcome {
  status: OverallStatus | "NO_RECORD";
  target: number | null;
  deposited: number;
}

function run(c: typeof ctx, storeId: string, a: RawExtraction, b: RawExtraction, businessDate: string, today: string): Outcome {
  const l = new Ledger();
  applySubmission(c, l, { sourceId: "s", storeId, postedOn: today, analysis: analyze2(a, storeId, today, c.cfg, b) });
  const rec = l.records.get(recordKey(storeId, businessDate));
  if (!rec) return { status: "NO_RECORD", target: null, deposited: 0 };
  const s = evaluateRecord(c, l, rec, today);
  return { status: s.overall, target: s.target, deposited: s.deposited };
}

interface Scenario {
  name: string;
  storeId: string;
  businessDate: string;
  today: string;
  make: () => RawExtraction;
  truth: { status: OverallStatus; target: number; deposited: number };
  /** 2系統が同じ誤読をする場合もテストするか（日計表の検算がある店舗のみ保証できる） */
  correlated: boolean;
}

const doshisha = (bank: number): Scenario => ({
  name: `同志社前（検算あり）入金 ${bank}円`,
  storeId: "doshisha",
  businessDate: "2026-09-28",
  today: "2026-09-29",
  correlated: true,
  make: () =>
    salesRaw({
      storeName: "アホウどり 同志社前店",
      businessDate: "2026/9/28 (月)",
      deposit: 65320,
      onHand: 115320,
      float: 50000,
      denoms: [270, 50, 2000, 68000, 15000, 30000],
      rows: passbook(200000, [["08-09-28", 55000], ["08-09-29", bank], ["08-09-30", 61000]]),
    }),
  truth: bank === 65000 ? { status: "CLERK_PENDING", target: 65320, deposited: 65000 } : { status: "NEEDS_REVIEW", target: 65320, deposited: 0 },
});

const simple = (storeId: string, bank: number, truth: Scenario["truth"]): Scenario => ({
  name: `${storeId}（検算なし）入金 ${bank}円`,
  storeId,
  businessDate: "2026-09-28",
  today: "2026-09-29",
  correlated: false,
  make: () => salesRaw({ businessDate: "2026/9/28", deposit: 72260, rows: passbook(100000, [["08-09-28", 50000], ["08-09-29", bank], ["08-09-30", 61000]]) }),
  truth,
});

const scenarios: Scenario[] = [
  doshisha(65000),
  doshisha(64000),
  doshisha(65320 - 1000),
  simple("hakubaicho", 72260, { status: "OK", target: 72260, deposited: 72260 }),
  simple("hakubaicho", 72000, { status: "NEEDS_REVIEW", target: 72260, deposited: 0 }),
  simple("hakubaicho", 71260, { status: "NEEDS_REVIEW", target: 72260, deposited: 0 }),
  simple("kyodaimae", 72000, { status: "COIN_PENDING", target: 72260, deposited: 72000 }),
  simple("kyodaimae", 71000, { status: "NEEDS_REVIEW", target: 72260, deposited: 0 }),
];

type FieldPath = (r: RawExtraction) => Field;
function fieldsOf(sc: Scenario): [string, FieldPath][] {
  const fields: [string, FieldPath][] = [
    ["日計表の入金対象額", (r) => r.register_report!.deposit_amount],
    ["日計表の営業日", (r) => r.register_report!.business_date],
  ];
  if (sc.correlated) {
    fields.push(["在高実績", (r) => r.register_report!.cash_on_hand], ["翌準備金", (r) => r.register_report!.next_day_float]);
  }
  sc.make().passbook_rows.forEach((_, i) => {
    fields.push([`通帳${i + 1}行目の日付`, (r) => r.passbook_rows[i]!.date]);
    fields.push([`通帳${i + 1}行目のお預り`, (r) => r.passbook_rows[i]!.deposit]);
    fields.push([`通帳${i + 1}行目の残高`, (r) => r.passbook_rows[i]!.balance]);
  });
  return fields;
}

function assertSafe(sc: Scenario, o: Outcome, what: string) {
  if (!POSITIVE.includes(o.status as OverallStatus)) return; // 要確認・判読不能は安全
  // OK系になってよいのは「本当にOK系」で、かつ記録された数字が真実と一致する場合だけ
  expect(POSITIVE.includes(sc.truth.status), `${what}: 本当は ${sc.truth.status} なのに ${o.status}`).toBe(true);
  expect({ status: o.status, target: o.target, deposited: o.deposited }, what).toEqual(sc.truth);
}

for (const sc of scenarios) {
  describe(sc.name, () => {
    it("誤読がなければ真実どおり", () => {
      const o = run(ctx, sc.storeId, sc.make(), sc.make(), sc.businessDate, sc.today);
      expect(o.status).toBe(sc.truth.status);
    });

    for (const [label, path] of fieldsOf(sc)) {
      it(`${label} を片方のAIが1桁誤読しても誤判定しない`, () => {
        const original = path(sc.make()).text;
        for (const m of digitMutations(original)) {
          const b = sc.make();
          path(b).text = m;
          assertSafe(sc, run(ctx, sc.storeId, sc.make(), b, sc.businessDate, sc.today), `${original}→${m}`);
        }
      });

      const passbookField = label.startsWith("通帳");
      if (sc.correlated || passbookField) {
        it(`${label} を両方のAIが同じように1桁誤読しても誤判定しない`, () => {
          const original = path(sc.make()).text;
          for (const m of digitMutations(original)) {
            const a = sc.make();
            const b = sc.make();
            path(a).text = m;
            path(b).text = m;
            assertSafe(sc, run(ctx, sc.storeId, a, b, sc.businessDate, sc.today), `${original}→${m}`);
          }
        });
      }
    }
  });
}

describe("設定による安全装置", () => {
  it("書式を登録した店舗にレジ精算票の検算がなければ設定エラー（起動しない）", () => {
    const raw = structuredClone(loadDefaultConfig()) as any;
    raw.stores.find((s: any) => s.id === "kyodaimae").receipt.depositLabel = "預入金";
    expect(() => parseConfig(raw)).toThrow(/検算/);
  });
  it("テスト用設定は明示的に許可したときだけ検算なしで動く", () => {
    expect(() => testConfig()).not.toThrow();
  });
});
