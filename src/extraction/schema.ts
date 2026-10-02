import { z } from "zod";

/**
 * AI（Vision）に返させる構造化データ。
 * AIの仕事は「印字・手書きされている文字をそのまま書き写すこと」だけ。
 * 数値への変換・計算・一致判定はすべてプログラム側で行う。
 */

export const Legibility = z.enum([
  /** 全桁がはっきり読める */
  "clear",
  /** ボヤけ・かすれ・反射などで1文字でも自信がない */
  "unclear",
  /** 欄が空欄（何も書かれていない） */
  "empty",
  /** 写真の範囲外・指や物で隠れて見えない */
  "not_visible",
]);
export type Legibility = z.infer<typeof Legibility>;

export const Field = z.object({
  /** 印字・手書きのまま書き写した文字列（計算・補完しない） */
  text: z.string(),
  legibility: Legibility,
  /** 0〜1。この欄を正しく書き写せた自信 */
  confidence: z.number(),
});
export type Field = z.infer<typeof Field>;

export const PassbookRow = z.object({
  /** 通帳の行番号（印字のまま。読めなければ空文字） */
  line_no: z.string(),
  date: Field,
  /** 摘要（ATM、決算利息、振込先名など） */
  description: z.string(),
  /** お支払金額（お払戻金額） */
  withdrawal: Field,
  /** お預り金額 */
  deposit: Field,
  /** 差引残高 */
  balance: Field,
  /** 行の近くにある手書きメモ（例: 「油入金」）。なければ空文字 */
  handwritten_note: z.string(),
});
export type PassbookRow = z.infer<typeof PassbookRow>;

export const Denomination = z.object({
  /** 例: "10円硬貨" "千円紙幣" */
  label: z.string(),
  amount: Field,
});

export const RegisterReport = z.object({
  /** 日計表に印字された店舗名 */
  store_name: Field,
  /** 営業日 */
  business_date: Field,
  /** 指定された項目名（例: 預入金）の金額 */
  deposit_amount: Field,
  /** deposit_amount を読み取った項目名（印字のまま） */
  deposit_amount_label: z.string(),
  /** 在高実績（レジ内の現金合計）。項目がなければ empty */
  cash_on_hand: Field,
  /** 翌準備金（翌日の釣銭準備金）。項目がなければ empty */
  next_day_float: Field,
  /** 金種別の金額（硬貨・紙幣）。印字されている行をすべて */
  denominations: z.array(Denomination),
});
export type RegisterReport = z.infer<typeof RegisterReport>;

export const OilReceipt = z.object({
  /** 宛名（例: 「ほりまる 様」） */
  addressee: Field,
  date: Field,
  /** 廃油の本数 */
  bottles: Field,
  /** 廃油の金額（手書き。欄の位置は問わない） */
  amount: Field,
});
export type OilReceipt = z.infer<typeof OilReceipt>;

export const ImageQuality = z.object({
  /** 写真全体または数字部分がボヤけている */
  blurry: z.boolean(),
  /** 反射・影・指などで数字が隠れている */
  obstructed: z.boolean(),
  /** 気になる点（日本語で短く） */
  notes: z.string(),
});

export const RawExtraction = z.object({
  document_type: z.enum([
    /** 銀行通帳＋レジ精算票（日計表） */
    "sales_report",
    /** 銀行通帳＋廃油受取書 */
    "oil_receipt",
    /** それ以外 */
    "other",
  ]),
  image_quality: ImageQuality,
  register_report: RegisterReport.nullable(),
  oil_receipt: OilReceipt.nullable(),
  /** 通帳の取引行（写っているすべての行を上から順に） */
  passbook_rows: z.array(PassbookRow),
});
export type RawExtraction = z.infer<typeof RawExtraction>;

/** どのAI・どのプロンプトで抽出したか（監査用） */
export interface ExtractionRecord {
  extractorId: string;
  model: string;
  promptVersion: string;
  startedAt: string;
  finishedAt: string;
  result: RawExtraction | null;
  error: string | null;
}
