# Northstar AI

A lightweight ChatGPT-style application with React, Express, PostgreSQL, Prisma, secure guest/account sessions, persistent conversations, and streamed AI replies. Phase 1 deliberately keeps documents/RAG and advanced tool execution out of the application. PostgreSQL is the only required service; Redis is deferred.

## Run locally

1. Install Node.js 22+ and Docker Desktop.
2. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 characters. Add `OPENAI_API_KEY` and/or `GEMINI_API_KEY` to enable the matching live provider. If neither is set, the app uses the visibly labeled local mock provider.
3. Install packages with `npm install`.
4. Start PostgreSQL with `docker compose up -d postgres` (host port 5433, to avoid conflicting with a local PostgreSQL service on 5432).
5. Apply the schema with `npm run db:generate` and `npm run db:migrate`.
6. Start the app with `npm run dev`. Open http://localhost:5173. The API is at http://localhost:3001.

Guests can try 12 messages per UTC day. Registering while in guest mode upgrades the same account so its conversations remain available. Account passwords require at least 10 characters. Session cookies are HTTP-only and same-site. Configure HTTPS and production secrets before deployment.

## Architecture

- `frontend/`: React/Vite interface; the UI talks only to the Express API. Responses use fetch-based SSE, which supports POST bodies and abort cancellation.
- `backend/src/`: Express modules for authentication, conversation/message ownership, provider orchestration, usage estimates, structured request logging, and request IDs.
- `backend/prisma/schema.prisma`: PostgreSQL relational schema. `User` owns conversations, settings, and usage; conversations own ordered messages. Cascades enforce cleanup.
- `backend/src/ai.ts` and `backend/src/model-registry.ts`: provider-independent generation interface, OpenAI Responses and Google GenAI adapters, server-owned model definitions, capability and parameter constraints, and the local mock fallback.
- `docs/API_CONTRACT.md`: current authentication, conversation, model, chat and SSE contracts, including the Phase 2A compatibility rules.

Conversation titles come from the first user message. Editing a user message deletes later turns so the conversation cannot silently retain a response to stale content. Regenerate streams a replacement from the latest user message. Token counts use provider usage when available, with a text-length estimate fallback; costs are estimates and use configurable per-million-token rates in `.env`.

Guest usage and request rate limits use PostgreSQL-backed atomic counters shared across API instances. The local mock provider has no provider charge and is labeled in the UI.

## Phase 1 checklist

- [x] Inspect the empty repository and establish frontend/backend architecture.
- [x] PostgreSQL schema, Prisma setup, and Compose service.
- [x] Guest mode with daily message limits and guest-to-account upgrade.
- [x] Registration/login/logout with Argon2id and HTTP-only JWT cookie.
- [x] User-isolated persistent conversation CRUD and message history.
- [x] First-message conversation titles, message editing, and response regeneration.
- [x] Provider/model catalog, OpenAI adapter, and clearly labeled mock fallback.
- [x] Streaming, stop/cancel, timeout/error/partial statuses, and reload recovery from persisted messages.
- [x] Per-request token usage and configurable estimated cost tracking.
- [x] Structured request logs, request IDs, security headers, and API rate limiting.
- [x] Backend tests for password hashing, tokens, guest session cookies/protection, mock streaming/cancellation, titles, and cost estimates.
- [x] Verify migrations, tests, build, and the live guest chat journey in this environment.

## Phase 1 limitations

Memory, uploads, RAG, web search, and advanced tool execution are later phases. Cost estimates depend on the configured rate table and are not billing statements. The guest daily limit is tracked in UTC.

## Phase 1.1 engineering audit

- [x] Upgrade OpenAI SDK to 7.50.0 and Prisma to 7.10.1; migrate Prisma to its PostgreSQL driver adapter.
- [x] Resolve the OpenAI SDK's optional Zod peer to patched Zod 4.6.7.
- [x] Harden Responses stream handling: provider errors, incomplete events, and missing `response.completed` now fail instead of being marked complete.
- [x] Reject overlapping generations across API replicas using PostgreSQL leases and HTTP 409.
- [x] Add regression coverage for Responses deltas/usage/failure, owner-scoped deletion, guest quota rejection, auth and mock cancellation.
- [x] Run `npm audit` for both workspaces: 0 vulnerabilities reported on 2026-11-04.
- [x] Run backend tests (11 passing), production builds, Prisma client generation and migration check.
- [x] Smoke-test guest creation and a complete mock SSE response against local PostgreSQL.
- [ ] Live OpenAI API test remains unverified because no `OPENAI_API_KEY` is configured in this environment.

Phase 1.2 resolved session revocation, generation coordination, guest quota races, usage references, and message ordering. Phase 1.3 replaces the process-local HTTP rate limiter with a PostgreSQL shared store. Cost values remain configurable estimates and must be validated against current provider pricing before billing use.

## Phase 1.2 security and reliability

- [x] Persist JWT session IDs with server-side expiry and revocation; logout revokes the current session, and `/api/auth/logout-all` revokes every active session for the account.
- [x] Coordinate generation with PostgreSQL lease rows. Leases renew every 20 seconds, expire after 90 seconds without renewal, and are released on success, cancellation, or failure. Startup and conversation reads recover only generations without a live lease.
- [x] Enforce guest quotas using one atomic PostgreSQL upsert per user and UTC day. A quota unit is consumed once a valid request owns the conversation generation lease; provider failures and cancellation count, while validation errors and concurrent lock conflicts do not.
- [x] Keep usage records after conversation/message deletion using `SET NULL` foreign keys.
- [x] Allocate a per-conversation integer sequence atomically; reads, edits, and regeneration use sequence order. Editing preserves the edited user's sequence. Regeneration deletes the prior assistant response before starting its replacement; if the replacement fails, its partial/error state remains and the previous answer is not restored.
- [x] Lazy-load the Markdown renderer. The previous 581 KB minified entry is split into a 237 KB entry and a 344 KB Markdown chunk (build output); each is under Vite's 500 KB warning threshold.
- [x] Poll persisted streaming states after refresh and recover generations whose lease expired.
- [x] Add frontend Markdown rendering test and backend auth, concurrency, cancellation, timeout, recovery, quota, regeneration/editing and data-integrity tests.
- [x] Apply migrations, run backend tests (26 passing), frontend tests (1 passing), and both production builds.
- [x] Playwright browser verification: send a message, refresh after a streamed delta, reopen the partial conversation, regenerate, then refresh and confirm one completed response.
- [x] Replace process-local request limit counters with a shared PostgreSQL fixed-window store.
- [ ] Live OpenAI use remains unverified because no fresh `OPENAI_API_KEY` was configured; the previously posted credential was not used.

Quota is based on accepted generation attempts rather than successful completions, so users cannot retry failures or cancellations without limit. Daily boundaries use UTC. PostgreSQL is required for session records, quota enforcement, sequence allocation, and distributed generation leases; Redis remains unnecessary for this phase.

Deploying the session migration invalidates pre-Phase 1.2 JWT cookies because those tokens do not contain a server-side session ID; users will need to sign in or restart guest mode once after upgrade.

Run browser recovery verification with the mock provider: set `MOCK_STREAM_DELAY_MS=300` in the API environment, start the API and frontend, then run `npm run test:browser`. In PowerShell, set it for the dev process with `$env:MOCK_STREAM_DELAY_MS='300'; npm run dev`. The browser test refuses to send a message unless the UI identifies the mock provider.

To enable live OpenAI locally, copy `.env.example` to `.env`, set `OPENAI_API_KEY` in that local ignored file using your editor, and restart the API. Confirm `/api/health` reports `provider: openai` and send a test request from the app. Never paste the key into chat, commit `.env`, or enable request-body/header logging.

To enable Gemini, set `GEMINI_API_KEY` in the ignored local `.env` file and restart the API. The model catalog exposes Gemini only while this credential is configured. Gemini generation uses the official `@google/genai` SDK; credentials remain in the backend environment. Live integration is unverified until a real request completes in this environment.

### Phase 2A checklist

- [x] Record the existing auth, chat, model, validation, error and SSE contract in `docs/API_CONTRACT.md` before changing route behavior.
- [x] Add server-side provider/model registries with model IDs, provider model IDs, limits, capabilities, configuration status, and parameter constraints.
- [x] Route chat generations through provider selection; reject unknown, unavailable, and unsupported model requests without falling back.
- [x] Add the Google GenAI streaming and non-streaming adapter; keep provider secrets server-side and include normalized usage and failure handling.
- [x] Keep the model selector sourced exclusively from `/api/models` and label the local mock provider.
- [x] Add deterministic model resolution, API catalog, OpenAI/Gemini adapter, routing, usage, error, cancellation, and persistence tests; all 31 backend tests pass.
- [x] Frontend test passes; browser recovery test confirms a mock chat survives refresh/regeneration without duplicate assistant responses.
- [x] Backend/frontend production builds pass; Prisma schema validation and migration status pass; no migration was needed; both workspace audits report 0 vulnerabilities.
- [ ] Live OpenAI and Gemini requests remain unverified because no credentials are configured locally.

### Shared rate-limit store

`express-rate-limit` uses a PostgreSQL `RateLimitCounter` table with namespaced keys and atomic fixed-window upserts. Multiple API replicas share the same API and guest-creation counters. Expired rows are pruned hourly. PostgreSQL is the selected store because it is already a required service and the current limits are modest; each limited request adds one indexed write. Redis would provide lower-latency increments and more headroom for high request rates, but adds a separate service, monitoring, and failure mode. Move to Redis only if rate-limit write volume measurably affects PostgreSQL latency or scale targets require it. See the [express-rate-limit custom store contract](https://github.com/express-rate-limit/express-rate-limit/blob/main/docs/guides/creating-a-store.mdx).

### Phase 1.3 final verification

- [x] Playwright confirmed an actual browser refresh after an assistant delta, recovery of the partial conversation, successful regeneration, and one completed assistant response after a second refresh.
- [x] Backend: 26 tests pass, including concurrent limiter increments across separate store instances.
- [x] Frontend: 1 Markdown rendering test passes.
- [x] Production builds, all three migrations, Prisma validation, and both dependency audits pass; 0 vulnerabilities reported.
- [ ] Live OpenAI calls remain unverified because the local environment has no configured key.

### Phase 2B context engineering

- [x] Add a dedicated context builder with per-model context/output limits, deterministic whole-turn selection, chronological ordering, and an actionable `CONTEXT_TOO_LARGE` response when the current request cannot fit.
- [x] Count OpenAI context with `o200k_base` plus explicit message-framing estimate; use Gemini's official model-aware `countTokens` operation including system instructions; use a conservative UTF-8 approximation only for mock/fallback paths.
- [x] Apply stored response preferences as separate provider system instructions. Keep summary and saved-memory inputs as empty extension points; no memory/summary persistence or RAG functionality was added.
- [x] Emit structured context diagnostics containing model/provider IDs, token estimates, reserves, selected/omitted message counts and build duration; logs exclude message text and response preferences.
- [x] No database schema or migration changes. Existing message/usage records continue to store provider-reported token counts, falling back to context estimate when absent.
- [x] Before the final 250 ms progress-write throttle, the full backend suite passed (41/41) and frontend passed (1/1); both builds, Prisma validation/migration status, and both dependency audits passed.
- [x] Phase 2B.1 replaces the timing-based browser test with a controllable provider fixture and verified active, interrupted, regenerated, and completed states in three consecutive Playwright runs.
- [ ] Live OpenAI/Gemini integration remains unverified; no provider credentials are configured in the local environment.

Token counting references: [OpenAI tokenizer guidance](https://platform.openai.com/tokenizer) and [Gemini token counting documentation](https://ai.google.dev/gemini-api/docs/tokens).

### Phase 2B.1 recovery reliability

- [x] Root cause: the original browser test waited for the mock response's full distinguishing text before refreshing. That condition only became true after completion, so reopening a completed response was expected. The later first-text wait still had no provider or database synchronization, allowing a race.
- [x] Persist the first streamed assistant delta immediately and throttle subsequent progress writes to at most one every 250 ms while status remains `streaming`; always persist final content/status. On browser disconnection, finalize the available partial text and release the existing PostgreSQL generation lease.
- [x] Add structured termination cause and distinct provider-reported/context-estimated token fields to generation logs. Generation logs do not include user text or response preferences.
- [x] Add a controlled test provider that emits and persists a known partial, blocks until abort/release, reports abort receipt, and returns explicit final usage during regeneration.
- [x] Browser test verifies the connection remains unfinished during refresh, provider abort, active lease before disconnect, partial state and lease release after disconnect, one regenerated assistant response, provider usage metadata, and completed recovery.
- [x] Browser recovery passed 3 of 3 consecutive runs. Backend passed 41 of 41 tests; frontend passed 1 of 1. Builds, Prisma validation/migration status, and audits passed; 0 vulnerabilities reported.
- [ ] After the final 250 ms progress-write throttle, backend tests could not complete because the configured PostgreSQL endpoint at `localhost:5433` was unavailable (23 passed, 18 failed on database connection). The Docker daemon was unavailable; the local PostgreSQL instance on `5432` rejected the project's credentials. Frontend test passed (1/1), builds passed, and schema validation passed; final migration status and browser reruns are blocked by database availability.
- [x] ContextBuilder integration tests cover exact provider context, whole-turn boundaries, model-specific output reserves, preferences in token counting, over-budget current messages, active-versus-stale recovery, and distinct estimate versus provider usage.
- [ ] Live OpenAI/Gemini requests remain unverified because provider credentials are not configured locally.
