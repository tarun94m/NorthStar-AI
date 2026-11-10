# Phase 2D — Product Integration and Experience Architecture Review

**Status:** Architecture review only. No Phase 2D runtime implementation is authorized by this review.

**Updated direction:** The Auto/Manual model-routing requirement changes the plan and persistence foundation. See [the routing architecture addendum](PHASE_2D_ROUTING_ARCHITECTURE_ADDENDUM.md), which supersedes the sequence below where it differs. No implementation has started.

## Recommendation

Implement Phase 2D as a single-account product integration layer over the existing provider registry, model registry, ContextBuilder, summaries, personal-memory services, and usage ledger. Do not introduce a second application, workspace abstraction, enterprise RBAC, or new infrastructure. Keep the existing chat and SSE flow intact while adding an account settings contract, model-aware controls, an integrated usage view, and clearer onboarding and recovery states.

The platform remains horizontal: these services are reusable capabilities; this phase presents them to individual users. A future organization boundary should be added as a separate ownership and policy layer rather than overloading personal settings or memory.

## Existing implementation findings

| Area | Current state | Phase 2D implication |
|---|---|---|
| Provider/model catalog | `GET /api/models` is the frontend's catalog source. The server registry owns provider IDs, model IDs, availability, capabilities, limits, and parameter constraints. | Retain it as the only source for selector options and parameter controls. Add no frontend model catalog. |
| Per-user settings | `UserSettings` already has `provider`, `model`, `temperature`, `responsePreferences`, and `memoryEnabled`. Chat currently reads response preferences and memory state. The API contract says no general settings endpoint exists. | Reuse the existing row. The provider/model/temperature fields are not yet wired as account defaults; expose them through a new contract without creating parallel settings fields. |
| Chat selection | The UI holds the selected model in component state. The request accepts a model ID and validated generation parameters. Conversations persist provider/model identity. | Separate account defaults from a conversation's selected provider/model. Opening an existing conversation should reflect its persisted selection; a deliberate selector change applies to the next generation in that conversation. |
| Context and memory | ContextBuilder selects bounded recent turns, summary and approved personal memories; memory is disabled by default and unavailable to guests. | Surface controls and explain behavior, but keep retrieval and context construction in their current backend modules. Do not add workspace memory. |
| Usage | `GET /api/usage` returns the most recent 100 rows and a total estimated cost over those rows. Individual assistant messages display token/cost estimates. | Build a usage view on the existing ledger. Label values as estimates and make the time window and row limit explicit; avoid presenting the latest-100 subtotal as an all-time bill. |
| Experience | The main UI is one large React screen with a model selector, chat, memory modal, theme control, and a global error banner. It has no general settings surface, usage dashboard, or structured onboarding. | Extract small feature components and view state from the screen without introducing a heavyweight frontend framework or broad rewrite. |
| Identity boundary | Settings, memories, conversations and usage are scoped to the authenticated user. There is no workspace ownership or enterprise RBAC. | Keep Phase 2D explicitly personal-account scoped. Do not imply organization-level control or isolation. |

The HTTP and SSE contracts are documented in [`API_CONTRACT.md`](API_CONTRACT.md). Chat and SSE need no breaking changes for Phase 2D.

## Proposed integration design

### 1. Account settings contract

Add authenticated `GET /api/settings` and `PATCH /api/settings` around the existing `UserSettings` record. Use one allow-listed, validated settings object with a stable shape, for example:

```json
{
  "settings": {
    "defaultModelId": "openai:gpt-4.1-mini",
    "temperature": 0.7,
    "responsePreferences": "Use concise explanations.",
    "memoryEnabled": false
  }
}
```

Translate `defaultModelId` to the existing provider/model columns on the server. The model registry remains authoritative for existence, availability, and parameter ranges. Reuse `temperature`, `responsePreferences`, and `memoryEnabled`; do not add duplicate fields or tables. Keep `/api/memory/settings` compatible as a focused view of the same `memoryEnabled` field, and ensure both routes write the same row.

`PATCH` should be partial and strict: reject unknown keys, invalid/unavailable default models, unsupported parameters, out-of-range values, and malformed preference text with actionable `{ error, code }` responses. Do not silently replace an unavailable choice with another provider. A user may choose a model that later becomes unavailable; keep that preference visible, explain the configuration issue, and require explicit reselection before sending.

Treat account defaults and chat overrides separately. An omitted `modelId`/parameter can use the user's validated defaults; an explicit request override remains validated as today. Persist the chosen provider/model on the conversation when generation starts. Existing conversation history must not be rewritten when account defaults change.

The initial UI should expose temperature as the persistent generation preference because that field already exists. Other controls can be driven by the selected model's `parameters` metadata, but should not be persisted until there is an explicit, tested compatibility rule for model-specific settings. This avoids introducing a loosely typed JSON settings bag prematurely.

For guest accounts, allow only the non-memory settings needed for the current session if product behavior requires it. Keep memory disabled and return the existing registered-account restriction. Do not turn guest preferences into a path to long-term memory.

### 2. Model selector and response preferences

Keep `/api/models` as the single source for options, availability, capability descriptions, context/output limits, and parameter constraints. Group options by provider in the UI and show unavailable reasons without exposing credentials or raw provider errors. The UI should make clear which model will answer the next message.

Add a modest settings surface for account default model, temperature, and response preferences (length, tone, language, or custom instruction as plain user-authored text). Backend validation and model registry constraints are authoritative; HTML controls are usability hints only. Continue to pass preferences as system instructions through ContextBuilder, not as user transcript messages.

Do not add per-workspace defaults or provider secrets to client settings. Conversation-level selection and account-level defaults must remain visually distinct.

### 3. Usage dashboard

Start with a lightweight page or drawer consuming `GET /api/usage`. Show token counts, estimated cost, provider/model, operation (`chat`, `summary`, `memory_extraction`), and request time. Clearly label costs as estimates, distinguish operation types, and state the currently available time range and record limit.

Before promising daily/monthly totals or spend alerts, extend the existing endpoint with validated date filters and aggregate queries (or a small summary endpoint) that calculate a total over the same selected period. Preserve the existing response fields for current callers. Do not call estimates invoices or billing records; model prices are configurable estimates and should be checked against current provider prices before any budget-control claim.

### 4. Conversation consistency and recovery UX

Use a conversation's persisted provider/model when reopening it; use the account default only for a new conversation. Keep the current generation lock, cancellation behavior, partial states, and reload recovery contract. Disable model changes during an active generation or explain that a change applies to the next request.

Render provider unavailability, rate limits, oversized context, authentication expiry, cancellation, and recoverable stream interruption as distinct user actions. Preserve request IDs for support/debugging, but never display secrets, prompts, or raw provider payloads. Offer retry/regenerate only when the persisted state allows it, and avoid duplicate assistant rows.

### 5. Onboarding and memory controls

Keep first-run onboarding short and skippable: explain provider/model selection, guest limits and account persistence, and how to start a conversation. Identify the mock provider unmistakably and explain that its responses are local development output. Do not position the assistant around a single profession or promise unsupported capabilities such as web search, RAG, or agent execution.

Make memory's default-off state, explicit extraction, review-before-save, and disable/delete controls discoverable. Keep summary behavior unobtrusive but explain that long conversations may use a summary. Do not conflate summaries with personal memories.

## API contract plan

1. Add `GET/PATCH /api/settings` with the shape and validation above; document default-model resolution and the precedence of account defaults, conversation selection, and request overrides.
2. Keep `GET /api/models` and `POST /api/chat/stream` shapes compatible. Add catalog fields only if an actual UI need exists; never duplicate registry data in the frontend.
3. Preserve `GET /api/usage` fields. Add optional bounded date/cursor filters and explicit aggregate semantics only after tests establish whether `totalEstimatedCost` remains the recent-100 subtotal or becomes a selected-period aggregate. Prefer a new clearly named aggregate field over changing its meaning.
4. Keep the existing memory endpoints compatible and backed by the same `UserSettings.memoryEnabled` source.
5. Continue using consistent `{ error, code }` errors and `X-Request-Id`; document validation, model-unavailable, and conflict responses with examples.

Update `docs/API_CONTRACT.md` before implementing any route changes. No OpenAPI or Postman collection is necessary unless another caller or CI workflow needs machine-readable generated clients; the current concise contract and deterministic tests are sufficient for this phase.

## Implementation sequence after approval

1. **2D.1 — Contract and settings API:** tests for authentication, guest behavior, owner scoping, defaults, strict validation, unavailable models, compatibility with memory settings, and migration-free reuse of existing fields.
2. **2D.2 — Chat settings and model consistency:** settings UI, model-selector grouping/availability, persisted account defaults, conversation selection restoration, parameter validation, and recovery/error states.
3. **2D.3 — Usage experience:** estimate labels, filters/aggregates with stable semantics, user isolation, empty/loading/error states, and bounded pagination.
4. **2D.4 — Onboarding and usability:** skippable first-run guidance, guest-to-account explanation, mock-provider identification, and memory/summary explanations.
5. **Release gate:** full backend/frontend tests, browser journeys for guest and registered accounts, model/default changes across conversations, memory setting compatibility, usage isolation and filters, builds, Prisma checks, dependency audits, and live-provider verification only if credentials are configured locally.

Do not add new database columns in 2D.1 unless implementation uncovers that existing columns cannot safely represent the contract. Do not add Redis, workspace tables, enterprise RBAC, RAG, document uploads, or advanced tool execution in Phase 2D.

## Risks and decisions to preserve

- **Estimate semantics:** existing usage totals cover only the newest 100 records; a dashboard must not label that as lifetime spend.
- **Provider availability:** registry availability is runtime configuration, not a stable user entitlement. Distinguish unavailable from unauthorized if model entitlements are added later.
- **Preference safety:** free-form response preferences are instructions from the account owner and must be counted in the model context budget; they must never appear in logs.
- **Model identity:** provider-specific IDs are persisted on conversations; account defaults are not conversation history.
- **Personal versus organization scope:** current settings and memory remain personal. A future workspace should add explicit workspace ownership and policy precedence rather than reinterpret user rows.
- **Live integration:** automated mocks verify contracts and behavior, not actual OpenAI/Gemini operation. Live requests remain unverified until credentials are locally configured and a real request completes.

## Parallel customer-validation track

Customer validation should proceed independently of engineering and should not delay the product-wide usability work. This review does not contact customers or promise features. A first discovery batch can include roughly 12–15 conversations across multiple segments: consumers/students/creators/developers/researchers, small-company or agency teams, and developers evaluating AI infrastructure. Avoid letting any one group dominate the sample.

Use a 25-minute, problem-first interview. Ask about the last time the participant used AI for a real task, the steps and tools involved, what failed or required verification, frequency, the cost of the problem, data they cannot share, how they evaluate alternatives, who decides whether to pay, and what would make them return weekly. Request a concrete recent example before asking what features they want. Do not pitch the roadmap first.

After interviews, summarize evidence by segment: repeated high-cost problem, current workaround, trigger/frequency, buyer/user distinction, trust/privacy requirements, willingness-to-pay evidence, and unresolved assumption. Use follow-up demos only against observed workflows. Seek at least three independent examples of the same urgent problem before prioritizing a vertical-specific workflow; do not infer demand from compliments or hypothetical interest.

Track weekly active repeat use, task completion without extensive correction, retained users, and paid-pilot conversion once a usable demo is available. Do not collect sensitive transcripts or credentials during interviews; obtain consent before recording and keep research notes minimal. Outreach and scheduling require the owner's own contacts and authorization; this document supplies the plan, not external outreach.
