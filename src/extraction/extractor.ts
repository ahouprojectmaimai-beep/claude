import type { ExtractionRecord } from "./schema";

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface ExtractionRequest {
  imageBase64: string;
  mediaType: ImageMediaType;
  /** 店舗設定の入金対象項目名（未登録なら null） */
  depositLabel: string | null;
}

/** 画像 → 構造化データ。AIの種類（Claude / 他社 / OCR）を差し替えられるようにする */
export interface Extractor {
  readonly id: string;
  extract(req: ExtractionRequest): Promise<ExtractionRecord>;
}
