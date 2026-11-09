import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

const LOCK_TTL_SECONDS = 90;
const LOCK_RENEW_MS = 20_000;

export async function acquireGenerationLock(conversationId: string) {
  const ownerToken = randomUUID();
  const result = await pool.query(
    `INSERT INTO "ConversationGenerationLock" ("conversationId", "ownerToken", "expiresAt")
     VALUES ($1::uuid, $2::uuid, now() + ($3 * interval '1 second'))
     ON CONFLICT ("conversationId") DO UPDATE
       SET "ownerToken" = EXCLUDED."ownerToken", "expiresAt" = EXCLUDED."expiresAt"
       WHERE "ConversationGenerationLock"."expiresAt" <= now()
     RETURNING "ownerToken"`,
    [conversationId, ownerToken, LOCK_TTL_SECONDS],
  );
  if (!result.rowCount) return null;
  const heartbeat = setInterval(() => {
    void pool.query(
      `UPDATE "ConversationGenerationLock" SET "expiresAt" = now() + ($2 * interval '1 second')
       WHERE "conversationId" = $1::uuid AND "ownerToken" = $3::uuid`,
      [conversationId, LOCK_TTL_SECONDS, ownerToken],
    ).catch(() => {});
  }, LOCK_RENEW_MS);
  heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    await pool.query(`DELETE FROM "ConversationGenerationLock" WHERE "conversationId" = $1::uuid AND "ownerToken" = $2::uuid`, [conversationId, ownerToken]);
  };
}

export async function consumeGuestQuota(userId: string, limit: number): Promise<boolean> {
  const utcDay = new Date().toISOString().slice(0, 10);
  const result = await pool.query(
    `INSERT INTO "DailyGuestQuota" ("id", "userId", "day", "consumed")
     VALUES ($1::uuid, $2::uuid, $3::date, 1)
     ON CONFLICT ("userId", "day") DO UPDATE
       SET "consumed" = "DailyGuestQuota"."consumed" + 1
       WHERE "DailyGuestQuota"."consumed" < $4
     RETURNING "consumed"`,
    [randomUUID(), userId, utcDay, limit],
  );
  return result.rowCount === 1;
}

export async function allocateMessageSequence(conversationId: string): Promise<number> {
  const result = await pool.query(
    `UPDATE "Conversation" SET "lastMessageSequence" = "lastMessageSequence" + 1
     WHERE "id" = $1::uuid RETURNING "lastMessageSequence"`,
    [conversationId],
  );
  if (!result.rowCount) throw new Error('Conversation disappeared while allocating a message sequence.');
  return result.rows[0].lastMessageSequence as number;
}

export async function recoverStaleGenerations(userId: string): Promise<void> {
  await pool.query(
    `UPDATE "Message" AS m
       SET "status" = CASE WHEN m."content" = '' THEN 'error' ELSE 'partial' END,
           "error" = 'Generation was interrupted before completion.'
       FROM "Conversation" AS c
       WHERE m."conversationId" = c."id" AND c."userId" = $1::uuid
         AND m."status" = 'streaming'
         AND NOT EXISTS (SELECT 1 FROM "ConversationGenerationLock" AS l
           WHERE l."conversationId" = m."conversationId" AND l."expiresAt" > now())`,
    [userId],
  );
}
