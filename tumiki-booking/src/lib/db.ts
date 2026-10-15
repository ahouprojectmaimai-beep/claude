// D1 の最小インターフェース。本番は D1Database、テストは node:sqlite 製のアダプタを使う。
export interface Stmt {
  bind(...v: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface DB {
  prepare(sql: string): Stmt;
}

export const nowSec = () => Math.floor(Date.now() / 1000);
