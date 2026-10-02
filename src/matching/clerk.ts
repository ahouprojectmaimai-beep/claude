import type { ISODate } from "../domain/calendar";
import { review } from "../validation/issues";
import { parseCashCheckMessage } from "./cashCheck";
import type { EngineContext } from "./engine";
import type { Ledger } from "./ledger";

export interface TextMessage {
  messageId: string;
  senderUserId: string;
  text: string;
  /** 受信日時（ISO 8601） */
  receivedAt: string;
  /** 受信日（JST） */
  receivedOn: ISODate;
}

/**
 * 事務員の「○日〜○日分 現金チェックOK」を台帳へ反映（同志社前店の第2段階）。
 * 登録済みの事務員以外の発言・解釈できない書き方は反映せず要確認へ。
 */
export function applyCashCheckMessage(ctx: EngineContext, ledger: Ledger, msg: TextMessage): "ignored" | "recorded" | "rejected" {
  if (ledger.cashChecks.has(msg.messageId) || ledger.processedSources.has(msg.messageId)) return "ignored";
  const parsed = parseCashCheckMessage(msg.text, msg.receivedOn, ctx.cfg.cashCheck.maxRangeDays);
  if (parsed.kind === "not_cash_check") return "ignored";
  ledger.processedSources.add(msg.messageId);
  const storeId = ctx.cfg.cashCheck.storeId;

  if (!ctx.cfg.cashCheck.clerkUserIds.includes(msg.senderUserId)) {
    const issue = review("CASH_CHECK_UNKNOWN_SENDER", "登録されていない人から「現金チェックOK」が投稿された（反映していません）");
    ledger.reviewMessages.push({ messageId: msg.messageId, issue });
    ledger.log({ type: "CASH_CHECK_REJECTED", storeId, businessDate: null, sourceId: msg.messageId, detail: issue.message });
    return "rejected";
  }
  if (parsed.kind === "error") {
    const issue = review("CASH_CHECK_UNPARSEABLE", `「現金チェックOK」の期間を読み取れない: ${parsed.reason}`);
    ledger.reviewMessages.push({ messageId: msg.messageId, issue });
    ledger.log({ type: "CASH_CHECK_REJECTED", storeId, businessDate: null, sourceId: msg.messageId, detail: issue.message });
    return "rejected";
  }
  ledger.cashChecks.set(msg.messageId, {
    messageId: msg.messageId,
    senderUserId: msg.senderUserId,
    text: msg.text,
    from: parsed.from,
    to: parsed.to,
    receivedAt: msg.receivedAt,
  });
  ledger.log({ type: "CASH_CHECK_RECORDED", storeId, businessDate: null, sourceId: msg.messageId, detail: `${parsed.from}〜${parsed.to} 現金確認済み` });
  return "recorded";
}

export function isCashChecked(ledger: Ledger, businessDate: ISODate): boolean {
  for (const c of ledger.cashChecks.values()) {
    if (c.from <= businessDate && businessDate <= c.to) return true;
  }
  return false;
}
