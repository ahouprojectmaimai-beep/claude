import type { ISODate } from "../domain/calendar";
import type { Issue } from "../validation/issues";

/**
 * 照合の状態を保持する台帳。
 * PHASE 2 ではメモリ上の実装。PHASE 4 で同じ形のまま D1（DB）へ置き換える。
 * 一意キー（sourceId / fingerprint / messageId）で二重登録を防ぐ。
 */

export type DepositKind = "INITIAL" | "COIN" | "OIL";

export interface DepositAssignment {
  /** 通帳の同じ行を二重に使わないための指紋（店舗・日付・金額・残高） */
  fingerprint: string;
  storeId: string;
  date: ISODate;
  amount: number;
  kind: DepositKind;
  /** 割り当て先（日次レコードのキー or 廃油レコードID） */
  targetKey: string;
  /** どの投稿（画像）から見つけたか */
  sourceId: string;
}

export interface DailyRecord {
  key: string;
  storeId: string;
  businessDate: ISODate;
  /** 日計表の入金対象額 */
  target: number | null;
  /** 日計表を読み取った投稿 */
  receiptSourceId: string | null;
  deposits: DepositAssignment[];
  /** 最新の投稿で見つかった問題（判読不能・検算不一致など） */
  docIssues: Issue[];
  /** 入金行が決められなかった理由 */
  allocationIssue: Issue | null;
}

export interface OilRecord {
  id: string;
  storeId: string;
  receiptDate: ISODate;
  amount: number;
  bottles: number | null;
  deposit: DepositAssignment | null;
  issue: Issue | null;
}

export interface CashCheck {
  messageId: string;
  senderUserId: string;
  text: string;
  from: ISODate;
  to: ISODate;
  receivedAt: string;
}

/** 日付を特定できなかった投稿（判読不能など）。提出はあったものとして扱う */
export interface UnattachedSubmission {
  sourceId: string;
  storeId: string;
  postedOn: ISODate;
  issues: Issue[];
}

/** 監査ログ兼「過去分更新」の材料 */
export interface LedgerEvent {
  seq: number;
  type:
    | "RECEIPT_RECORDED"
    | "RECEIPT_CONFLICT"
    | "INITIAL_DEPOSIT_MATCHED"
    | "COIN_DEPOSIT_MATCHED"
    | "OIL_DEPOSIT_MATCHED"
    | "ALLOCATION_FAILED"
    | "CASH_CHECK_RECORDED"
    | "CASH_CHECK_REJECTED"
    | "SUBMISSION_UNREADABLE"
    | "DUPLICATE_SOURCE_IGNORED";
  storeId: string | null;
  businessDate: ISODate | null;
  sourceId: string | null;
  detail: string;
}

export const recordKey = (storeId: string, businessDate: ISODate) => `${storeId}:${businessDate}`;

export class Ledger {
  readonly records = new Map<string, DailyRecord>();
  readonly assignments = new Map<string, DepositAssignment>();
  readonly oils = new Map<string, OilRecord>();
  readonly cashChecks = new Map<string, CashCheck>();
  readonly processedSources = new Set<string>();
  readonly unattached: UnattachedSubmission[] = [];
  readonly reviewMessages: { messageId: string; issue: Issue }[] = [];
  readonly events: LedgerEvent[] = [];

  log(e: Omit<LedgerEvent, "seq">): void {
    this.events.push({ ...e, seq: this.events.length + 1 });
  }

  getOrCreateRecord(storeId: string, businessDate: ISODate): DailyRecord {
    const key = recordKey(storeId, businessDate);
    let r = this.records.get(key);
    if (!r) {
      r = { key, storeId, businessDate, target: null, receiptSourceId: null, deposits: [], docIssues: [], allocationIssue: null };
      this.records.set(key, r);
    }
    return r;
  }

  recordsOf(storeId: string): DailyRecord[] {
    return [...this.records.values()]
      .filter((r) => r.storeId === storeId)
      .sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  }

  /** 通帳の行を割り当てる。既に使われていれば false（二重加算しない） */
  assign(a: DepositAssignment): boolean {
    if (this.assignments.has(a.fingerprint)) return false;
    this.assignments.set(a.fingerprint, a);
    return true;
  }
}
