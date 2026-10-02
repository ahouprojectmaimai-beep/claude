/**
 * 実画像の正解データ（testdata/private/cases.json, Git対象外）を投稿日の順に台帳へ流し、
 * 期待どおりの判定になるかを確認する。APIキー不要。
 * cases.json の各要素: { id, store, postedOn, extraction(AIの書き写し結果の形), expect: { 営業日: ステータス } }
 */
import { readFileSync } from "node:fs";
import { loadDefaultCalendar } from "../src/config/load";
import { getStore } from "../src/config/config";
import { RawExtraction } from "../src/extraction/schema";
import { applySubmission } from "../src/matching/engine";
import { Ledger, recordKey } from "../src/matching/ledger";
import { evaluateRecord, STATUS_LABEL } from "../src/matching/status";
import { analyzeExtractions } from "../src/pipeline/analyze";
import { cliArgs, loadConfig } from "./common";

interface Case {
  id: string;
  store: string;
  postedOn: string;
  extraction: unknown;
  expect: Record<string, string>;
}

const args = cliArgs({ cases: { type: "string" } });
const cfg = loadConfig(args.config as string | undefined);
const ctx = { cfg, calendar: loadDefaultCalendar() };
const cases: Case[] = JSON.parse(readFileSync(String(args.cases ?? "testdata/private/cases.json"), "utf8"));
cases.sort((a, b) => a.postedOn.localeCompare(b.postedOn));

const ledger = new Ledger();
let failures = 0;
for (const c of cases) {
  const raw = RawExtraction.parse(c.extraction);
  const ex = (id: string) => ({ extractorId: id, model: "manual", promptVersion: "manual", startedAt: "", finishedAt: "", result: structuredClone(raw), error: null });
  const analysis = analyzeExtractions([ex("A"), ex("B")], c.store, cfg, c.postedOn);
  applySubmission(ctx, ledger, { sourceId: c.id, storeId: c.store, postedOn: c.postedOn, analysis });
  const issues = analysis.issues.map((i) => i.message).join(" / ");
  console.log(`\n[${c.postedOn} 投稿] ${getStore(cfg, c.store).name} (${c.id})${issues ? `\n  画像の問題: ${issues}` : ""}`);
  for (const [key, want] of Object.entries(c.expect)) {
    let got: string;
    let detail = "";
    if (key.startsWith("oil:")) {
      const oil = [...ledger.oils.values()].find((o) => o.storeId === c.store && o.receiptDate === key.slice(4));
      got = oil?.deposit ? "OIL_OK" : "OIL_REVIEW";
      detail = oil ? `受取書 ${oil.amount}円 → ${oil.deposit ? `入金日 ${oil.deposit.date}` : oil.issue?.message}` : "記録なし";
    } else {
      const rec = ledger.records.get(recordKey(c.store, key));
      const s = rec ? evaluateRecord(ctx, ledger, rec, c.postedOn) : null;
      got = s?.overall ?? "NO_RECORD";
      detail = s ? `${STATUS_LABEL[s.overall]}  日計表 ${s.target?.toLocaleString("ja-JP")}円 / 入金確認 ${s.deposited.toLocaleString("ja-JP")}円 ${s.reasons.join(" ")}` : "記録なし";
    }
    const ok = got === want;
    if (!ok) failures++;
    console.log(`  ${ok ? "✓" : "✗"} ${key}: ${detail}${ok ? "" : `（期待: ${want}）`}`);
  }
}
console.log(`\n結果: ${cases.length}枚中 ${failures === 0 ? "すべて期待どおり" : `${failures}件が期待と違う`}`);
process.exit(failures === 0 ? 0 : 1);
