/**
 * 抽出プロンプト。変更したら PROMPT_VERSION を上げる（監査ログで追跡するため）。
 * 2系統の独立抽出で読み方の癖が重ならないよう、variant ごとに読み取り手順を変えている。
 */
export const PROMPT_VERSION = "2026-10-02.2";

export type PromptVariant = "A" | "B";

const COMMON = `あなたは飲食店の経理書類を書き写す担当者です。
写真には「銀行通帳」と、「レジ精算票（日計表）」または「廃油の受取書」が写っています。

# あなたの仕事
写っている文字を、見えたとおりに書き写すことだけです。
- 計算しない。足し算・引き算で数字を補わない。
- 推測しない。読めない文字を前後の行や常識から埋めない。
- 1文字でも自信がない欄は legibility を "unclear" にする（数字は1桁の誤りも許されない金銭書類です）。
- 欄が空欄なら text を空文字、legibility を "empty" にする。
- 写真の外・指や物で隠れている欄は "not_visible" にする。
- confidence は、その欄を正しく書き写せた自信を0〜1で答える。
- 写真がボヤけている、反射している、数字が隠れている場合は image_quality に正直に書く。

# 書き写し方
- 金額は印字のまま（例: "*65,000" "¥123,456" "300円"）。カンマや記号も見えたとおり。
- 日付も印字のまま（例: "08.09.24" "08-09-29" "2026/9/28 (月)" "26年9月22日"）。年を西暦に直さない。
- 通帳の取引行は、写っている行をすべて上から順に書き写す（印字のない空行は含めない）。
  - お預り金額の列 → deposit、お支払（お払戻）金額の列 → withdrawal、差引残高 → balance。
  - 行のそばにある手書きメモ（例: 「油入金」）は handwritten_note に書く。
- 口座番号・口座名義・個人名は書き写さない（不要な個人情報のため）。

# 書類の種類
- 通帳＋レジ精算票 → document_type "sales_report"、register_report を埋め、oil_receipt は null。
- 通帳＋廃油受取書 → document_type "oil_receipt"、oil_receipt を埋め、register_report は null。
- どちらでもない → "other"。`;

const VARIANT_STEPS: Record<PromptVariant, string> = {
  A: `# 読み取り手順
1. まず書類の種類を判定する。
2. レジ精算票（または受取書）を上から順に読む。
3. 通帳を1行ずつ、左の列から右の列へ読む。`,
  B: `# 読み取り手順
1. まず通帳を、一番下の行から上へ向かって1行ずつ読む（最後に出力するときは上から順に並べ直す）。
2. 各金額は、右端の桁から左へ1桁ずつ確認してから書き写す。
3. 最後にレジ精算票（または受取書）を読み、書類の種類を判定する。`,
};

export function buildPrompt(variant: PromptVariant, depositLabel: string | null): string {
  const label = depositLabel
    ? `\n# レジ精算票の入金対象額\nregister_report.deposit_amount には「${depositLabel}」の項目の金額を書き写す。その項目が見つからなければ legibility を "not_visible" にする（ほかの項目で代用しない）。`
    : `\n# レジ精算票の入金対象額\nregister_report.deposit_amount には「預入金」「入金額」など銀行に入金する金額と思われる項目を書き写し、deposit_amount_label にその項目名を印字のまま書く。`;
  return `${COMMON}\n${label}\n\n${VARIANT_STEPS[variant]}`;
}
