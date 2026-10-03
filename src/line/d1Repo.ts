import type { D1Database } from "../worker/bindings";
import type { Job, LineRepo, StoreClaim, StoredEvent, StoredImage } from "./repo";

interface ImageRow {
  message_id: string;
  group_id: string;
  user_id: string;
  posted_at: number;
  r2_key: string;
  sha256: string;
  status: StoredImage["status"];
  store_id: string | null;
  claim_message_id: string | null;
  duplicate_of: string | null;
}
const toImage = (r: ImageRow): StoredImage => ({
  messageId: r.message_id,
  groupId: r.group_id,
  userId: r.user_id,
  postedAt: r.posted_at,
  r2Key: r.r2_key,
  sha256: r.sha256,
  status: r.status,
  storeId: r.store_id,
  claimMessageId: r.claim_message_id,
  duplicateOf: r.duplicate_of,
});

/** LineRepo の D1（SQLite）実装。INSERT OR IGNORE で一意キー重複を無視し、冪等にする */
export class D1LineRepo implements LineRepo {
  constructor(private readonly db: D1Database) {}

  async insertEvent(e: StoredEvent) {
    const r = await this.db
      .prepare(
        `INSERT OR IGNORE INTO line_events (webhook_event_id, type, source_type, group_id, user_id, message_id, timestamp, received_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.webhookEventId, e.type, e.sourceType, e.groupId, e.userId, e.messageId, e.timestamp, e.receivedAt, e.payloadJson)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  async upsertGroup(groupId: string, joinedAt: number) {
    await this.db.prepare(`INSERT OR IGNORE INTO line_groups (group_id, joined_at) VALUES (?, ?)`).bind(groupId, joinedAt).run();
  }
  async findImageByMessageId(id: string) {
    const r = await this.db.prepare(`SELECT * FROM images WHERE message_id = ?`).bind(id).first<ImageRow>();
    return r ? toImage(r) : null;
  }
  async findImageByHash(sha: string) {
    const r = await this.db
      .prepare(`SELECT * FROM images WHERE sha256 = ? AND status != 'DUPLICATE' ORDER BY posted_at LIMIT 1`)
      .bind(sha)
      .first<ImageRow>();
    return r ? toImage(r) : null;
  }
  async insertImage(i: StoredImage) {
    const r = await this.db
      .prepare(
        `INSERT OR IGNORE INTO images (message_id, group_id, user_id, posted_at, r2_key, sha256, status, store_id, claim_message_id, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(i.messageId, i.groupId, i.userId, i.postedAt, i.r2Key, i.sha256, i.status, i.storeId, i.claimMessageId, i.duplicateOf)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  async updateImage(id: string, p: Partial<Pick<StoredImage, "status" | "storeId" | "claimMessageId">>) {
    await this.db
      .prepare(
        `UPDATE images SET status = COALESCE(?, status), store_id = COALESCE(?, store_id), claim_message_id = COALESCE(?, claim_message_id) WHERE message_id = ?`,
      )
      .bind(p.status ?? null, p.storeId ?? null, p.claimMessageId ?? null, id)
      .run();
  }
  async insertClaim(c: StoreClaim) {
    const r = await this.db
      .prepare(`INSERT OR IGNORE INTO store_claims (message_id, group_id, user_id, posted_at, store_id, ambiguous) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(c.messageId, c.groupId, c.userId, c.postedAt, c.storeId, c.ambiguous ? 1 : 0)
      .run();
    return (r.meta.changes ?? 0) > 0;
  }
  async latestClaim(groupId: string, userId: string, from: number, to: number) {
    const r = await this.db
      .prepare(
        `SELECT * FROM store_claims WHERE group_id = ? AND user_id = ? AND posted_at BETWEEN ? AND ? ORDER BY posted_at DESC LIMIT 1`,
      )
      .bind(groupId, userId, from, to)
      .first<{ message_id: string; group_id: string; user_id: string; posted_at: number; store_id: string | null; ambiguous: number }>();
    return r
      ? { messageId: r.message_id, groupId: r.group_id, userId: r.user_id, postedAt: r.posted_at, storeId: r.store_id, ambiguous: r.ambiguous === 1 }
      : null;
  }
  async waitingImages(groupId: string, userId: string, from: number, to: number) {
    const r = await this.db
      .prepare(`SELECT * FROM images WHERE group_id = ? AND user_id = ? AND status = 'WAITING_STORE' AND posted_at BETWEEN ? AND ?`)
      .bind(groupId, userId, from, to)
      .all<ImageRow>();
    return r.results.map(toImage);
  }
  async enqueueJob(job: Job) {
    const r = await this.db.prepare(`INSERT OR IGNORE INTO jobs (job_id, kind, payload_json) VALUES (?, ?, ?)`).bind(job.jobId, job.kind, JSON.stringify(job)).run();
    return (r.meta.changes ?? 0) > 0;
  }
}
