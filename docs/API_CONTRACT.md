# API contract (Phase 1 baseline and Phase 2A)

This document records the HTTP interface implemented by `backend/src/app.ts` and the compatibility boundary for provider routing. JSON failures use `{ "error": string }`; unexpected server failures also include `requestId`. Successful responses continue to use the existing shapes.

## Authentication and session

All protected routes authenticate the HTTP-only `session` cookie. Missing/expired/revoked sessions return `401 { error, code }`. Cookies are `SameSite=Lax`, `Secure` in production, and expire after 24 hours for guests or seven days for registered sessions.

| Method / path | Request | Success |
|---|---|---|
| `GET /api/auth/me` | none | `{ user: { id, email, isGuest }, provider, guestDailyMessageLimit }` |
| `POST /api/auth/guest` | none | Sets cookie; `{ user, provider, guestDailyMessageLimit }` |
| `POST /api/auth/register` | `{ email, password }`; email normalized/lowercase, password 10–128 chars | `201 { user }`, may convert current guest to registered account |
| `POST /api/auth/login` | `{ email, password }`; same schema | `{ user }` and cookie |
| `POST /api/auth/logout` | none | `204`; revokes current session |
| `POST /api/auth/logout-all` | none | `204`; revokes all sessions |

## Models and settings

`GET /api/models` returns `{ models, activeProvider }`. Each model entry has a stable application `id`, `provider`, provider-specific `model`, `label`, `description`, `available`, `availability`, `capabilities`, `contextWindow`, `maxOutputTokens`, and `parameters` constraints. The endpoint will never contain credentials. Unavailable entries are marked `available: false`; Gemini entries are omitted unless its adapter and API key are present. No settings endpoint currently exists; Phase 2A does not add or change one.

## Conversations and messages

| Method / path | Request | Success |
|---|---|---|
| `GET /api/conversations` | none | `{ conversations: Conversation[] }`; only the authenticated user's rows |
| `POST /api/conversations` | `{}` | `201 { conversation }` |
| `PATCH /api/conversations/:id` | `{ title }`; trimmed, 1–80 chars | `{ ok: true }` |
| `DELETE /api/conversations/:id` | none | `204` |
| `PATCH /api/messages/:id` | `{ content }`; trimmed, 1–20,000 chars | `{ ok: true }` |
| `GET /api/usage` | none | `{ usage, totalEstimatedCost }`; most recent 100 rows |

Unknown or non-owned conversations/messages return `404`. Editing while generation is active returns `409`.

## Chat streaming

`POST /api/chat/stream` is authenticated and accepts `{ conversationId?: UUID, content?: string, modelId?: string, parameters?: object, regenerate?: boolean }`. Content, when present, is trimmed and 1–20,000 chars. Either content or a conversation ID with `regenerate: true` is required. Every parameter must be returned for the selected model and within its declared numeric range. Guest quota exhaustion returns `429`; a busy conversation returns `409`; an unknown/non-owned conversation returns `404`.

Successful requests use `Content-Type: text/event-stream`. Existing SSE events remain:

- `meta`: `{ conversationId, userMessageId, assistantMessageId, provider, model, mock }`
- `delta`: `{ text }`
- `done`: `{ status, inputTokens, outputTokens, estimatedCost }`
- `error`: `{ error, partial }`

`status` is `complete`, `partial`, or `cancelled`. The server persists the assistant row and usage before sending `done`. Provider/model errors before headers use JSON `{ error, code }` and an appropriate HTTP status; failures after streaming begins use `error` with the same `code`. Phase 2A adds stable codes while retaining `error` and existing event names. Model errors use `400 MODEL_NOT_FOUND`, `503 MODEL_UNAVAILABLE`, and `400 UNSUPPORTED_PARAMETER`. No unknown ID is replaced by a default model.

## Compatibility and validation

The frontend continues to use `/api/models` as its sole model catalog. Existing clients may omit `modelId`, in which case the backend chooses the first configured enabled registry model, or the mock model when no live provider is configured. An explicitly supplied unknown or unavailable ID is rejected. The database `Conversation.provider` and `Conversation.model` fields continue storing the selected provider and provider-specific model identifier. Provider-specific payloads and credentials remain server-side.
# Phase 2B context handling

Chat request and streaming event shapes remain unchanged. The `content` validation limit is now 240,000 characters (the existing 256 KB JSON body limit still applies) so model token budgets, rather than the former 20,000-character ceiling, determine context fit. The backend builds provider context from a selected model's context window and output limit, keeps complete recent user/assistant turns in chronological order, and applies account response preferences as provider system instructions. If the current message and required instructions cannot fit after output and safety reserves, `POST /api/chat/stream` returns HTTP 413 with `{ "error": "...", "code": "CONTEXT_TOO_LARGE" }` before opening an SSE response. Token diagnostics are server logs only and contain counts/IDs, never message content or preferences. No database schema changes are required.
