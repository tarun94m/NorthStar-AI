import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, pool } from './db.js';
import { PostgresRateLimitStore } from './rate-limit-store.js';
after(async () => { await prisma.$disconnect(); await pool.end(); });

test('PostgreSQL rate-limit store shares atomic counters across independent instances', async () => {
  const prefix = `test:${randomUUID()}:`;
  const first = new PostgresRateLimitStore(prefix);
  const second = new PostgresRateLimitStore(prefix);
  first.init({ windowMs: 60_000 } as any);
  second.init({ windowMs: 60_000 } as any);
  try {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? first : second).increment('client')));
    assert.equal(Math.max(...results.map(row => row.totalHits)), 40);
    assert.equal((await second.get('client'))?.totalHits, 40);
    await second.decrement('client');
    assert.equal((await first.get('client'))?.totalHits, 39);
    await first.resetKey('client');
    assert.equal(await second.get('client'), undefined);
  } finally { first.shutdown(); second.shutdown(); await first.resetAll(); }
});

test('PostgreSQL rate-limit store resets a key when its window expires', async () => {
  const prefix = `test-expiry:${randomUUID()}:`;
  const store = new PostgresRateLimitStore(prefix);
  store.init({ windowMs: 1 } as any);
  try {
    assert.equal((await store.increment('client')).totalHits, 1);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await store.increment('client')).totalHits, 1);
  } finally { store.shutdown(); await store.resetAll(); }
});
