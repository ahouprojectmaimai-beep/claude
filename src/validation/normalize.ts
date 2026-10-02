import type { AppConfig, StoreConfig, YearFormat } from "../config/config";
import { bankOf } from "../config/config";
import { addDays, diffDays, resolveYear, toISODate, type ISODate } from "../domain/calendar";
import { normalizeLabel, parseAmount, redactAccountNumbers, splitDateParts } from "../domain/text";
import type { Field, RawExtraction } from "../extraction/schema";
import { review, unreadable, type Issue } from "./issues";

/** 通帳の1行（プログラムで数値化・検証済み） */
export interface PassbookLine {
  index: number;
  lineNo: string;
  /** 日付・金額・残高がすべて確実に読めた行だけ true */
  legible: boolean;
  /** 残高だけは確実に読めた（「繰越」行など、次の行の残高検算の起点に使える） */
  balanceOk: boolean;
  date: ISODate | null;
  deposit: number | null;
  withdrawal: number | null;
  balance: number | null;
  description: string;
  note: string;
  /** 2系統の読み取りが一致しなかった行 */
  disputed: boolean;
  /** 前後の行と残高の計算が合った行 */
  chainVerified: boolean;
  problems: string[];
}

export interface SalesDocument {
  kind: "sales";
  storeNameText: string;
  businessDate: ISODate;
  depositAmount: number;
  depositLabelText: string;
  cashOnHand: number | null;
  nextDayFloat: number | null;
  denominations: number[] | null;
  rows: PassbookLine[];
}

export interface OilDocument {
  kind: "oil";
  addresseeText: string;
  receiptDate: ISODate;
  amount: number;
  bottles: number | null;
  rows: PassbookLine[];
}

export type NormalizedDocument = SalesDocument | OilDocument;

export interface NormalizeResult {
  doc: NormalizedDocument | null;
  issues: Issue[];
}

interface Ctx {
  cfg: AppConfig;
  today: ISODate;
  issues: Issue[];
}

function fieldProblem(f: Field, minConf: number): string | null {
  if (f.legibility === "unclear") return "はっきり読めない";
  if (f.legibility === "not_visible") return "写っていない・隠れている";
  if (f.legibility === "clear" && f.confidence < minConf) return `読み取りの自信が低い(${f.confidence.toFixed(2)})`;
  return null;
}

/** 必須の金額欄。少しでも怪しければ「画像判読不能」 */
function requiredAmount(ctx: Ctx, f: Field, name: string): number | null {
  const p = fieldProblem(f, ctx.cfg.rules.minFieldConfidence);
  if (p) {
    ctx.issues.push(unreadable("FIELD_ILLEGIBLE", `${name}: ${p}`));
    return null;
  }
  if (f.legibility === "empty") {
    ctx.issues.push(unreadable("FIELD_MISSING", `${name}: 見つからない`));
    return null;
  }
  const v = parseAmount(f.text);
  if (v === null) ctx.issues.push(unreadable("AMOUNT_UNPARSEABLE", `${name}: 金額として読めない`));
  return v;
}

/** 任意の金額欄（検算用）。空欄なら null、怪しければ判読不能 */
function optionalAmount(ctx: Ctx, f: Field, name: string): number | null {
  if (f.legibility === "empty") return null;
  return requiredAmount(ctx, f, name);
}

function parseDate(text: string, fmt: YearFormat): ISODate | null {
  const parts = splitDateParts(text);
  if (!parts) return null;
  const y = resolveYear(parts[0], fmt);
  if (y === null) return null;
  return toISODate(y, Number(parts[1]), Number(parts[2]));
}

function requiredDate(ctx: Ctx, f: Field, name: string, fmt: YearFormat): ISODate | null {
  const p = fieldProblem(f, ctx.cfg.rules.minFieldConfidence);
  if (p || f.legibility === "empty") {
    ctx.issues.push(unreadable("FIELD_ILLEGIBLE", `${name}: ${p ?? "見つからない"}`));
    return null;
  }
  const d = parseDate(f.text, fmt);
  if (!d) {
    ctx.issues.push(unreadable("DATE_UNPARSEABLE", `${name}: 日付として読めない`));
    return null;
  }
  const { dateSanityPastDays, dateSanityFutureDays } = ctx.cfg.rules;
  if (diffDays(d, ctx.today) > dateSanityFutureDays || diffDays(ctx.today, d) > dateSanityPastDays) {
    ctx.issues.push(review("DATE_OUT_OF_RANGE", `${name}: ${d} は想定範囲外の日付`));
    return null;
  }
  return d;
}

function normalizeRows(ctx: Ctx, raw: RawExtraction, fmt: YearFormat): PassbookLine[] {
  const minConf = ctx.cfg.rules.minFieldConfidence;
  const latestAllowed = addDays(ctx.today, ctx.cfg.rules.dateSanityFutureDays);
  return raw.passbook_rows.map((r, index) => {
    const problems: string[] = [];
    const amount = (f: Field, name: string): number | null => {
      const p = fieldProblem(f, minConf);
      if (p) {
        problems.push(`${name}: ${p}`);
        return null;
      }
      if (f.legibility === "empty") return 0;
      const v = parseAmount(f.text);
      if (v === null) problems.push(`${name}: 金額として読めない`);
      return v;
    };
    let date: ISODate | null = null;
    const dp = fieldProblem(r.date, minConf);
    if (dp || r.date.legibility === "empty") problems.push(`日付: ${dp ?? "空欄"}`);
    else {
      date = parseDate(r.date.text, fmt);
      if (!date) problems.push("日付: 日付として読めない");
      else if (date > latestAllowed) {
        problems.push("日付: 未来の日付");
        date = null;
      }
    }
    const deposit = amount(r.deposit, "お預り");
    const withdrawal = amount(r.withdrawal, "お支払");
    const balanceField = r.balance;
    const before = problems.length;
    const balance = balanceField.legibility === "empty" ? null : amount(balanceField, "残高");
    if (balanceField.legibility === "empty") problems.push("残高: 空欄");
    const balanceOk = balance !== null && problems.length === before;
    return {
      index,
      lineNo: r.line_no,
      legible: problems.length === 0,
      balanceOk,
      date,
      deposit,
      withdrawal,
      balance,
      description: redactAccountNumbers(r.description),
      note: redactAccountNumbers(r.handwritten_note),
      disputed: false,
      chainVerified: false,
      problems,
    };
  });
}

/** AIの書き写し結果を、店舗設定に従って数値・日付へ変換する。曖昧なものは推測せず issue にする */
export function normalizeExtraction(
  raw: RawExtraction,
  store: StoreConfig,
  cfg: AppConfig,
  today: ISODate,
): NormalizeResult {
  const ctx: Ctx = { cfg, today, issues: [] };

  if (raw.image_quality.blurry) ctx.issues.push(unreadable("BLURRY", "写真がボヤけている"));
  if (raw.image_quality.obstructed) ctx.issues.push(unreadable("OBSTRUCTED", "数字が反射・影・指などで隠れている"));

  const rows = normalizeRows(ctx, raw, bankOf(cfg, store).yearFormat);
  if (rows.length === 0) ctx.issues.push(unreadable("NO_PASSBOOK", "通帳の取引行が読み取れない"));

  if (raw.document_type === "sales_report") {
    const rr = raw.register_report;
    if (!rr) {
      ctx.issues.push(unreadable("NO_REGISTER_REPORT", "レジ精算票が読み取れない"));
      return { doc: null, issues: ctx.issues };
    }
    const labels = store.receipt.labels;
    if (labels === null) {
      ctx.issues.push(review("RECEIPT_FORMAT_UNREGISTERED", `${store.name}のレジ精算票の書式が未登録`));
    } else if (normalizeLabel(rr.deposit_amount_label) !== normalizeLabel(labels.deposit)) {
      ctx.issues.push(review("DEPOSIT_LABEL_MISMATCH", `入金対象額の項目名が設定（${labels.deposit}）と違う`));
    }
    const businessDate = requiredDate(ctx, rr.business_date, "営業日", store.receipt.yearFormat);
    const depositAmount = requiredAmount(ctx, rr.deposit_amount, "入金対象額");
    const cashOnHand = optionalAmount(ctx, rr.cash_on_hand, "在高実績");
    const nextDayFloat = optionalAmount(ctx, rr.next_day_float, "翌準備金");
    let denominations: number[] | null = null;
    if (rr.denominations.length > 0) {
      // 0枚の金種は「-」や空欄で印字される書式がある（funfo）。空欄は0円として扱う
      const vals = rr.denominations.map((d) => (d.amount.legibility === "empty" ? 0 : requiredAmount(ctx, d.amount, `金種(${d.label})`)));
      denominations = vals.every((v): v is number => v !== null) ? vals : null;
    }
    if (businessDate === null || depositAmount === null) return { doc: null, issues: ctx.issues };
    if (depositAmount <= 0) ctx.issues.push(review("NON_POSITIVE_DEPOSIT", "入金対象額が0円以下"));
    return {
      doc: {
        kind: "sales",
        storeNameText: rr.store_name.legibility === "clear" ? rr.store_name.text : "",
        businessDate,
        depositAmount,
        depositLabelText: rr.deposit_amount_label,
        cashOnHand,
        nextDayFloat,
        denominations,
        rows,
      },
      issues: ctx.issues,
    };
  }

  if (raw.document_type === "oil_receipt") {
    const oil = raw.oil_receipt;
    if (!oil) {
      ctx.issues.push(unreadable("NO_OIL_RECEIPT", "廃油受取書が読み取れない"));
      return { doc: null, issues: ctx.issues };
    }
    const receiptDate = requiredDate(ctx, oil.date, "受取書の日付", cfg.oilReceipt.yearFormat);
    const amount = requiredAmount(ctx, oil.amount, "廃油金額");
    let bottles: number | null = null;
    if (oil.bottles.legibility === "clear") {
      const m = /\d+/.exec(oil.bottles.text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)));
      bottles = m ? Number(m[0]) : null;
    }
    if (receiptDate === null || amount === null) return { doc: null, issues: ctx.issues };
    return {
      doc: {
        kind: "oil",
        addresseeText: oil.addressee.legibility === "clear" ? oil.addressee.text : "",
        receiptDate,
        amount,
        bottles,
        rows,
      },
      issues: ctx.issues,
    };
  }

  ctx.issues.push(review("UNKNOWN_DOCUMENT", "通帳＋日計表／通帳＋廃油受取書のどちらでもない画像"));
  return { doc: null, issues: ctx.issues };
}
