import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, pool } from './db.js';
import { acquireGenerationLock, allocateMessageSequence, consumeGuestQuota, recoverStaleGenerations } from './coordination.js';
after(async () => { await prisma.$disconnect(); await pool.end(); });

test('PostgreSQL generation leases coordinate callers and recover after expiry', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  try {
    const contenders = await Promise.all([acquireGenerationLock(conversation.id), acquireGenerationLock(conversation.id)]);
    assert.equal(contenders.filter(Boolean).length, 1);
    const releaseOne = contenders.find(Boolean)!;
    assert.ok(releaseOne);
    await pool.query('UPDATE "ConversationGenerationLock" SET "expiresAt" = now() - interval \'1 second\' WHERE "conversationId" = $1', [conversation.id]);
    const recovered = await acquireGenerationLock(conversation.id);
    assert.ok(recovered);
    await releaseOne(); // stale owners cannot release a replacement lease
    assert.equal(await acquireGenerationLock(conversation.id), null);
    await recovered();
    const finalLease = await acquireGenerationLock(conversation.id);
    assert.ok(finalLease);
    await finalLease();
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('guest quota boundary is atomic under concurrent requests and resets by UTC date', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  try {
    const results = await Promise.all(Array.from({ length: 24 }, () => consumeGuestQuota(user.id, 7)));
    assert.equal(results.filter(Boolean).length, 7);
    assert.equal(await consumeGuestQuota(user.id, 7), false);
    const row = await prisma.dailyGuestQuota.findFirst({ where: { userId: user.id } });
    assert.equal(row?.consumed, 7);
    assert.equal(row?.day.toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('message sequence allocation is deterministic under concurrent writes', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  try {
    const numbers = await Promise.all(Array.from({ length: 30 }, () => allocateMessageSequence(conversation.id)));
    assert.deepEqual(numbers.sort((a, b) => a - b), Array.from({ length: 30 }, (_, i) => i + 1));
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('usage history survives conversation deletion with references set to null', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  try {
    const sequence = await allocateMessageSequence(conversation.id);
    const message = await prisma.message.create({ data: { conversationId: conversation.id, sequence, role: 'assistant', content: 'recorded' } });
    const usage = await prisma.usageRecord.create({ data: { userId: user.id, conversationId: conversation.id, messageId: message.id, provider: 'mock', model: 'test', inputTokens: 1, outputTokens: 1, estimatedCost: 0 } });
    await prisma.conversation.delete({ where: { id: conversation.id } });
    const retained = await prisma.usageRecord.findUnique({ where: { id: usage.id } });
    assert.ok(retained);
    assert.equal(retained.conversationId, null);
    assert.equal(retained.messageId, null);
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('recovery marks only streaming rows without an active generation lease', async () => {
  const user = await prisma.user.create({ data: { isGuest: true } });
  const conversation = await prisma.conversation.create({ data: { userId: user.id } });
  try {
    const staleSequence = await allocateMessageSequence(conversation.id);
    const stale = await prisma.message.create({ data: { conversationId: conversation.id, sequence: staleSequence, role: 'assistant', content: '', status: 'streaming' } });
    const liveSequence = await allocateMessageSequence(conversation.id);
    const live = await prisma.message.create({ data: { conversationId: conversation.id, sequence: liveSequence, role: 'assistant', content: '', status: 'streaming' } });
    await pool.query(`INSERT INTO "ConversationGenerationLock" ("conversationId", "ownerToken", "expiresAt") VALUES ($1, $2, now() + interval '1 minute')`, [conversation.id, randomUUID()]);
    await recoverStaleGenerations(user.id);
    assert.equal((await prisma.message.findUnique({ where: { id: stale.id } }))?.status, 'streaming');
    await pool.query('UPDATE "ConversationGenerationLock" SET "expiresAt" = now() - interval \'1 second\' WHERE "conversationId" = $1', [conversation.id]);
    await recoverStaleGenerations(user.id);
    assert.equal((await prisma.message.findUnique({ where: { id: stale.id } }))?.status, 'error');
    assert.equal((await prisma.message.findUnique({ where: { id: live.id } }))?.status, 'error');
  } finally { await prisma.user.delete({ where: { id: user.id } }); }
});

test('lease owner tokens are unique', () => { assert.notEqual(randomUUID(), randomUUID()); });
