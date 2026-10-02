import { parseArgs } from "node:util";
import { loadDefaultCalendar, loadDefaultConfig } from "../src/config/load";
import { getStore, parseConfig, type AppConfig } from "../src/config/config";
import { applySubmission } from "../src/matching/engine";
import { Ledger } from "../src/matching/ledger";
import { evaluateRecord, STATUS_LABEL } from "../src/matching/status";
import type { AnalysisResult } from "../src/pipeline/analyze";
import { readFileSync } from "node:fs";

export function cliArgs(extra: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {}) {
  return parseArgs({
    options: {
      store: { type: "string" },
      today: { type: "string" },
      config: { type: "string" },
      ...extra,
    },
  }).values as Record<string, string | string[] | boolean | undefined>;
}

export function loadConfig(path?: string): AppConfig {
  return path ? parseConfig(JSON.parse(readFileSync(path, "utf8"))) : loadDefaultConfig();
}

/** 解析結果を台帳に通して、判定結果を表示する（残高などの銀行情報は表示しない） */
export function printOutcome(cfg: AppConfig, storeId: string, today: string, analysis: AnalysisResult) {
  const ctx = { cfg, calendar: loadDefaultCalendar() };
  const store = getStore(cfg, storeId);
  console.log(`\n■ 店舗: ${store.name}　判定日: ${today}`);
  console.log(`■ 画像の検証: ${analysis.severity === "ok" ? "問題なし" : analysis.severity === "review" ? "要確認" : "画像判読不能"}`);
  for (const i of analysis.issues) console.log(`  - [${i.severity}] ${i.message}`);
  if (analysis.doc) {
    const rows = analysis.doc.rows.filter((r) => r.index >= 0);
    console.log(`■ 通帳: ${rows.length}行を読み取り / 残高検算OK ${rows.filter((r) => r.chainVerified).length}行 / 2系統不一致 ${analysis.doc.rows.filter((r) => r.disputed).length}行`);
  }

  const ledger = new Ledger();
  applySubmission(ctx, ledger, { sourceId: "cli", storeId, postedOn: today, analysis });
  for (const rec of ledger.records.values()) {
    const s = evaluateRecord(ctx, ledger, rec, today);
    console.log(`\n【${rec.businessDate} 営業分】 ${STATUS_LABEL[s.overall]}`);
    if (s.target !== null) console.log(`  日計表: ${s.target.toLocaleString("ja-JP")}円 / 入金確認: ${s.deposited.toLocaleString("ja-JP")}円`);
    for (const r of s.reasons) console.log(`  理由: ${r}`);
  }
  for (const oil of ledger.oils.values()) {
    console.log(`\n【廃油 ${oil.receiptDate}】 ${oil.deposit ? "✅ 油入金OK" : "⚠️ 要確認"}`);
    console.log(`  受取書: ${oil.amount.toLocaleString("ja-JP")}円${oil.bottles !== null ? `（${oil.bottles}本）` : ""}${oil.deposit ? ` → 入金日 ${oil.deposit.date}` : ""}`);
    if (oil.issue) console.log(`  理由: ${oil.issue.message}`);
  }
  for (const u of ledger.unattached) console.log(`\n【日付を特定できない投稿】 ${u.issues.map((i) => i.message).join(" / ")}`);
}
