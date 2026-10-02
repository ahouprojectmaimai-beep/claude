import type { AppConfig, StoreConfig } from "../config/config";
import { normalizeDigits } from "../domain/text";
import type { NormalizedDocument, PassbookLine, SalesDocument } from "./normalize";
import { review, type Issue } from "./issues";

function usable(r: PassbookLine | undefined): r is PassbookLine & { deposit: number; withdrawal: number; balance: number } {
  return !!r && r.legible && !r.disputed && r.deposit !== null && r.withdrawal !== null && r.balance !== null;
}

/**
 * 通帳の残高検算: 前の行の残高 + お預り − お支払 = この行の残高。
 * 前の行との計算が合い、かつ次の行がある場合は次の行との計算も合う行だけを chainVerified とする。
 * （先頭行は前の行がないため検証不能 → 照合には使えない）
 */
export function verifyBalanceChain(rows: PassbookLine[]): PassbookLine[] {
  const main = rows.filter((r) => r.index >= 0);
  const links = main.map((r, i) => {
    const prev = main[i - 1];
    if (!usable(r) || !usable(prev)) return false;
    return prev.balance + r.deposit - r.withdrawal === r.balance;
  });
  const verified = main.map((r, i) => {
    if (!links[i]) return { ...r, chainVerified: false };
    const next = main[i + 1];
    const nextOk = next === undefined || !usable(next) ? true : links[i + 1] === true;
    return { ...r, chainVerified: nextOk };
  });
  return [...verified, ...rows.filter((r) => r.index < 0)];
}

/** レジ精算票の中での検算（店舗設定で有効にしたものだけ） */
export function checkReceiptArithmetic(doc: SalesDocument, store: StoreConfig): Issue[] {
  const issues: Issue[] = [];
  for (const check of store.receipt.checks) {
    if (check === "denominationsSum") {
      if (doc.denominations === null || doc.cashOnHand === null) {
        issues.push(review("RECEIPT_CHECK_MISSING", "金種または在高実績が読めず、レジ精算票の検算ができない"));
      } else {
        const sum = doc.denominations.reduce((a, b) => a + b, 0);
        if (sum !== doc.cashOnHand) {
          issues.push(review("RECEIPT_DENOM_MISMATCH", `金種の合計(${sum})が在高実績(${doc.cashOnHand})と合わない`));
        }
      }
    }
    if (check === "onHandMinusFloat") {
      if (doc.cashOnHand === null || doc.nextDayFloat === null) {
        issues.push(review("RECEIPT_CHECK_MISSING", "在高実績または翌準備金が読めず、レジ精算票の検算ができない"));
      } else if (doc.cashOnHand - doc.nextDayFloat !== doc.depositAmount) {
        issues.push(review("RECEIPT_FLOAT_MISMATCH", "在高実績 − 翌準備金 が入金対象額と合わない"));
      }
    }
  }
  return issues;
}

function containsAlias(text: string, s: StoreConfig): boolean {
  const t = normalizeDigits(text).replace(/\s/g, "");
  return s.aliases.some((a) => t.includes(a));
}

/**
 * LINEで申告された店舗と、画像内に印字された店舗名のクロスチェック。
 * 画像に別の店舗名が書かれていたら要確認。読めない・書いていない場合は申告を採用する。
 */
export function checkStoreIdentity(doc: NormalizedDocument, claimed: StoreConfig, cfg: AppConfig): Issue[] {
  const text = doc.kind === "sales" ? doc.storeNameText : doc.addresseeText;
  if (!text) return [];
  if (containsAlias(text, claimed)) return [];
  const other = cfg.stores.find((s) => s.id !== claimed.id && containsAlias(text, s));
  if (other) {
    return [review("STORE_MISMATCH", `投稿の店舗名（${claimed.name}）と画像内の店舗名（${other.name}）が違う`)];
  }
  return [];
}
