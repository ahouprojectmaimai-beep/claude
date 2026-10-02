/**
 * 保存済みの抽出結果（AIの出力JSON）から判定を再現する。APIキー不要。
 * 使い方: npm run replay -- --store doshisha --today 2026-09-29 --a a.json [--b b.json]
 */
import { readFileSync } from "node:fs";
import { RawExtraction } from "../src/extraction/schema";
import { analyzeExtractions } from "../src/pipeline/analyze";
import { cliArgs, loadConfig, printOutcome } from "./common";

const args = cliArgs({ a: { type: "string" }, b: { type: "string" } });
const storeId = String(args.store ?? "");
const today = String(args.today ?? "");
if (!storeId || !today || !args.a) {
  console.error("使い方: --store <店舗ID> --today YYYY-MM-DD --a <抽出JSON> [--b <抽出JSON>]");
  process.exit(1);
}
const cfg = loadConfig(args.config as string | undefined);
const load = (p: string, id: string) => ({
  extractorId: id,
  model: "replay",
  promptVersion: "replay",
  startedAt: "",
  finishedAt: "",
  result: RawExtraction.parse(JSON.parse(readFileSync(p, "utf8"))),
  error: null,
});
const exA = load(String(args.a), "A");
const exB = load(String(args.b ?? args.a), "B");
printOutcome(cfg, storeId, today, analyzeExtractions([exA, exB], storeId, cfg, today));
