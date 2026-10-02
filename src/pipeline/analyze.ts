import type { AppConfig } from "../config/config";
import { getStore } from "../config/config";
import type { ISODate } from "../domain/calendar";
import type { Extractor, ImageMediaType } from "../extraction/extractor";
import type { ExtractionRecord, RawExtraction } from "../extraction/schema";
import { checkReceiptArithmetic, checkStoreIdentity, verifyBalanceChain } from "../validation/checks";
import { buildConsensus } from "../validation/consensus";
import { review, unreadable, worstSeverity, type Issue } from "../validation/issues";
import { normalizeExtraction, type NormalizedDocument } from "../validation/normalize";

export interface AnalysisResult {
  /** issues が空のときだけ照合に使ってよい */
  doc: NormalizedDocument | null;
  issues: Issue[];
  severity: "ok" | "review" | "unreadable";
  extractions: ExtractionRecord[];
}

/**
 * 複数系統の抽出結果 → 正規化 → 合意 → 検算 → 店舗クロスチェック。
 * どこか1つでも怪しければ issues に積み、OKの根拠には使わせない。
 */
export function analyzeExtractions(
  extractions: ExtractionRecord[],
  claimedStoreId: string,
  cfg: AppConfig,
  today: ISODate,
): AnalysisResult {
  const store = getStore(cfg, claimedStoreId);
  const issues: Issue[] = [];
  const docs: NormalizedDocument[] = [];

  for (const ex of extractions) {
    if (ex.error || !ex.result) {
      issues.push(review("EXTRACTION_FAILED", `AI解析に失敗（${ex.extractorId}）: ${ex.error ?? "結果なし"}`));
      continue;
    }
    const n = normalizeExtraction(ex.result as RawExtraction, store, cfg, today);
    issues.push(...n.issues);
    if (n.doc) docs.push(n.doc);
  }

  let doc: NormalizedDocument | null = null;
  if (issues.length === 0 || docs.length === extractions.length) {
    const c = buildConsensus(docs);
    issues.push(...c.issues);
    doc = c.doc;
  }

  if (doc) {
    doc = { ...doc, rows: verifyBalanceChain(doc.rows) };
    if (doc.kind === "sales") issues.push(...checkReceiptArithmetic(doc, store));
    issues.push(...checkStoreIdentity(doc, store, cfg));
  } else if (issues.length === 0) {
    issues.push(unreadable("NO_DOCUMENT", "書類を読み取れなかった"));
  }

  const uniq = dedupeIssues(issues);
  return { doc, issues: uniq, severity: worstSeverity(uniq) ?? "ok", extractions };
}

function dedupeIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.code}|${i.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface AnalyzeImageInput {
  imageBase64: string;
  mediaType: ImageMediaType;
  claimedStoreId: string;
  today: ISODate;
}

/** 画像1枚を、設定された全抽出器で独立に読み取り、検証まで行う */
export async function analyzeImage(input: AnalyzeImageInput, extractors: Extractor[], cfg: AppConfig): Promise<AnalysisResult> {
  const store = getStore(cfg, input.claimedStoreId);
  const extractions = await Promise.all(
    extractors.map((e) =>
      e.extract({ imageBase64: input.imageBase64, mediaType: input.mediaType, receiptLabels: store.receipt.labels }),
    ),
  );
  return analyzeExtractions(extractions, input.claimedStoreId, cfg, input.today);
}
