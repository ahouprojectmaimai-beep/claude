import { z } from "zod";

/**
 * LINE Messaging API の Webhook イベント（このシステムで使う部分だけ）。
 * 未知の項目は無視し、未知のイベント種別も受け取ってから捨てる（落ちないように）。
 */
const Source = z.object({
  type: z.string(),
  groupId: z.string().optional(),
  roomId: z.string().optional(),
  userId: z.string().optional(),
});

const Message = z.object({
  id: z.string(),
  type: z.string(),
  text: z.string().optional(),
  quoteToken: z.string().optional(),
  imageSet: z.object({ id: z.string(), index: z.number().optional(), total: z.number().optional() }).optional(),
});

export const WebhookEvent = z.object({
  type: z.string(),
  webhookEventId: z.string(),
  timestamp: z.number(),
  mode: z.string().optional(),
  source: Source.optional(),
  replyToken: z.string().optional(),
  deliveryContext: z.object({ isRedelivery: z.boolean() }).optional(),
  message: Message.optional(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const WebhookBody = z.object({
  destination: z.string(),
  events: z.array(z.unknown()),
});

/** 本文をパースし、形の合うイベントだけ返す（形の合わないものは捨てて件数を返す） */
export function parseWebhook(body: string): { events: WebhookEvent[]; skipped: number } {
  const parsed = WebhookBody.parse(JSON.parse(body));
  const events: WebhookEvent[] = [];
  let skipped = 0;
  for (const e of parsed.events) {
    const r = WebhookEvent.safeParse(e);
    if (r.success) events.push(r.data);
    else skipped++;
  }
  return { events, skipped };
}
