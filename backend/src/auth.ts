import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export const hashPassword = (password: string) => argon2.hash(password, { type: argon2.argon2id });
export const verifyPassword = (hash: string, password: string) => argon2.verify(hash, password);

export type Principal = { id: string; guest: boolean; sessionId?: string };
export function createToken(principal: Principal, sessionId: string): string {
  return jwt.sign({ guest: principal.guest, sid: sessionId }, config.JWT_SECRET, { subject: principal.id, expiresIn: principal.guest ? '1d' : '7d' });
}
export function readToken(token: string): Principal {
  const payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') throw new Error('Invalid token');
  return { id: payload.sub, guest: Boolean(payload.guest), sessionId: payload.sid };
}
