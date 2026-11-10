import type { PrismaClient } from './generated/prisma/client.js';
import { config } from './config.js';

export async function expirePendingMemorySuggestions(prisma: PrismaClient, now = new Date()) {
  const result = await prisma.memorySuggestion.updateMany({
    where: { status: 'PENDING', expiresAt: { lte: now } },
    data: { status: 'EXPIRED', decidedAt: now },
  });
  return result.count;
}

export function startMemorySuggestionExpiryWorker(prisma: PrismaClient) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await expirePendingMemorySuggestions(prisma); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick().catch(() => {}); }, config.MEMORY_EXPIRY_POLL_MS);
  timer.unref();
  void tick().catch(() => {});
  return async () => { stopped = true; clearInterval(timer); while (running) await new Promise(resolve => setTimeout(resolve, 10)); };
}
