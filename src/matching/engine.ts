import type { AppConfig, StoreConfig } from "../config/config";
import { bankOf, getStore } from "../config/config";
import { normalizeLabel } from "../domain/text";
import { addDays, type BankCalendar, type ISODate } from "../domain/calendar";
import type { AnalysisResult } from "../pipeline/analyze";
import type { OilDocument, PassbookLine, SalesDocument } from "../validation/normalize";
import { review, type Issue } from "../validation/issues";
import { Ledger, recordKey, type DailyRecord, type DepositAssignment } from "./ledger";

export interface EngineContext {
  cfg: AppConfig;
  calendar: BankCalendar;
}

/** 照合に使ってよい通帳行（読み取り確実・2系統一致・残高検算済み・入金行・未使用） */
type CleanRow = PassbookLine & { date: ISODate; deposit: number; withdrawal: number; balance: number };

const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
const md = (d: ISODate) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

export function fingerprint(storeId: string, r: CleanRow): string {
  return `${storeId}|${r.date}|${r.deposit}|${r.withdrawal}|${r.balance}`;
}

export function splitBillsCoins(target: number, billUnit: number) {
  const bills = Math.floor(target / billUnit) * billUnit;
  return { bills, coins: target - bills };
}

function isClean(ctx: EngineContext, r: PassbookLine): r is CleanRow {
  if (r.index < 0 || !r.legible || r.disputed) return false;
  if (r.date === null || r.deposit === null || r.withdrawal === null || r.balance === null) return false;
  if (ctx.cfg.rules.requireBalanceChain && !r.chainVerified) return false;
  return true;
}

/** 売上・廃油の入金として扱える行か（ATM等の摘要のみ。振込・利息・繰越は対象外） */
function isDepositRow(ctx: EngineContext, store: StoreConfig, r: CleanRow): boolean {
  if (r.deposit <= 0 || r.withdrawal !== 0) return false;
  const desc = normalizeLabel(r.description);
  if (ctx.cfg.excludedDescriptionKeywords.some((k) => desc.includes(normalizeLabel(k)))) return false;
  return bankOf(ctx.cfg, store).depositDescriptions.some((k) => desc.includes(normalizeLabel(k)));
}

function hasOilNote(ctx: EngineContext, r: PassbookLine): boolean {
  return ctx.cfg.oilReceipt.noteKeywords.some((k) => r.note.includes(k));
}

/**
 * 期間 [from, to] に入っている「かもしれない」照合に使えない行。
 * 通帳は日付順なので、日付が読めない行は前後の行の日付から範囲を推定する。
 */
function uncertainRowsInWindow(ctx: EngineContext, rows: PassbookLine[], from: ISODate, to: ISODate): PassbookLine[] {
  const main = rows.filter((r) => r.index >= 0);
  const out: PassbookLine[] = [];
  main.forEach((r, i) => {
    if (isClean(ctx, r)) return;
    // 2系統とも「お預り欄は空欄」と読んだ行（繰越・引き出しなど）は入金候補になり得ない
    if (!r.disputed && r.balanceOk && r.deposit === 0) return;
    if (r.date !== null) {
      if (r.date >= from && r.date <= to) out.push(r);
      return;
    }
    const prev = main.slice(0, i).reverse().find((x) => x.date !== null)?.date ?? "0000-01-01";
    const next = main.slice(i + 1).find((x) => x.date !== null)?.date ?? "9999-12-31";
    if (prev <= to && next >= from) out.push(r);
  });
  for (const r of rows.filter((x) => x.index < 0)) {
    if (r.date === null || (r.date >= from && r.date <= to)) out.push(r);
  }
  return out;
}

function availableRows(ctx: EngineContext, ledger: Ledger, store: StoreConfig, rows: PassbookLine[]): CleanRow[] {
  return rows.filter((r): r is CleanRow => isClean(ctx, r) && isDepositRow(ctx, store, r) && !ledger.assignments.has(fingerprint(store.id, r)));
}

function deposit(storeId: string, r: CleanRow, kind: DepositAssignment["kind"], targetKey: string, sourceId: string): DepositAssignment {
  return { fingerprint: fingerprint(storeId, r), storeId, date: r.date, amount: r.deposit, kind, targetKey, sourceId };
}

/** 営業日Dの最初の入金（お札、またはお札＋小銭）を通帳から探す */
function allocateInitial(ctx: EngineContext, ledger: Ledger, store: StoreConfig, rec: DailyRecord, rows: PassbookLine[], sourceId: string) {
  if (rec.target === null || rec.docIssues.length > 0) return;
  if (rec.deposits.some((d) => d.kind === "INITIAL")) return;
  const from = addDays(rec.businessDate, 1);
  const to = addDays(from, ctx.cfg.rules.depositGraceDays);
  const inWindow = availableRows(ctx, ledger, store, rows).filter((r) => r.date >= from && r.date <= to);
  const uncertain = uncertainRowsInWindow(ctx, rows, from, to);
  const { bills, coins } = splitBillsCoins(rec.target, ctx.cfg.billUnit);

  // 通帳がまだ D+1 まで記帳されていない写真なら、判断材料なし（前回の判定を維持）
  const latest = rows.reduce<ISODate | null>((m, r) => (r.date && (!m || r.date > m) ? r.date : m), null);
  if (latest === null || latest < from) {
    if (!rec.allocationIssue) rec.allocationIssue = review("DEPOSIT_NOT_FOUND", `${md(from)}の入金が写真の通帳に記帳されていない`);
    return;
  }

  if (uncertain.length > 0) {
    rec.allocationIssue = review("UNCERTAIN_ROWS", `${md(from)}付近の通帳の行に、確実に読めない行がある`);
    ledger.log({ type: "ALLOCATION_FAILED", storeId: store.id, businessDate: rec.businessDate, sourceId, detail: rec.allocationIssue.message });
    return;
  }

  const full = inWindow.filter((r) => r.deposit === rec.target);
  const billsOnly = coins > 0 ? inWindow.filter((r) => r.deposit === bills) : [];
  let chosen: CleanRow | null = null;
  let issue: Issue | null = null;

  if (full.length === 1) chosen = full[0]!;
  else if (full.length > 1) issue = review("MULTIPLE_CANDIDATES", `${md(from)}に同じ金額(${yen(rec.target)})の入金が複数あり、特定できない`);
  else if (store.coinPolicy !== "SAME_DAY" && billsOnly.length === 1) chosen = billsOnly[0]!;
  else if (billsOnly.length > 1) issue = review("MULTIPLE_CANDIDATES", `${md(from)}に同じ金額(${yen(bills)})の入金が複数あり、特定できない`);
  else if (store.coinPolicy === "SAME_DAY" && billsOnly.length === 1) {
    issue = review("COINS_MISSING", `入金 ${yen(bills)}（日計表 ${yen(rec.target)}）。小銭 ${yen(coins)} が入金されていない`);
  } else {
    const seen = inWindow.map((r) => yen(r.deposit)).join("・") || "なし";
    issue = review("AMOUNT_MISMATCH", `日計表 ${yen(rec.target)} に一致する${md(from)}の入金がない（${md(from)}の入金: ${seen}）`);
  }

  if (chosen) {
    const a = deposit(store.id, chosen, "INITIAL", rec.key, sourceId);
    if (ledger.assign(a)) {
      rec.deposits.push(a);
      rec.allocationIssue = null;
      ledger.log({ type: "INITIAL_DEPOSIT_MATCHED", storeId: store.id, businessDate: rec.businessDate, sourceId, detail: `${md(a.date)} ${yen(a.amount)}` });
    }
  } else if (issue) {
    rec.allocationIssue = issue;
    ledger.log({ type: "ALLOCATION_FAILED", storeId: store.id, businessDate: rec.businessDate, sourceId, detail: issue.message });
  }
}

export function remainingOf(rec: DailyRecord): number | null {
  if (rec.target === null) return null;
  return rec.target - rec.deposits.reduce((a, d) => a + d.amount, 0);
}

export function coinDeadline(ctx: EngineContext, businessDate: ISODate): ISODate {
  return ctx.calendar.addBankBusinessDays(businessDate, ctx.cfg.rules.coinMaxWaitBankDays);
}

/**
 * 後日入金の小銭（京大前・ほりまる）を、残額と金額で照合して割り当てる。
 * 行と残額が1対1に決まるものだけを割り当て、複数候補は要確認にする（推測しない）。
 */
function allocateCoins(ctx: EngineContext, ledger: Ledger, store: StoreConfig, rows: PassbookLine[], sourceId: string) {
  if (store.coinPolicy !== "DEFERRED") return;
  const open = ledger
    .recordsOf(store.id)
    .filter((r) => r.docIssues.length === 0 && r.deposits.some((d) => d.kind === "INITIAL"))
    .map((r) => ({ rec: r, remaining: remainingOf(r)! }))
    .filter((x) => x.remaining > 0 && x.remaining < ctx.cfg.billUnit);
  if (open.length === 0) return;

  const candidates = availableRows(ctx, ledger, store, rows).filter((r) => r.deposit < ctx.cfg.billUnit && !hasOilNote(ctx, r));
  const fits = (o: (typeof open)[number], r: CleanRow) =>
    r.deposit === o.remaining && r.date > o.rec.businessDate && r.date <= coinDeadline(ctx, o.rec.businessDate);

  for (const o of open) {
    const rowsForRec = candidates.filter((r) => fits(o, r));
    if (rowsForRec.length === 0) continue;
    const row = rowsForRec[0]!;
    const recsForRow = open.filter((x) => fits(x, row));
    if (rowsForRec.length > 1 || recsForRow.length > 1) {
      o.rec.allocationIssue = review("COIN_AMBIGUOUS", `小銭 ${yen(o.remaining)} の入金候補が複数あり、どの営業日の分か特定できない`);
      ledger.log({ type: "ALLOCATION_FAILED", storeId: store.id, businessDate: o.rec.businessDate, sourceId, detail: o.rec.allocationIssue.message });
      continue;
    }
    const a = deposit(store.id, row, "COIN", o.rec.key, sourceId);
    if (ledger.assign(a)) {
      o.rec.deposits.push(a);
      o.rec.allocationIssue = null;
      ledger.log({ type: "COIN_DEPOSIT_MATCHED", storeId: store.id, businessDate: o.rec.businessDate, sourceId, detail: `${md(a.date)} 小銭 ${yen(a.amount)}` });
    }
  }
}

function allocateOil(ctx: EngineContext, ledger: Ledger, store: StoreConfig, oilId: string, rows: PassbookLine[], sourceId: string) {
  const oil = ledger.oils.get(oilId);
  if (!oil || oil.deposit) return;
  const from = oil.receiptDate;
  const to = addDays(ctx.calendar.firstBankBusinessDayOnOrAfter(oil.receiptDate), ctx.cfg.rules.oilGraceDays);
  const cands = availableRows(ctx, ledger, store, rows).filter((r) => r.deposit === oil.amount && r.date >= from && r.date <= to);
  const noted = cands.filter((r) => hasOilNote(ctx, r));
  const pick = cands.length === 1 ? cands[0]! : noted.length === 1 ? noted[0]! : null;
  if (!pick) {
    oil.issue =
      cands.length === 0
        ? review("OIL_NOT_FOUND", `受取書 ${yen(oil.amount)}（${md(oil.receiptDate)}）に一致する入金が${md(from)}〜${md(to)}に見つからない`)
        : review("OIL_AMBIGUOUS", `${yen(oil.amount)} の入金が複数あり、どれが油入金か特定できない`);
    ledger.log({ type: "ALLOCATION_FAILED", storeId: store.id, businessDate: null, sourceId, detail: oil.issue.message });
    return;
  }
  const a = deposit(store.id, pick, "OIL", oil.id, sourceId);
  if (ledger.assign(a)) {
    oil.deposit = a;
    oil.issue = null;
    ledger.log({ type: "OIL_DEPOSIT_MATCHED", storeId: store.id, businessDate: null, sourceId, detail: `受取書 ${md(oil.receiptDate)} ${yen(oil.amount)} → 入金 ${md(a.date)}` });
  }
}

/** 通帳の写真が届くたびに、その店舗の未完了レコードを全部見直す（過去分の追加入金に対応） */
function reconcileStore(ctx: EngineContext, ledger: Ledger, store: StoreConfig, rows: PassbookLine[], sourceId: string) {
  for (const oil of ledger.oils.values()) {
    if (oil.storeId === store.id) allocateOil(ctx, ledger, store, oil.id, rows, sourceId);
  }
  for (const rec of ledger.recordsOf(store.id)) allocateInitial(ctx, ledger, store, rec, rows, sourceId);
  allocateCoins(ctx, ledger, store, rows, sourceId);
}

export interface Submission {
  /** LINEのメッセージIDなど、投稿を一意に識別するID */
  sourceId: string;
  storeId: string;
  postedOn: ISODate;
  analysis: AnalysisResult;
}

/** 解析済みの投稿を台帳へ反映する。同じ sourceId は二度処理しない（冪等） */
export function applySubmission(ctx: EngineContext, ledger: Ledger, sub: Submission): void {
  if (ledger.processedSources.has(sub.sourceId)) {
    ledger.log({ type: "DUPLICATE_SOURCE_IGNORED", storeId: sub.storeId, businessDate: null, sourceId: sub.sourceId, detail: "処理済みの投稿" });
    return;
  }
  ledger.processedSources.add(sub.sourceId);
  const store = getStore(ctx.cfg, sub.storeId);
  const { doc, issues } = sub.analysis;

  if (!doc) {
    ledger.unattached.push({ sourceId: sub.sourceId, storeId: store.id, postedOn: sub.postedOn, issues });
    ledger.log({ type: "SUBMISSION_UNREADABLE", storeId: store.id, businessDate: null, sourceId: sub.sourceId, detail: issues.map((i) => i.message).join(" / ") });
    return;
  }

  if (doc.kind === "sales") {
    applySalesDoc(ctx, ledger, store, doc, issues, sub.sourceId);
    if (issues.length === 0) reconcileStore(ctx, ledger, store, doc.rows, sub.sourceId);
  } else {
    applyOilDoc(ctx, ledger, store, doc, issues, sub.sourceId);
    if (issues.length === 0) reconcileStore(ctx, ledger, store, doc.rows, sub.sourceId);
  }
}

function applySalesDoc(ctx: EngineContext, ledger: Ledger, store: StoreConfig, doc: SalesDocument, issues: Issue[], sourceId: string) {
  const rec = ledger.getOrCreateRecord(store.id, doc.businessDate);
  if (issues.length > 0) {
    // 問題のある投稿の数値は採用しない。すでに正常な記録があればそれを優先
    if (rec.target === null) rec.docIssues = issues;
    ledger.log({ type: "SUBMISSION_UNREADABLE", storeId: store.id, businessDate: doc.businessDate, sourceId, detail: issues.map((i) => i.message).join(" / ") });
    return;
  }
  if (rec.target !== null && rec.target !== doc.depositAmount) {
    rec.docIssues = [review("RECEIPT_CONFLICT", `同じ営業日の日計表の金額が投稿ごとに違う（${yen(rec.target)} / ${yen(doc.depositAmount)}）`)];
    ledger.log({ type: "RECEIPT_CONFLICT", storeId: store.id, businessDate: doc.businessDate, sourceId, detail: rec.docIssues[0]!.message });
    return;
  }
  if (rec.target === null) {
    rec.target = doc.depositAmount;
    rec.receiptSourceId = sourceId;
    rec.docIssues = [];
    ledger.log({ type: "RECEIPT_RECORDED", storeId: store.id, businessDate: doc.businessDate, sourceId, detail: `日計表 ${yen(doc.depositAmount)}` });
  }
}

function applyOilDoc(ctx: EngineContext, ledger: Ledger, store: StoreConfig, doc: OilDocument, issues: Issue[], sourceId: string) {
  void ctx;
  if (issues.length > 0) {
    // 問題のある受取書の数値は照合に使わない
    ledger.unattached.push({ sourceId, storeId: store.id, postedOn: doc.receiptDate, issues });
    ledger.log({ type: "SUBMISSION_UNREADABLE", storeId: store.id, businessDate: null, sourceId, detail: issues.map((i) => i.message).join(" / ") });
    return;
  }
  const id = `oil:${sourceId}`;
  ledger.oils.set(id, {
    id,
    storeId: store.id,
    receiptDate: doc.receiptDate,
    amount: doc.amount,
    bottles: doc.bottles,
    deposit: null,
    issue: null,
  });
}

export { recordKey };
