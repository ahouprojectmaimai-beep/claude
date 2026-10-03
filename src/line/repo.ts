/**
 * LINE受信まわりの保存先。本番は D1（src/line/d1Repo.ts）、テストはメモリ実装。
 * どのメソッドも「同じものを2回入れても1回分」になるよう一意キーで守る（冪等）。
 */

export interface StoredEvent {
  webhookEventId: string;
  type: string;
  sourceType: string | null;
  groupId: string | null;
  userId: string | null;
  messageId: string | null;
  timestamp: number;
  receivedAt: string;
  /** 本文。画像の中身は含まない（画像は R2 に保存） */
  payloadJson: string;
}

export type ImageStatus = "WAITING_STORE" | "PAIRED" | "AMBIGUOUS_STORE" | "DUPLICATE";

export interface StoredImage {
  messageId: string;
  groupId: string;
  userId: string;
  postedAt: number;
  r2Key: string;
  sha256: string;
  status: ImageStatus;
  storeId: string | null;
  claimMessageId: string | null;
  /** 同じ画像（同じハッシュ）が以前に送られていた場合、その元のメッセージID */
  duplicateOf: string | null;
}

export interface StoreClaim {
  messageId: string;
  groupId: string;
  userId: string;
  postedAt: number;
  storeId: string | null;
  ambiguous: boolean;
}

/** 後段（解析・照合・現金チェック反映）へ渡す仕事。PHASE 4 で処理する */
export type Job =
  | { kind: "ANALYZE_IMAGE"; jobId: string; imageMessageId: string; storeId: string; postedAt: number }
  | { kind: "CASH_CHECK"; jobId: string; messageId: string; userId: string; text: string; postedAt: number };

export interface LineRepo {
  /** 新規なら true。再送（同じ webhookEventId）なら false */
  insertEvent(e: StoredEvent): Promise<boolean>;
  upsertGroup(groupId: string, joinedAt: number): Promise<void>;
  findImageByMessageId(messageId: string): Promise<StoredImage | null>;
  findImageByHash(sha256: string): Promise<StoredImage | null>;
  insertImage(img: StoredImage): Promise<boolean>;
  updateImage(messageId: string, patch: Partial<Pick<StoredImage, "status" | "storeId" | "claimMessageId">>): Promise<void>;
  insertClaim(c: StoreClaim): Promise<boolean>;
  /** 同じ人・同じグループで、期間内の最新の店舗名投稿 */
  latestClaim(groupId: string, userId: string, fromMs: number, toMs: number): Promise<StoreClaim | null>;
  /** 同じ人・同じグループで、店舗名待ちの画像 */
  waitingImages(groupId: string, userId: string, fromMs: number, toMs: number): Promise<StoredImage[]>;
  /** 新規なら true（同じ jobId は1回だけ） */
  enqueueJob(job: Job): Promise<boolean>;
}

export class InMemoryLineRepo implements LineRepo {
  readonly events = new Map<string, StoredEvent>();
  readonly groups = new Map<string, number>();
  readonly images = new Map<string, StoredImage>();
  readonly claims = new Map<string, StoreClaim>();
  readonly jobs = new Map<string, Job>();

  async insertEvent(e: StoredEvent) {
    if (this.events.has(e.webhookEventId)) return false;
    this.events.set(e.webhookEventId, e);
    return true;
  }
  async upsertGroup(groupId: string, joinedAt: number) {
    if (!this.groups.has(groupId)) this.groups.set(groupId, joinedAt);
  }
  async findImageByMessageId(id: string) {
    return this.images.get(id) ?? null;
  }
  async findImageByHash(sha: string) {
    return [...this.images.values()].find((i) => i.sha256 === sha && i.status !== "DUPLICATE") ?? null;
  }
  async insertImage(img: StoredImage) {
    if (this.images.has(img.messageId)) return false;
    this.images.set(img.messageId, img);
    return true;
  }
  async updateImage(id: string, patch: Partial<StoredImage>) {
    const i = this.images.get(id);
    if (i) this.images.set(id, { ...i, ...patch });
  }
  async insertClaim(c: StoreClaim) {
    if (this.claims.has(c.messageId)) return false;
    this.claims.set(c.messageId, c);
    return true;
  }
  async latestClaim(groupId: string, userId: string, from: number, to: number) {
    return (
      [...this.claims.values()]
        .filter((c) => c.groupId === groupId && c.userId === userId && c.postedAt >= from && c.postedAt <= to)
        .sort((a, b) => b.postedAt - a.postedAt)[0] ?? null
    );
  }
  async waitingImages(groupId: string, userId: string, from: number, to: number) {
    return [...this.images.values()].filter(
      (i) => i.groupId === groupId && i.userId === userId && i.status === "WAITING_STORE" && i.postedAt >= from && i.postedAt <= to,
    );
  }
  async enqueueJob(job: Job) {
    if (this.jobs.has(job.jobId)) return false;
    this.jobs.set(job.jobId, job);
    return true;
  }
}
