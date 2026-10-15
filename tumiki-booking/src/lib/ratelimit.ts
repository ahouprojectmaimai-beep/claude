import type { DB } from "./db.ts";

/** 固定ウィンドウのレート制限。上限を超えたら false */
export async function allow(db: DB, key: string, windowSec: number, limit: number, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const window = Math.floor(now / windowSec);
  const row = await db
    .prepare("INSERT INTO rate_limits (key, window, count, expires) VALUES (?,?,1,?) ON CONFLICT(key, window) DO UPDATE SET count = count + 1 RETURNING count")
    .bind(key, window, (window + 1) * windowSec)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

export async function purgeRateLimits(db: DB, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE expires < ?").bind(now).run();
}
