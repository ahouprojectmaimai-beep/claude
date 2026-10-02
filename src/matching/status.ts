import { getStore } from "../config/config";
import type { ISODate } from "../domain/calendar";
import type { Issue } from "../validation/issues";
import { isCashChecked } from "./clerk";
import { coinDeadline, remainingOf, splitBillsCoins, type EngineContext } from "./engine";
import type { DailyRecord, Ledger } from "./ledger";

export type OverallStatus =
  | "OK"
  | "FINAL_CONFIRMED"
  | "COIN_PENDING"
  | "CLERK_PENDING"
  | "NEEDS_REVIEW"
  | "UNREADABLE"
  | "NOT_SUBMITTED";

export const STATUS_LABEL: Record<OverallStatus, string> = {
  OK: "✅ OK",
  FINAL_CONFIRMED: "🔵 最終確認完了",
  COIN_PENDING: "🟡 小銭入金待ち",
  CLERK_PENDING: "✅ お札入金OK（小銭：事務確認待ち）",
  NEEDS_REVIEW: "⚠️ 要確認",
  UNREADABLE: "📷 画像判読不能",
  NOT_SUBMITTED: "❌ 未提出",
};

export interface RecordStatus {
  overall: OverallStatus;
  target: number | null;
  deposited: number;
  remaining: number | null;
  reasons: string[];
}

/** 日次レコードの状態を、台帳の事実だけから決定的に計算する */
export function evaluateRecord(ctx: EngineContext, ledger: Ledger, rec: DailyRecord, today: ISODate): RecordStatus {
  const store = getStore(ctx.cfg, rec.storeId);
  const deposited = rec.deposits.reduce((a, d) => a + d.amount, 0);
  const remaining = remainingOf(rec);
  const base = { target: rec.target, deposited, remaining };
  const reasonsOf = (xs: (Issue | null)[]) => xs.filter((x): x is Issue => !!x).map((x) => x.message);

  if (rec.docIssues.some((i) => i.severity === "unreadable")) return { ...base, overall: "UNREADABLE", reasons: reasonsOf(rec.docIssues) };
  if (rec.docIssues.length > 0 || rec.target === null) return { ...base, overall: "NEEDS_REVIEW", reasons: reasonsOf(rec.docIssues) };
  if (!rec.deposits.some((d) => d.kind === "INITIAL")) {
    return { ...base, overall: "NEEDS_REVIEW", reasons: reasonsOf([rec.allocationIssue]).concat(rec.allocationIssue ? [] : ["入金が確認できない"]) };
  }
  if (remaining! < 0) return { ...base, overall: "NEEDS_REVIEW", reasons: ["入金額が日計表より多い"] };
  if (remaining === 0) return { ...base, overall: "OK", reasons: [] };

  const { coins } = splitBillsCoins(rec.target, ctx.cfg.billUnit);
  const onlyCoinsLeft = remaining! < ctx.cfg.billUnit && remaining === coins;
  if (!onlyCoinsLeft || store.coinPolicy === "SAME_DAY") {
    return { ...base, overall: "NEEDS_REVIEW", reasons: [`入金不足 ${remaining!.toLocaleString("ja-JP")}円`] };
  }
  if (store.coinPolicy === "CLERK_CHECK") {
    return { ...base, overall: isCashChecked(ledger, rec.businessDate) ? "FINAL_CONFIRMED" : "CLERK_PENDING", reasons: [] };
  }
  // DEFERRED
  if (rec.allocationIssue) return { ...base, overall: "NEEDS_REVIEW", reasons: reasonsOf([rec.allocationIssue]) };
  if (today > coinDeadline(ctx, rec.businessDate)) {
    return { ...base, overall: "NEEDS_REVIEW", reasons: [`小銭が期限（${coinDeadline(ctx, rec.businessDate)}）を過ぎても未入金`] };
  }
  return { ...base, overall: "COIN_PENDING", reasons: [] };
}
