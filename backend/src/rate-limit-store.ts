import type { Options, Store } from 'express-rate-limit';
import { pool } from './db.js';

/** Shared fixed-window limiter store. PostgreSQL upserts serialize increments across replicas. */
export class PostgresRateLimitStore implements Store {
  readonly prefix: string;
  readonly localKeys = false;
  private windowMs = 60_000;
  private cleanupTimer: NodeJS.Timeout;

  constructor(prefix: string) {
    this.prefix = prefix;
    this.cleanupTimer = setInterval(() => {
      void pool.query('DELETE FROM "RateLimitCounter" WHERE "resetAt" < now() - interval \'1 day\'').catch(() => {});
    }, 60 * 60_000);
    this.cleanupTimer.unref();
  }

  init(options: Options) { this.windowMs = options.windowMs; }
  private key(key: string) { return `${this.prefix}${key}`; }

  async increment(key: string) {
    const result = await pool.query(
      `INSERT INTO "RateLimitCounter" ("key", "totalHits", "resetAt")
       VALUES ($1, 1, now() + ($2 * interval '1 millisecond'))
       ON CONFLICT ("key") DO UPDATE SET
         "totalHits" = CASE WHEN "RateLimitCounter"."resetAt" <= now() THEN 1 ELSE "RateLimitCounter"."totalHits" + 1 END,
         "resetAt" = CASE WHEN "RateLimitCounter"."resetAt" <= now() THEN now() + ($2 * interval '1 millisecond') ELSE "RateLimitCounter"."resetAt" END
       RETURNING "totalHits", "resetAt"`,
      [this.key(key), this.windowMs],
    );
    return { totalHits: result.rows[0].totalHits as number, resetTime: result.rows[0].resetAt as Date };
  }

  async decrement(key: string) {
    await pool.query(`UPDATE "RateLimitCounter" SET "totalHits" = GREATEST("totalHits" - 1, 0) WHERE "key" = $1 AND "resetAt" > now()`, [this.key(key)]);
  }

  async get(key: string) {
    const result = await pool.query(`SELECT "totalHits", "resetAt" FROM "RateLimitCounter" WHERE "key" = $1 AND "resetAt" > now()`, [this.key(key)]);
    if (!result.rowCount) return undefined;
    return { totalHits: result.rows[0].totalHits as number, resetTime: result.rows[0].resetAt as Date };
  }

  async resetKey(key: string) { await pool.query('DELETE FROM "RateLimitCounter" WHERE "key" = $1', [this.key(key)]); }
  async resetAll() { await pool.query('DELETE FROM "RateLimitCounter" WHERE left("key", length($1)) = $1', [this.prefix]); }
  shutdown() { clearInterval(this.cleanupTimer); }
}
