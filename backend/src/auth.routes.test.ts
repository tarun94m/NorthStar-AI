import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from './generated/prisma/client.js';
import { MemoryStore } from 'express-rate-limit';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'phase-one-test-secret-with-at-least-32-characters';
const { createApp } = await import('./app.js');
const { createToken } = await import('./auth.js');
const { hashPassword } = await import('./auth.js');
const { prisma, pool } = await import('./db.js');
after(async () => { await prisma.$disconnect(); await pool.end(); });
const testRateLimitStores = () => ({ api: new MemoryStore(), guestCreation: new MemoryStore() });

test('login creates a server-side session and returns an HTTP-only cookie', async () => {
  const userId = '00000000-0000-4000-8000-000000000009';
  const user = { id: userId, email: 'login@example.com', isGuest: false, passwordHash: await hashPassword('correct horse battery staple') };
  let issued: any;
  const fakePrisma = {
    user: { findUnique: async () => user },
    session: {
      create: async ({ data }: any) => (issued = { id: '10000000-0000-4000-8000-000000000009', userId, ...data, revokedAt: null }),
      findFirst: async ({ where }: any) => issued?.id === where.id && issued.expiresAt > new Date() ? issued : null,
    },
  } as any;
  const server = createApp(fakePrisma, { rateLimitStores: testRateLimitStores() }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: user.email, password: 'correct horse battery staple' }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie ?? '', /HttpOnly/i);
    assert.ok(issued?.id);
    const me = await fetch(`http://127.0.0.1:${address.port}/api/auth/me`, { headers: { Cookie: cookie!.split(';')[0]! } });
    assert.equal(me.status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('guest endpoint issues an HTTP-only session that protects user routes', async () => {
  const guest = { id: '00000000-0000-4000-8000-000000000001', email: null, isGuest: true };
  const sessions: any[] = [];
  const fakePrisma = {
    user: {
      create: async () => guest,
      findUnique: async ({ where }: any) => where.id === guest.id ? guest : null,
      deleteMany: async () => ({ count: 1 }),
    },
    session: {
      create: async ({ data }: any) => { const session = { id: '10000000-0000-4000-8000-000000000001', ...data, revokedAt: null }; sessions.push(session); return session; },
      findFirst: async ({ where }: any) => sessions.find(s => s.id === where.id && s.userId === where.userId && !s.revokedAt && s.expiresAt > new Date()) ?? null,
      updateMany: async ({ where, data }: any) => { for (const s of sessions) if (s.id === where.id && s.userId === where.userId) s.revokedAt = data.revokedAt; return { count: 1 }; },
    },
  } as unknown as PrismaClient;
  const server = createApp(fakePrisma, { acquireLock: async () => async () => {}, consumeQuota: async () => true, allocateSequence: async () => 1, rateLimitStores: testRateLimitStores() }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const created = await fetch(`${base}/api/auth/guest`, { method: 'POST' });
    assert.equal(created.status, 200);
    const cookie = created.headers.get('set-cookie');
    assert.match(cookie ?? '', /HttpOnly/i);
    assert.match(cookie ?? '', /SameSite=Lax/i);
    const token = cookie?.split(';')[0]; assert.ok(token);
    const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: token } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as any).user.isGuest, true);
    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: token } });
    assert.equal(logout.status, 204);
    const copiedToken = await fetch(`${base}/api/auth/me`, { headers: { Cookie: token } });
    assert.equal(copiedToken.status, 401);
    const unauthorized = await fetch(`${base}/api/conversations`);
    assert.equal(unauthorized.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('expired and revoked sessions are rejected; logout-all invalidates multiple sessions', async () => {
  const userId = '00000000-0000-4000-8000-000000000005';
  const sessions = [
    { id: '10000000-0000-4000-8000-000000000005', userId, expiresAt: new Date(Date.now() + 60_000), revokedAt: null },
    { id: '10000000-0000-4000-8000-000000000006', userId, expiresAt: new Date(Date.now() + 60_000), revokedAt: null },
    { id: '10000000-0000-4000-8000-000000000007', userId, expiresAt: new Date(Date.now() - 60_000), revokedAt: null },
  ];
  const fakePrisma = {
    user: { findUnique: async () => ({ id: userId, isGuest: false }) },
    session: {
      findFirst: async ({ where }: any) => sessions.find(s => s.id === where.id && s.userId === where.userId && !s.revokedAt && s.expiresAt > new Date()) ?? null,
      updateMany: async ({ where, data }: any) => { for (const s of sessions) if (s.userId === where.userId) s.revokedAt = data.revokedAt; return { count: 2 }; },
    },
  } as any;
  const server = createApp(fakePrisma, { rateLimitStores: testRateLimitStores() }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const expired = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `session=${createToken({ id: userId, guest: false }, sessions[2]!.id)}` } });
    assert.equal(expired.status, 401);
    const active = `session=${createToken({ id: userId, guest: false }, sessions[0]!.id)}`;
    const logoutAll = await fetch(`${base}/api/auth/logout-all`, { method: 'POST', headers: { Cookie: active } });
    assert.equal(logoutAll.status, 204);
    const second = await fetch(`${base}/api/auth/me`, { headers: { Cookie: `session=${createToken({ id: userId, guest: false }, sessions[1]!.id)}` } });
    assert.equal(second.status, 401);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('conversation deletion is scoped to the authenticated user', async () => {
  const ownerId = '00000000-0000-4000-8000-000000000002';
  let deleteFilter: any;
  const sid = '10000000-0000-4000-8000-000000000002';
  const fakePrisma = {
    user: { findUnique: async ({ where }: any) => where.id === ownerId ? { id: ownerId, isGuest: false } : null },
    session: { findFirst: async () => ({ id: sid }) },
    conversation: { deleteMany: async ({ where }: any) => { deleteFilter = where; return { count: 0 }; } },
  } as any;
  const server = createApp(fakePrisma, { rateLimitStores: testRateLimitStores() }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations/00000000-0000-4000-8000-000000000003`, {
      method: 'DELETE', headers: { Cookie: `session=${createToken({ id: ownerId, guest: false }, sid)}` },
    });
    assert.equal(response.status, 404);
    assert.equal(deleteFilter.userId, ownerId);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('guest daily limit blocks another generation before creating data', async () => {
  const guestId = '00000000-0000-4000-8000-000000000004';
  const fakePrisma = {
    user: { findUnique: async () => ({ id: guestId, isGuest: true }) },
    session: { findFirst: async () => ({ id: '10000000-0000-4000-8000-000000000004' }) },
    conversation: { findFirst: async () => ({ id: '00000000-0000-4000-8000-000000000008', userId: guestId }) },
    conversationGenerationLock: { findFirst: async () => null },
    message: { updateMany: async () => ({ count: 0 }) },
  } as any;
  const sid = '10000000-0000-4000-8000-000000000004';
  const server = createApp(fakePrisma, { acquireLock: async () => async () => {}, consumeQuota: async () => false, allocateSequence: async () => 1, rateLimitStores: testRateLimitStores() }).listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/chat/stream`, {
      method: 'POST', headers: { Cookie: `session=${createToken({ id: guestId, guest: true }, sid)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: '00000000-0000-4000-8000-000000000008', content: 'One more message' }),
    });
    assert.equal(response.status, 429);
    assert.match((await response.json() as any).error, /limit reached/i);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
