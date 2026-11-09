import { config } from './config.js';
import { prisma, pool } from './db.js';
import { createApp } from './app.js';

const app = createApp(prisma);
const server = await (async () => {
  // Recover only orphaned generations. A different replica may still own a live lease.
  await pool.query(`UPDATE "Message" AS m
    SET "status" = CASE WHEN m."content" = '' THEN 'error' ELSE 'partial' END,
        "error" = 'Generation was interrupted before completion.'
    WHERE m."status" = 'streaming'
      AND NOT EXISTS (SELECT 1 FROM "ConversationGenerationLock" AS l
        WHERE l."conversationId" = m."conversationId" AND l."expiresAt" > now())`);
  return app.listen(config.PORT, () => console.log(`API listening on http://localhost:${config.PORT}`));
})();
async function shutdown() {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.$disconnect();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
