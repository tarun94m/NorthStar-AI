import { randomUUID } from 'node:crypto';
export const requestId = () => randomUUID();
export function conversationTitle(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'New chat';
  const firstSentence = normalized.split(/(?<=[.!?])\s/)[0] ?? normalized;
  return firstSentence.length > 60 ? `${firstSentence.slice(0, 57).trimEnd()}…` : firstSentence;
}
export function sse(res: import('express').Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
