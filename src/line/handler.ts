import type { AppConfig } from "../config/config";
import { getStore } from "../config/config";
import type { WebhookEvent } from "./events";
import type { LineMessage } from "./client";
import type { LineRepo, StoredImage } from "./repo";
import { detectStoreClaim, isCashCheckText } from "./storeClaim";

export interface LineApi {
  getMessageContent(messageId: string): Promise<{ data: ArrayBuffer; contentType: string }>;
  reply(replyToken: string, messages: LineMessage[]): Promise<void>;
}

export interface ImageStore {
  put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
}

export interface HandlerDeps {
  cfg: AppConfig;
  repo: LineRepo;
  line: LineApi;
  images: ImageStore;
  /** 店舗が写真を投稿するグループ（未設定の間はID確認だけ応答する） */
  postGroupId: string | null;
  /** 店舗名テキストと写真を組にする時間幅（前後） */
  pairWindowMs: number;
  /** 動作確認モード：受付のたびに返信する（本番は問題があるときだけ返信） */
  debugAck: boolean;
}

const ID_COMMANDS = ["#グループID", "#グループid", "グループID確認"];

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function imageKey(groupId: string, postedAt: number, messageId: string, contentType: string): string {
  const ym = new Date(postedAt + 9 * 3_600_000).toISOString().slice(0, 7);
  const ext = contentType.includes("png") ? "png" : "jpg";
  return `images/${ym}/${groupId.slice(-8)}/${messageId}.${ext}`;
}

async function safeReply(deps: HandlerDeps, token: string | undefined, messages: LineMessage[]) {
  if (!token) return;
  try {
    await deps.line.reply(token, messages);
  } catch {
    // 返信の失敗で受付処理を止めない（返信トークンの期限切れなど）
  }
}

/** 画像を店舗に紐付け、解析の仕事を積む */
async function pair(deps: HandlerDeps, img: StoredImage, storeId: string, claimMessageId: string) {
  await deps.repo.updateImage(img.messageId, { status: "PAIRED", storeId, claimMessageId });
  await deps.repo.enqueueJob({ kind: "ANALYZE_IMAGE", jobId: `analyze:${img.messageId}`, imageMessageId: img.messageId, storeId, postedAt: img.postedAt });
}

export type HandleResult =
  | "ignored"
  | "group_id_replied"
  | "joined"
  | "claim_recorded"
  | "cash_check_queued"
  | "image_paired"
  | "image_waiting_store"
  | "image_duplicate"
  | "image_already_processed";

/**
 * Webhook イベント1件の処理（キューから呼ばれる）。何度呼ばれても結果が同じになるよう作る。
 */
export async function handleEvent(ev: WebhookEvent, deps: HandlerDeps): Promise<HandleResult> {
  const groupId = ev.source?.groupId ?? null;
  const userId = ev.source?.userId ?? null;

  if (ev.type === "join" && groupId) {
    await deps.repo.upsertGroup(groupId, ev.timestamp);
    await safeReply(deps, ev.replyToken, [
      { type: "text", text: `入金チェックBotです。参加しました。\nこのグループのID:\n${groupId}\n（管理者の方は設定に登録してください）` },
    ]);
    return "joined";
  }

  if (ev.type !== "message" || !ev.message || !groupId) return "ignored";
  const msg = ev.message;

  if (msg.type === "text" && msg.text && ID_COMMANDS.includes(msg.text.trim())) {
    await safeReply(deps, ev.replyToken, [{ type: "text", text: `このグループのID:\n${groupId}` }]);
    return "group_id_replied";
  }
  if (groupId !== deps.postGroupId || !userId) return "ignored";

  if (msg.type === "text" && msg.text) {
    if (isCashCheckText(msg.text)) {
      await deps.repo.enqueueJob({ kind: "CASH_CHECK", jobId: `cash:${msg.id}`, messageId: msg.id, userId, text: msg.text, postedAt: ev.timestamp });
      if (deps.debugAck) await safeReply(deps, ev.replyToken, [{ type: "text", text: "📥 現金チェックのメッセージを受け付けました", quoteToken: msg.quoteToken }]);
      return "cash_check_queued";
    }
    const claim = detectStoreClaim(msg.text, deps.cfg);
    if (claim.kind === "none") return "ignored";
    if (claim.kind === "ambiguous") {
      await safeReply(deps, ev.replyToken, [
        { type: "text", text: "⚠️ 店舗名が複数書かれていて、どの店舗の写真か分かりません。店舗名を1つだけ送ってください。", quoteToken: msg.quoteToken },
      ]);
      return "ignored";
    }
    await deps.repo.insertClaim({ messageId: msg.id, groupId, userId, postedAt: ev.timestamp, storeId: claim.storeId, ambiguous: false });
    // 店舗名より先に送られていた写真をさかのぼって紐付ける
    const waiting = await deps.repo.waitingImages(groupId, userId, ev.timestamp - deps.pairWindowMs, ev.timestamp);
    for (const img of waiting) await pair(deps, img, claim.storeId, msg.id);
    if (deps.debugAck && waiting.length > 0) {
      await safeReply(deps, ev.replyToken, [{ type: "text", text: `📥 受付：${getStore(deps.cfg, claim.storeId).name} 写真${waiting.length}枚` }]);
    }
    return waiting.length > 0 ? "image_paired" : "claim_recorded";
  }

  if (msg.type === "image") {
    if (await deps.repo.findImageByMessageId(msg.id)) return "image_already_processed";
    // LINE側の画像は一定期間で消えるため、受信したらすぐ自社ストレージへ保存
    const content = await deps.line.getMessageContent(msg.id);
    const sha256 = await sha256Hex(content.data);
    const r2Key = imageKey(groupId, ev.timestamp, msg.id, content.contentType);
    await deps.images.put(r2Key, content.data, content.contentType);

    const dup = await deps.repo.findImageByHash(sha256);
    const img: StoredImage = {
      messageId: msg.id,
      groupId,
      userId,
      postedAt: ev.timestamp,
      r2Key,
      sha256,
      status: dup ? "DUPLICATE" : "WAITING_STORE",
      storeId: null,
      claimMessageId: null,
      duplicateOf: dup?.messageId ?? null,
    };
    if (!(await deps.repo.insertImage(img))) return "image_already_processed";
    if (dup) {
      await safeReply(deps, ev.replyToken, [
        { type: "text", text: "ℹ️ この写真は以前にも送られています（入金は二重に数えません）", quoteToken: msg.quoteToken },
      ]);
      return "image_duplicate";
    }

    const claim = await deps.repo.latestClaim(groupId, userId, ev.timestamp - deps.pairWindowMs, ev.timestamp);
    if (claim?.storeId) {
      await pair(deps, img, claim.storeId, claim.messageId);
      if (deps.debugAck) {
        await safeReply(deps, ev.replyToken, [{ type: "text", text: `📥 受付：${getStore(deps.cfg, claim.storeId).name} 写真1枚`, quoteToken: msg.quoteToken }]);
      }
      return "image_paired";
    }
    // 店舗名がまだ届いていない。後から店舗名が来れば紐付く。来なければ18時の確認で「店舗不明の写真」として報告
    if (deps.debugAck) {
      await safeReply(deps, ev.replyToken, [{ type: "text", text: "📥 写真を受け取りました（店舗名の投稿待ち）", quoteToken: msg.quoteToken }]);
    }
    return "image_waiting_store";
  }

  return "ignored";
}
