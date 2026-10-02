/**
 * 実画像を Claude で2系統抽出して判定する（ANTHROPIC_API_KEY が必要。キーはコードに書かない）。
 * 使い方: npm run analyze -- --store doshisha --today 2026-09-29 --image photo.jpg [--save-dir testdata/private/out]
 * 抽出結果JSONには銀行情報が含まれるため、保存先は .gitignore 済みの testdata/private/ 配下にすること。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { ClaudeExtractor } from "../src/extraction/claudeExtractor";
import type { ImageMediaType } from "../src/extraction/extractor";
import { analyzeImage } from "../src/pipeline/analyze";
import { cliArgs, loadConfig, printOutcome } from "./common";

const args = cliArgs({ image: { type: "string" }, "save-dir": { type: "string" }, model: { type: "string" } });
const storeId = String(args.store ?? "");
const today = String(args.today ?? "");
const image = String(args.image ?? "");
if (!storeId || !today || !image) {
  console.error("使い方: --store <店舗ID> --today YYYY-MM-DD --image <画像> [--save-dir testdata/private/out] [--model claude-opus-5-5]");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("環境変数 ANTHROPIC_API_KEY が未設定です");
  process.exit(1);
}
const mediaTypes: Record<string, ImageMediaType> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const mediaType = mediaTypes[extname(image).toLowerCase()];
if (!mediaType) {
  console.error("対応していない画像形式です（jpg/png/webp）");
  process.exit(1);
}
const cfg = loadConfig(args.config as string | undefined);
const model = (args.model as string | undefined) ?? "claude-opus-5-5";
const extractors = [new ClaudeExtractor({ model, variant: "A" }), new ClaudeExtractor({ model, variant: "B" })];
const result = await analyzeImage({ imageBase64: readFileSync(image).toString("base64"), mediaType, claimedStoreId: storeId, today }, extractors, cfg);

const saveDir = args["save-dir"] as string | undefined;
if (saveDir) {
  if (!saveDir.startsWith("testdata/private")) {
    console.error("銀行情報を含むため、保存先は testdata/private/ 配下に限ります");
    process.exit(1);
  }
  mkdirSync(saveDir, { recursive: true });
  for (const ex of result.extractions) writeFileSync(join(saveDir, `${ex.extractorId.replace(/[:/]/g, "_")}.json`), JSON.stringify(ex, null, 2));
}
for (const ex of result.extractions) console.log(`抽出: ${ex.extractorId} (${ex.model}) ${ex.error ?? "成功"}`);
printOutcome(cfg, storeId, today, result);
