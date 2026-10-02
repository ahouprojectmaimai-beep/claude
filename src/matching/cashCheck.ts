import { addDays, diffDays, toISODate, type ISODate } from "../domain/calendar";
import { normalizeDigits } from "../domain/text";

export type CashCheckParse =
  | { kind: "not_cash_check" }
  | { kind: "ok"; from: ISODate; to: ISODate }
  | { kind: "error"; reason: string };

const TOKEN = /(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?|(\d{1,2})\s*日/g;

/**
 * 事務員の「9/28〜9/30分 現金チェックOK」を期間に変換する（AIは使わない）。
 * 書き方が想定外のときは推測せず error（→ 要確認）。
 * 対応例: "9/28〜9/30分" "9月28日〜30日分" "28日〜30日分" "9/28分" "9/28-30"
 */
export function parseCashCheckMessage(text: string, receivedOn: ISODate, maxRangeDays: number): CashCheckParse {
  const t = normalizeDigits(text);
  if (!/現金チェック/.test(t) || !/(OK|ＯＫ|ok|Ok|おけ|オッケー)/.test(t)) return { kind: "not_cash_check" };

  const tokens = [...t.matchAll(TOKEN)].map((m) => ({
    month: m[1] !== undefined ? Number(m[1]) : null,
    day: Number(m[2] ?? m[3]),
    end: (m.index ?? 0) + m[0].length,
    start: m.index ?? 0,
  }));
  // "9/28-30" のように後ろの日だけ数字のケース
  let usedTail = false;
  if (tokens.length === 1) {
    const tail = /^\s*[~-]\s*(\d{1,2})(?![\d/月])/.exec(t.slice(tokens[0]!.end));
    if (tail) {
      tokens.push({ month: null, day: Number(tail[1]), start: 0, end: 0 });
      usedTail = true;
    }
  }

  if (tokens.length === 0) return { kind: "error", reason: "日付が見つからない" };
  if (tokens.length > 2) return { kind: "error", reason: "日付が3つ以上あり期間を特定できない" };
  if (tokens.length === 2 && !usedTail) {
    const between = t.slice(tokens[0]!.end, tokens[1]!.start);
    if (!/^\s*(~|-|から)\s*$/.test(between)) return { kind: "error", reason: "期間の書き方を解釈できない" };
  }

  const recvYear = Number(receivedOn.slice(0, 4));
  const recvMonth = Number(receivedOn.slice(5, 7));
  const resolve = (month: number | null, day: number, fallbackMonth: number): ISODate | null => {
    const m = month ?? fallbackMonth;
    for (const y of [recvYear, recvYear - 1]) {
      const d = toISODate(y, m, day);
      if (d && d <= receivedOn) return d;
    }
    return null;
  };

  const first = tokens[0]!;
  const fromMonth =
    first.month ?? (first.day <= Number(receivedOn.slice(8, 10)) ? recvMonth : recvMonth === 1 ? 12 : recvMonth - 1);
  const from = resolve(first.month, first.day, fromMonth);
  if (!from) return { kind: "error", reason: "開始日が不正" };
  let to: ISODate | null = from;
  if (tokens.length === 2) {
    const second = tokens[1]!;
    const toMonth = second.month ?? (second.day >= first.day ? Number(from.slice(5, 7)) : (Number(from.slice(5, 7)) % 12) + 1);
    to = resolve(second.month, second.day, toMonth);
    if (to && to < from) to = null;
  }
  if (!to) return { kind: "error", reason: "終了日が不正" };
  if (diffDays(to, from) + 1 > maxRangeDays) return { kind: "error", reason: `期間が${maxRangeDays}日を超える` };
  return { kind: "ok", from, to };
}

export function datesInRange(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
