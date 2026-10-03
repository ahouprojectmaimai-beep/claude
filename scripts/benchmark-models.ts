/**
 * AIモデルの比較（安い順に、実画像の正解データで精度と費用を測る）。
 * ANTHROPIC_API_KEY が必要。実行前に概算費用を表示し、--yes がないと実行しない。
 *
 *   npx tsx scripts/benchmark-models.ts                 # 概算費用だけ表示
 *   npx tsx scripts/benchmark-models.ts --yes           # 実行
 *   npx tsx scripts/benchmark-models.ts --yes --candidates claude-haiku-4-5,claude-sonnet-5-5:low
 *
 * 正解データ: testdata/private/cases.json（Git対象外）。結果は testdata/private/bench/ に保存。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getStore } from "../src/config/config";
import { ClaudeExtractor, type Effort } from "../src/extraction/claudeExtractor";
import { costUSD, modelProfile } from "../src/extraction/models";
import { RawExtraction, type ExtractionRecord } from "../src/extraction/schema";
import { normalizeExtraction, type NormalizedDocument, type PassbookLine } from "../src/validation/normalize";
import { cliArgs, loadConfig } from "./common";

interface Case {
  id: string;
  store: string;
  postedOn: string;
  image: string;
  extraction: unknown;
}

const args = cliArgs({ yes: { type: "boolean" }, candidates: { type: "string" }, cases: { type: "string" } });
const cfg = loadConfig(args.config as string | undefined);
const cases: Case[] = JSON.parse(readFileSync(String(args.cases ?? "testdata/private/cases.json"), "utf8"));
const candidates = String(args.candidates ?? "claude-haiku-4-5,claude-sonnet-5-5:low,claude-sonnet-5-5:medium,claude-opus-5-5:medium")
  .split(",")
  .map((c) => {
    const [model, effort] = c.split(":") as [string, Effort | undefined];
    modelProfile(model);
    return { model, effort };
  });

// 概算（1枚あたり 入力3,500 / 出力 Haiku 3,000・その他 6,000 トークンと仮定した上限寄りの見積もり）
const estimate = candidates.reduce((sum, c) => sum + cases.length * costUSD(c.model, 3500, c.model.includes("haiku") ? 3000 : 6000), 0);
console.log(`対象: ${cases.length}枚 × ${candidates.length}モデル（各1回読み取り）`);
console.log(`概算費用: 約 $${estimate.toFixed(2)}（約${Math.round(estimate * 155)}円）`);
if (!args.yes) {
  console.log("実行するには --yes を付けてください");
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("環境変数 ANTHROPIC_API_KEY が未設定です");
  process.exit(1);
}

const keyOf = (r: PassbookLine) => `${r.date}|${r.deposit}|${r.withdrawal}|${r.balance}`;

interface Score {
  keyFieldsOk: number;
  keyFieldsTotal: number;
  /** 「はっきり読めた」と答えたのに間違っていた主要項目（最も危険） */
  confidentWrong: number;
  /** 判読不能・要確認として止めた数（安全側。多すぎると手間が増える） */
  flagged: number;
  rowsOk: number;
  rowsTotal: number;
  /** 正解にない行を「はっきり」読んだ数 */
  phantomRows: number;
}

function score(c: Case, truth: NormalizedDocument, ai: ExtractionRecord): Score {
  const s: Score = { keyFieldsOk: 0, keyFieldsTotal: 0, confidentWrong: 0, flagged: 0, rowsOk: 0, rowsTotal: truth.rows.filter((r) => r.legible).length, phantomRows: 0 };
  const store = getStore(cfg, c.store);
  if (!ai.result) {
    s.flagged++;
    s.keyFieldsTotal = truth.kind === "sales" ? 4 : 2;
    return s;
  }
  const n = normalizeExtraction(ai.result, store, cfg, c.postedOn);
  if (n.issues.length > 0) s.flagged++;
  const doc = n.doc;
  const fields: [string, unknown, unknown][] =
    truth.kind === "sales"
      ? [
          ["営業日", truth.businessDate, doc?.kind === "sales" ? doc.businessDate : null],
          ["入金対象額", truth.depositAmount, doc?.kind === "sales" ? doc.depositAmount : null],
          ["在高", truth.cashOnHand, doc?.kind === "sales" ? doc.cashOnHand : null],
          ["翌準備金", truth.nextDayFloat, doc?.kind === "sales" ? doc.nextDayFloat : null],
        ]
      : [
          ["受取日", truth.receiptDate, doc?.kind === "oil" ? doc.receiptDate : null],
          ["廃油金額", truth.amount, doc?.kind === "oil" ? doc.amount : null],
        ];
  for (const [, want, got] of fields) {
    s.keyFieldsTotal++;
    if (got === want) s.keyFieldsOk++;
    else if (got !== null && n.issues.length === 0) s.confidentWrong++;
  }
  const truthKeys = new Map<string, number>();
  for (const r of truth.rows.filter((x) => x.legible)) truthKeys.set(keyOf(r), (truthKeys.get(keyOf(r)) ?? 0) + 1);
  for (const r of doc?.rows ?? []) {
    if (!r.legible) continue;
    const k = keyOf(r);
    const left = truthKeys.get(k) ?? 0;
    if (left > 0) {
      s.rowsOk++;
      truthKeys.set(k, left - 1);
    } else s.phantomRows++;
  }
  return s;
}

const outDir = "testdata/private/bench";
const summary: string[] = [];
for (const cand of candidates) {
  const ex = new ClaudeExtractor({ model: cand.model, variant: "A", effort: cand.effort });
  const total: Score = { keyFieldsOk: 0, keyFieldsTotal: 0, confidentWrong: 0, flagged: 0, rowsOk: 0, rowsTotal: 0, phantomRows: 0 };
  let cost = 0;
  let ms = 0;
  const dir = join(outDir, ex.id.replace(/[:/]/g, "_"));
  mkdirSync(dir, { recursive: true });
  for (const c of cases) {
    const store = getStore(cfg, c.store);
    const truth = normalizeExtraction(RawExtraction.parse(c.extraction), store, cfg, c.postedOn).doc;
    if (!truth) throw new Error(`正解データが不正: ${c.id}`);
    const t0 = Date.now();
    const rec = await ex.extract({ imageBase64: readFileSync(c.image).toString("base64"), mediaType: "image/jpeg", receiptLabels: store.receipt.labels });
    ms += Date.now() - t0;
    if (rec.usage) cost += costUSD(cand.model, rec.usage.inputTokens, rec.usage.outputTokens);
    writeFileSync(join(dir, `${c.id}.json`), JSON.stringify(rec, null, 2));
    const sc = score(c, truth, rec);
    for (const k of Object.keys(total) as (keyof Score)[]) total[k] += sc[k];
    console.log(`  ${ex.id} ${c.id}: 主要項目 ${sc.keyFieldsOk}/${sc.keyFieldsTotal} 通帳行 ${sc.rowsOk}/${sc.rowsTotal}${sc.confidentWrong ? ` ⚠自信ありの誤読 ${sc.confidentWrong}` : ""}${rec.error ? ` エラー: ${rec.error}` : ""}`);
  }
  const perImageYen = (cost / cases.length) * 155;
  summary.push(
    `| ${modelProfile(cand.model).label}${cand.effort ? ` effort=${cand.effort}` : ""} | ${total.keyFieldsOk}/${total.keyFieldsTotal} | ${total.rowsOk}/${total.rowsTotal} | ${total.confidentWrong} | ${total.phantomRows} | ${total.flagged} | ${perImageYen.toFixed(1)}円 | ${(ms / cases.length / 1000).toFixed(1)}秒 |`,
  );
}
console.log("\n| モデル | 主要項目の正解 | 通帳行の正解 | 自信ありの誤読(危険) | 存在しない行 | 要確認で停止 | 1回あたり費用 | 1回あたり時間 |");
console.log("|---|---|---|---|---|---|---|---|");
for (const l of summary) console.log(l);
console.log("\n採用基準: 「自信ありの誤読」が0、主要項目・通帳行の正解率が高い中で最も安いもの（本番は2系統なので費用は約2倍）");
