/**
 * Cloudflare Workers のバインディング（使う機能だけの最小の型）。
 * 秘密情報（LINE_CHANNEL_SECRET など）は `wrangler secret put` で登録し、コード・Gitには書かない。
 */
export interface D1Result<T> {
  results: T[];
  meta: { changes?: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result<unknown>>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}
export interface R2Bucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}
export interface Queue<T> {
  send(body: T): Promise<void>;
}
export interface MessageBatch<T> {
  messages: { body: T; ack(): void; retry(): void }[];
}
export interface ExecutionContext {
  waitUntil(p: Promise<unknown>): void;
}

export interface Env {
  DB: D1Database;
  IMAGES: R2Bucket;
  EVENTS: Queue<unknown>;
  /** Secret */
  LINE_CHANNEL_SECRET: string;
  /** Secret */
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** 店舗が投稿するグループのID（Botを招待後、「#グループID」で確認して設定） */
  POST_GROUP_ID?: string;
  /** 結果を報告するグループのID */
  REPORT_GROUP_ID?: string;
  /** "true" で受付のたびに返信（動作確認用） */
  DEBUG_ACK?: string;
}
