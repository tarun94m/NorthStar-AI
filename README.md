# Northstar AI

A lightweight ChatGPT-style application with React, Express, PostgreSQL, Prisma, secure guest/account sessions, persistent conversations, and streamed AI replies. Phase 1 deliberately keeps documents/RAG and advanced tool execution out of the application. PostgreSQL is the only required service; Redis is deferred.

## Run locally

1. Install Node.js 22+ and Docker Desktop.
2. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 characters. Add `OPENAI_API_KEY` and/or `GEMINI_API_KEY` to enable the matching live provider. To opt into the visibly labeled local mock provider during development, set `MOCK_PROVIDER_ENABLED=true`; it is rejected in production and is never enabled automatically.
3. Install packages with `npm install`.
4. Start PostgreSQL with `docker compose up -d postgres` (host port 5433, to avoid conflicting with a local PostgreSQL service on 5432).
5. Apply the schema with `npm run db:generate` and `npm run db:migrate`.
6. Start the app with `npm run dev`. Open http://localhost:5173. The API is at http://localhost:3001.

Guests can try 12 messages per UTC day. Registering while in guest mode upgrades the same account so its conversations remain available. Account passwords require at least 10 characters. Session cookies are HTTP-only and same-site. Configure HTTPS and production secrets before deployment.

## Architecture

- `frontend/`: React/Vite interface; the UI talks only to the Express API. Responses use fetch-based SSE, which supports POST bodies and abort cancellation.
- `backend/src/`: Express modules for authentication, conversation/message ownership, provider orchestration, usage estimates, structured request logging, and request IDs.
- `backend/prisma/schema.prisma`: PostgreSQL relational schema. `User` owns conversations, settings, and usage; conversations own ordered messages. Cascades enforce cleanup.
- `backend/src/ai.ts` and `backend/src/model-registry.ts`: provider-independent generation interface, OpenAI Responses and Google GenAI adapters, server-owned model definitions, capability and parameter constraints, and the explicitly configured local mock provider.
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
- [x] Provider/model catalog, OpenAI adapter, and clearly labeled mock provider behind explicit development/test configuration.
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

### Phase 2D.1 settings and routing persistence

- [x] Add additive account and conversation Auto/Manual selection preferences. Existing rows default to Manual; new registrations and guest-to-account upgrades default to Auto.
- [x] Add owner-scoped settings and conversation-selection APIs. Preserve unavailable defaults, validate model parameters, and reject conflicting Auto/manual selectors.
- [x] Keep guests settings-free, default guest conversations to Manual with no persistent model choice, and preserve request-only model and parameter selection.
- [x] Add nullable per-message requested mode/model and future routing metadata while keeping `Message.provider/model` and `Conversation.provider/model` as actual response attribution.
- [x] Require explicit `MOCK_PROVIDER_ENABLED=true` in development/test; reject it in production and never register or route to mock automatically.
- [x] Verification: backend 82/82 and frontend 1/1 tests pass; production builds pass; Prisma schema validates; all 8 migrations are applied; backend and frontend audits report 0 vulnerabilities; browser recovery/regeneration passes with one final assistant response and usage metadata.

### Phase 2D.2 intelligent routing

- [x] Add deterministic task classification and a provider-independent ModelRouter before model-specific ContextBuilder work. Filter candidates by provider availability, registered capabilities, parameters, context bounds, and output reservation.
- [x] Keep Gemini 3.8 sampling parameters aligned with its current API contract. Preserve existing saved temperatures, allow `temperature: null` to clear a preference, and default new accounts to provider sampling defaults so new Auto users can use a Gemini-only configuration.
- [x] Preserve explicit Manual model selection without provider switching. Auto may retry another eligible non-mock provider only for classified retryable failures before the first text delta; it never switches after streaming starts.
- [x] Persist actual provider/model attribution and safe routing metadata per assistant response. Account each provider attempt independently using unique attempt IDs and idempotent usage-outbox events; unknown failed-attempt usage remains null.
- [x] Add grouped model selection, Auto/manual conversation controls, one-request override, availability display, short routing explanations, and per-response model attribution in the frontend.
- [x] Add a nine-case deterministic routing evaluation dataset and blinded-comparison harness. This measures classifier/eligibility mechanics only; response quality and live fallback frequency remain unevaluated until live provider runs are configured.
- [ ] Live OpenAI/Gemini routing, response quality, and provider fallback behavior remain unverified when provider credentials are unavailable. The router has no measured quality or latency evidence configured, so its configured preference is not a claim of optimal model selection.

Deploying the session migration invalidates pre-Phase 1.2 JWT cookies because those tokens do not contain a server-side session ID; users will need to sign in or restart guest mode once after upgrade.

Run browser recovery verification with the mock provider: set `MOCK_PROVIDER_ENABLED=true` and `MOCK_STREAM_DELAY_MS=300` in the API environment, start the API and frontend, then run `npm run test:browser`. In PowerShell, set them for the dev process with `$env:MOCK_PROVIDER_ENABLED='true'; $env:MOCK_STREAM_DELAY_MS='300'; npm run dev`. Mock mode is limited to development/test and the browser test refuses to send a message unless the UI identifies the mock provider.

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
- [x] Phase 2B.2: restored the existing Docker Compose PostgreSQL 17 service on `localhost:5433` without changing ports, credentials, or volumes. Confirmed database `platform`, healthy container, valid Prisma schema, and all three migrations applied.
- [x] Final backend regression: 43/43 passed; frontend: 1/1 passed. Production backend and frontend builds passed. Backend and frontend `npm audit` each reported 0 vulnerabilities.
- [x] Final Playwright recovery/regeneration test passed 3/3 consecutive runs with the 250 ms persistence throttle. The controlled provider proved an active generation before refresh, observed disconnect cancellation, persisted/reopened the partial answer, regenerated exactly one completed response, and recorded provider usage.
- [x] Crash recovery: forcibly terminated the API process after persisting a partial delta. Verified the active lease remained in PostgreSQL, simulated expiry by aging only the fixture lease row, confirmed recovery to partial, and regenerated one complete assistant response with usage metadata.
- [x] Progress persistence and finalization are serialized. A regression test confirms a later progress write cannot race the terminal write; a failure writing usage metadata does not downgrade a message already finalized as complete. A progress persistence error aborts upstream generation and stores an explicit error state.
- [x] ContextBuilder integration tests cover exact provider context, whole-turn boundaries, model-specific output reserves, preferences in token counting, over-budget current messages, active-versus-stale recovery, and distinct estimate versus provider usage.
- [ ] Live OpenAI/Gemini requests remain unverified: no provider API key is configured in the local environment. Mock-provider checks are deterministic application tests, not live provider verification.

### Phase 2C.1 conversation summarization

- [x] Add PostgreSQL-backed, coalesced summary jobs with atomic claims, renewable leases, generation fencing, retry/backoff, and recovery after worker termination. No Redis or summary API was added.
- [x] Build versioned summaries from complete turns, preserving a contiguous coverage boundary and bounded raw recent turns. Incomplete turns wait for completion; appends and edits invalidate or requeue summaries safely. Original messages remain stored.
- [x] Pass an active summary to ContextBuilder as separately labeled untrusted context, avoid duplicating covered messages, and omit it when it does not fit the model-specific request budget. Preserve the current user message and provider usage separately from estimates.
- [x] Persist chat and summary usage through an idempotent PostgreSQL outbox; summary costs remain estimates, not billing records.
- [x] Run the full backend suite (65/65), frontend suite (1/1), production builds, Prisma validation and migration status (5 migrations, up to date), and backend/frontend dependency audits (0 vulnerabilities each).
- [x] Run browser recovery/regeneration verification 3/3 consecutive times; each run reopened after refresh with exactly one assistant response.
- [ ] Live provider summarization remains unverified because `OPENAI_API_KEY` is not configured in the local environment. Configure `SUMMARY_MODEL_ID` and the corresponding provider credential locally before using live background summarization; transcript content and prior summaries are sent to that configured provider. Credential redaction is heuristic and is not comprehensive PII detection.

At the Phase 2C.1 checkpoint, user memory, embeddings, retrieval, memory APIs/UI, RAG, uploads, and advanced tool execution had not been started.

### Phase 2C.2 personal memory

- [x] Reuse `UserSettings.memoryEnabled` (default `false`) and add user-owned `UserMemory` and expiring `MemorySuggestion` records. Ownership cascades on account deletion; source conversations use `SET NULL`; unique content keys and transactional approval prevent duplicate memories.
- [x] Add owner-scoped authenticated APIs for settings, memory CRUD, suggestion generation/listing/approval/rejection. Guests receive `403 MEMORY_REGISTERED_ACCOUNT_REQUIRED`; suggestion generation uses a PostgreSQL-backed per-user hourly limit and does not run while memory is disabled.
- [x] Add explicit user-triggered structured extraction through the common provider interface. Deterministic schema, confidence/usefulness, duplicate, secret and sensitive-data checks run before pending suggestions are saved. Approval shows exact editable text and is required before creating a memory.
- [x] Add PostgreSQL `simple`-configuration full-text indexing of content and tags, minimum lexical rank, bounded top-K and total/per-memory token limits, and a limited recency multiplier. Retrieval is user-filtered, uncached, disabled for guests and disabled when the setting is off.
- [x] Extend ContextBuilder with separately labeled untrusted memory context after summary context and before the latest raw conversation turn in provider message order. Memory candidates are added only after recent raw turns and summaries fit, and are model-counted. Diagnostics contain counts/timings only.
- [x] Add expiration worker and durable `memory_extraction` usage outbox events. Category labels are flexible generic Unicode strings; UI suggestions are starting labels, not a fixed profession taxonomy. The schema remains personal-user scoped for future organizational memory separation.
- [x] Final verification: backend 75/75 tests and frontend 1/1 test pass; production backend/frontend builds pass; Prisma schema validation passes; all 7 migrations are applied with none pending; backend and frontend `npm audit` report 0 vulnerabilities each.
- [x] Playwright verified interrupted-stream recovery, explicit suggestion approval, memory disablement while retaining management, and manual create/edit/delete. The provider remained blocked until refresh; the partial response persisted, the lease was released, regeneration completed with usage, and refresh showed exactly one completed assistant response. The browser test waits for persisted settings and suggestion transitions.
- [ ] Live OpenAI/Gemini memory extraction and chat remain unverified because neither provider credential is configured in this environment. Mock-provider automated/browser tests do not establish live-provider behavior.

Memory search is lexical text matching, not semantic retrieval. The PostgreSQL `simple` configuration preserves token matching without English stemming and passed the included English, Spanish and French evaluation cases; it does not translate terms, infer synonyms, or guarantee good search for every writing system. Secret and sensitive-data detection uses deterministic patterns and is not comprehensive PII detection. Transcript text and stored summaries may be sent to the conversation's configured provider during explicit extraction and chat; a live OpenAI/Gemini request remains unverified unless configured locally. Local mock generation returns no candidate memories.

Controls are available at `MEMORY_SUGGESTION_MIN_CONFIDENCE`, `MEMORY_SUGGESTION_MIN_USEFULNESS`, `MEMORY_SUGGESTION_MAX_PER_HOUR`, `MEMORY_SUGGESTION_TTL_HOURS`, `MEMORY_RETRIEVAL_TOP_K`, `MEMORY_RETRIEVAL_MAX_TOKENS`, `MEMORY_MAX_PER_MEMORY_TOKENS`, `MEMORY_RETRIEVAL_MIN_RANK`, and `MEMORY_EXPIRY_POLL_MS` in `.env`.

### Phase 2D.2 intelligent model routing

- [x] Resolve Auto and Manual selection using the documented precedence and run the provider-independent ModelRouter before model-specific ContextBuilder work. Manual selection is strict; Auto only retries eligible provider failures before the first streamed delta.
- [x] Rank only configured, enabled models with registry-supported capabilities and parameters. Task suitability and measured quality evidence take precedence; no quality scores or capabilities are fabricated. The deterministic evaluation set checks task classification, declared capability fit, context eligibility, model distribution and latency estimates; answer quality and fallback performance remain unmeasured without live providers.
- [x] Add Auto and provider-grouped Manual selection in the UI, per-request overrides, conversation-level Manual pinning, safe routing explanations and actual provider/model attribution on assistant responses.
- [x] Persist per-attempt usage independently. Unknown provider usage remains null and is distinguishable from estimates, including failed fallback attempts.
- [x] Browser verification passed: refresh during blocked streaming recovered one partial response, provider cancellation was observed, regeneration completed once with reported usage, completed state survived refresh, and an Auto override returned routing metadata for `mock:echo`.
- [x] Backend: 97/97 tests passed. Frontend: 1/1 passed. Backend and frontend production builds passed. Prisma schema validation and client generation passed; all 11 migrations are applied with none pending.
- [x] Offline dependency audits reported 0 vulnerabilities in both workspaces. Online npm advisory lookup could not verify registry data because the environment rejected the registry certificate chain; TLS verification was left enabled.
- [ ] Live OpenAI and Gemini requests and comparative answer quality remain unverified because provider credentials are not configured in this environment. Mock tests establish application behavior only.

### Phase 2D.3 usage dashboard and cost intelligence

- [x] Add nullable pricing currency, version, and effective-time snapshots to usage outbox/records. Costs and snapshots are captured at enqueue time; retries copy the same snapshot. Existing costs remain unchanged, and legacy records retain known USD currency with unknown version/effective-time metadata.
- [x] Preserve distinct provider-reported and estimated token counts, including unknown usage. Cost calculations remain estimates; no billing, payment, subscription, budget limit, or alert behavior is implemented.
- [x] Extend authenticated `GET /api/usage` with bounded UTC date/provider/model/operation/status filters, stable cursor pagination, provider-attempt rows, filtered period aggregates, per-currency subtotals, and owner-scoped counts.
- [x] Keep the legacy top-level `totalEstimatedCost` as the recent-100-record subtotal; the explicitly named `period.totalEstimatedCost` covers the selected period only when a complete single-currency total is available.
- [x] Add the Usage & costs dashboard with date filters, request/token totals, provider/model/operation breakdowns, history pagination, unknown usage/cost indicators, and failed provider attempt details.
- [x] Final verification: backend 107/107 tests, frontend 1/1 test, and the Playwright recovery/dashboard journey passed. The browser verified blocked generation, refresh cancellation, persisted partial recovery, duplicate-free regeneration, usage reporting and memory-operation filtering.
- [x] Backend and frontend production builds passed. Prisma schema validation passed; all 12 configured migrations are applied and none are pending.
- [x] Cached offline dependency audits found 0 vulnerabilities in both workspaces. Live npm advisory lookup remains unverified because the registry certificate chain could not be verified; TLS verification was left enabled.
- [ ] Live OpenAI/Gemini provider usage and provider billing remain unverified. Mock-backed browser and automated tests do not establish live-provider behavior or actual provider bills.

Default USD rates are estimates from the configured model table, not billing data. Verify or update those configured rates when provider pricing changes: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing). The current Gemini 3.8 Flash standard-tier rates are introductory through December 31, 2026; cached-token and tool charges are outside this token-only estimate. Personal usage remains user-owned; a future organization layer should add separate ownership/aggregation relationships rather than reinterpreting personal records. Phase 2D.4 has not started.
