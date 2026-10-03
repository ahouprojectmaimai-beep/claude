import { loadDefaultConfig } from "../config/load";
import { LineClient } from "../line/client";
import { D1LineRepo } from "../line/d1Repo";
import { parseWebhook, WebhookEvent } from "../line/events";
import { handleEvent } from "../line/handler";
import { verifyLineSignature } from "../line/signature";
import type { Env, ExecutionContext, MessageBatch } from "./bindings";

const PAIR_WINDOW_MS = 10 * 60 * 1000;

/**
 * Webhook 受信（すぐ 200 を返す）:
 *   署名検証 → イベントを保存（webhookEventId で重複排除）→ キューへ
 * キュー処理（リトライあり）:
 *   画像の保存・店舗の紐付け・返信・解析の仕事を積む
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
    if (request.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });

    const body = await request.text();
    if (!(await verifyLineSignature(body, request.headers.get("x-line-signature"), env.LINE_CHANNEL_SECRET))) {
      return new Response("invalid signature", { status: 401 });
    }
    const { events, skipped } = parseWebhook(body);
    if (skipped > 0) console.warn(`webhook: 形式の合わないイベント ${skipped}件をスキップ`);
    const repo = new D1LineRepo(env.DB);
    for (const ev of events) {
      const isNew = await repo.insertEvent({
        webhookEventId: ev.webhookEventId,
        type: ev.type,
        sourceType: ev.source?.type ?? null,
        groupId: ev.source?.groupId ?? null,
        userId: ev.source?.userId ?? null,
        messageId: ev.message?.id ?? null,
        timestamp: ev.timestamp,
        receivedAt: new Date().toISOString(),
        payloadJson: JSON.stringify(ev),
      });
      // 再送されたイベントは前回キュー投入に失敗した可能性があるため、もう一度投入する（後段は冪等）
      if (isNew || ev.deliveryContext?.isRedelivery) await env.EVENTS.send(ev);
    }
    // 保存に失敗した場合は例外 → 500 → LINE側が再送（webhookEventId で二重処理しない）
    return new Response("ok");
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const deps = {
      cfg: loadDefaultConfig(),
      repo: new D1LineRepo(env.DB),
      line: new LineClient(env.LINE_CHANNEL_ACCESS_TOKEN),
      images: { put: async (key: string, data: ArrayBuffer, contentType: string) => void (await env.IMAGES.put(key, data, { httpMetadata: { contentType } })) },
      postGroupId: env.POST_GROUP_ID || null,
      pairWindowMs: PAIR_WINDOW_MS,
      debugAck: env.DEBUG_ACK === "true",
    };
    for (const m of batch.messages) {
      try {
        const ev = WebhookEvent.parse(m.body);
        const result = await handleEvent(ev, deps);
        console.log(`event ${ev.type}/${ev.message?.type ?? "-"}: ${result}`);
        m.ack();
      } catch (e) {
        console.error(`event 処理失敗: ${e instanceof Error ? e.name : "unknown"}`);
        m.retry();
      }
    }
  },
};
