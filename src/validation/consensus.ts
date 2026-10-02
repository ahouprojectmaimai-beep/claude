import type { NormalizedDocument, PassbookLine } from "./normalize";
import { unreadable, type Issue } from "./issues";

function rowKey(r: PassbookLine): string | null {
  if (!r.legible) return null;
  return `${r.date}|${r.deposit}|${r.withdrawal}|${r.balance}`;
}

/**
 * 2系統以上の独立した読み取り結果を突き合わせる。
 * - 営業日・入金対象額などの主要項目が1つでも違えば「画像判読不能」
 * - 通帳の行は、全系統で完全一致した行だけを採用し、それ以外は disputed（照合に使わない）
 */
export function buildConsensus(docs: readonly NormalizedDocument[]): { doc: NormalizedDocument | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const first = docs[0];
  if (!first) return { doc: null, issues: [unreadable("NO_EXTRACTION", "読み取り結果がない")] };
  if (docs.length < 2) {
    return { doc: null, issues: [unreadable("SINGLE_EXTRACTION", "独立した読み取りが2系統そろっていない")] };
  }

  for (const other of docs.slice(1)) {
    if (other.kind !== first.kind) {
      issues.push(unreadable("KIND_DISAGREE", "書類の種類の判定が一致しない"));
      continue;
    }
    const diffs: string[] = [];
    if (first.kind === "sales" && other.kind === "sales") {
      if (first.businessDate !== other.businessDate) diffs.push("営業日");
      if (first.depositAmount !== other.depositAmount) diffs.push("入金対象額");
      if (first.cashOnHand !== other.cashOnHand) diffs.push("在高実績");
      if (first.nextDayFloat !== other.nextDayFloat) diffs.push("翌準備金");
      if (JSON.stringify(first.denominations) !== JSON.stringify(other.denominations)) diffs.push("金種");
    } else if (first.kind === "oil" && other.kind === "oil") {
      if (first.receiptDate !== other.receiptDate) diffs.push("受取書の日付");
      if (first.amount !== other.amount) diffs.push("廃油金額");
    }
    if (diffs.length > 0) issues.push(unreadable("FIELDS_DISAGREE", `読み取り結果が一致しない: ${diffs.join("・")}`));
  }
  if (issues.length > 0) return { doc: null, issues };

  // 通帳行: 他の全系統に同じ行（多重集合として）があるものだけ合意とする
  const otherCounts = docs.slice(1).map((d) => {
    const m = new Map<string, number>();
    for (const r of d.rows) {
      const k = rowKey(r);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  });
  const rows: PassbookLine[] = first.rows.map((r) => {
    const k = rowKey(r);
    let agreed = k !== null;
    for (const m of otherCounts) {
      const c = k ? (m.get(k) ?? 0) : 0;
      if (c <= 0) agreed = false;
      else if (k) m.set(k, c - 1);
    }
    return { ...r, disputed: !agreed, problems: agreed ? r.problems : [...r.problems, "2系統の読み取りが一致しない"] };
  });
  // 他系統にだけ存在した行も「不一致行」として残す（照合期間内にあれば要確認にするため）
  const extras: PassbookLine[] = [];
  docs.slice(1).forEach((d, i) => {
    const m = otherCounts[i]!;
    for (const r of d.rows) {
      const k = rowKey(r);
      if (k && (m.get(k) ?? 0) > 0) {
        m.set(k, m.get(k)! - 1);
        extras.push({ ...r, index: -1, disputed: true, chainVerified: false, problems: [...r.problems, "片方の読み取りにだけある行"] });
      } else if (!k) {
        extras.push({ ...r, index: -1, disputed: true, chainVerified: false });
      }
    }
  });

  return { doc: { ...first, rows: [...rows, ...extras] }, issues };
}
