import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'phase-one-test-secret-with-at-least-32-characters';
const { hashPassword, verifyPassword, createToken, readToken } = await import('./auth.js');

test('passwords are hashed and verified without storing plaintext', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.notEqual(hash, 'correct horse battery staple');
  assert.equal(await verifyPassword(hash, 'correct horse battery staple'), true);
  assert.equal(await verifyPassword(hash, 'incorrect password'), false);
});

test('session tokens preserve the user identity and guest status', () => {
  const token = createToken({ id: 'user-123', guest: true }, 'session-123');
  assert.deepEqual(readToken(token), { id: 'user-123', guest: true, sessionId: 'session-123' });
  assert.throws(() => readToken('not-a-token'));
});
