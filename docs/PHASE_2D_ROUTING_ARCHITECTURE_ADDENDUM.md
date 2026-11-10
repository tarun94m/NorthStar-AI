# Phase 2D Architecture Addendum — Auto and Manual Model Routing

**Status:** Phase 2D.1 settings and routing persistence and Phase 2D.2 deterministic routing are implemented. Phase 2D.3 and 2D.4 have not started. The router has no measured quality or latency evidence configured, and live provider behavior must be verified separately. This addendum supersedes the earlier Phase 2D sequence where it differs. See [the original Phase 2D review](PHASE_2D_ARCHITECTURE_REVIEW.md) for the broader settings, usage and customer-discovery context.

## Existing persistence and capability audit

At the architecture review baseline, the schema and services did not yet represent routing intent or routing decisions:

| Existing field/service | Current meaning and reuse |
|---|---|
| `UserSettings.provider`, `model`, `temperature` | Existing account-level storage. Map provider/model to the account's default Manual choice and use temperature as the sole persistent generation parameter in the first settings API. They are not currently wired to chat defaults. |
| `UserSettings.responsePreferences`, `memoryEnabled` | Existing account preferences. Keep the same row and keep memory APIs as compatible views of the same field. |
| `Conversation.provider`, `model` | Currently updated to the latest response's provider/model. Insufficient to represent whether the conversation is Auto or Manual, and insufficient to identify every response in Auto mode. |
| `Message.provider`, `model` | Already persisted on assistant messages and identify the actual provider-specific model used for that response. Reuse them as authoritative per-response model attribution. |
| `UsageRecord` / `UsageOutbox` | Already store provider, model, input/output token counts, estimated cost, operation and event time. Historical cost is copied to the record and is not recomputed by `GET /api/usage`. There is no cached-token breakdown, currency field, pricing version or pricing effective-time field. |
| `ModelDefinition` / `ModelRegistry` | Centralized identity, enabled/configured status, context/output limits, tokenizer, streaming/text capabilities, numeric parameter ranges and pricing rates. It does not yet describe vision, tools, structured output, task suitability, quality or latency. |

### Phase 2D.1 implementation state

Phase 2D.1 adds `ModelSelectionMode`, account and conversation preference fields, nullable per-message routing metadata, owner-scoped settings APIs, conversation selection persistence, guest restrictions, and the documented precedence rules. Existing values migrate to Manual; newly registered accounts default to Auto. The additive migration is applied. Mock registration now requires `MOCK_PROVIDER_ENABLED=true` in development/test and is rejected in production. Phase 2D.2 now adds deterministic task classification, capability/context/parameter filtering, provider-independent candidate ranking, pre-delta Auto fallback, no-fallback Manual behavior, route metadata, and the model-selection UI. The router uses only explicit evidence when present; current registry entries do not contain measured quality or task-suitability scores. The API contract and verification record are in `docs/API_CONTRACT.md` and `README.md`.

At the review baseline, `ModelRegistry.resolve()` defaulted to `mock:echo` when the requested ID was omitted, and `ai.ts` automatically registered mock when no live provider credential existed. Those implicit fallbacks have been removed. Existing assistant-message provider/model fields continue to provide per-answer attribution; Phase 2D.1 adds only routing intent/decision metadata.

## Corrected request architecture

The router must run **before model-specific context construction**. ContextBuilder requires a selected model's tokenizer, context window, output limit and provider token-count operation; placing the router after it would make context-fit calculation circular. The request flow should be:

```text
authenticate and resolve request/conversation/account intent
  → classify task and mandatory capabilities
  → ModelRouter filters and ranks configured registry entries
  → selected-model context feasibility check and ContextBuilder finalization
  → provider adapter and streaming generation
  → persist actual per-message model, requested mode, task and routing decision
```

The Router should receive a bounded context requirement estimate (current turn, applicable preferences, summary and memory candidates) and eliminate candidates that cannot fit. ContextBuilder then performs the authoritative selected-model token count and whole-turn selection. If the final check fails before streaming, Auto may try the next already-eligible candidate; Manual returns the context error. Neither mode may switch models after the first text delta.

## Selection modes and compatibility

- **AUTO** is the recommended default for newly registered accounts. The deterministic router may select a different model for each new request in a conversation.
- **MANUAL** honors an explicit model. A provider error, timeout or unavailability is surfaced; Manual never falls back to another model/provider.
- Store account mode separately from conversation mode. New conversations inherit the account mode; changing account defaults never rewrites conversations. A conversation can keep its own mode. A one-request Manual override in an Auto conversation does not silently change the conversation mode.
- Existing `UserSettings.provider/model` values are saved manual preferences. Add a mode field with a migration default of `MANUAL` for existing settings and conversations; create new registered accounts with `AUTO`. This preserves existing manual preferences while allowing Auto as the default for newly registered users. Guest settings stay ephemeral: guests choose a model through chat requests and do not write account settings; guest memory remains unavailable.
- Preserve legacy chat callers: a request with `modelId` and no mode remains Manual. Legacy requests omitting both mode and model keep their documented configured-default behavior. New clients explicitly opt into Auto or send their saved mode. Do not reinterpret an old explicit model as Auto.
- `GET /api/settings` returns the saved default model ID even if it has become unavailable, with a safe availability state/reason code. Do not erase or replace it. Patching an unrelated setting preserves it. Selecting a new unavailable/unknown model is rejected. Manual chat with an unavailable saved choice returns an actionable error until the user explicitly selects an available model.
- Validate saved temperature against the selected model's registry declaration. If a saved parameter is no longer supported, report `SAVED_PARAMETER_UNSUPPORTED`/`UNSUPPORTED_PARAMETER` and identify the preference that needs attention; do not silently drop it. Explicit unsupported request parameters continue to fail validation.

## Minimal persistence plan

Use existing fields wherever possible and add only state that cannot be represented safely:

1. Add account selection mode on `UserSettings` and conversation selection mode on `Conversation`. Existing rows migrate to `MANUAL`; new registered users receive `AUTO`. Keep default provider/model and `temperature` in their existing columns.
2. Reuse assistant `Message.provider`/`model` for the actual resolved provider/model. Add nullable routing metadata to assistant messages: requested selection mode, optional requested manual model ID, task type, routing policy version and a non-sensitive reason code. Nullable additions preserve existing records and old readers.
3. Keep `Conversation.provider`/`model` as latest actual-model convenience only. Never use them as the complete Auto routing history. `UsageRecord` provider/model and its message relation remain the usage attribution source.
4. Keep routing policy separate from user settings and future organization policy. Start with one server-owned balanced policy version; do not add a JSON settings bag or admin policy table.

These additive columns are justified because the current schema cannot distinguish Auto from Manual or reproduce why a per-message route occurred. No new settings table, memory field, workspace entity or duplicate actual-model columns are needed. Migration defaults and new-account creation behavior must be tested together.

## Task classifier, registry and policy

Introduce provider-independent profiles for general conversation, complex reasoning, coding/debugging, writing, document analysis, research, vision, structured extraction, conversation summarization, memory extraction and tool-intensive workflows. Start with deterministic text/request-shape rules and explicit caller requirements; default safely to `general_conversation`. Version the classifier and policy. Do not call an LLM solely to select another LLM.

Extend registry definitions only with evidence-backed capabilities and task-suitability metadata. Candidate filtering requires a configured/enabled provider and model, streaming for the current chat contract, required modality/tool/structured-output support, context fit, and compatible output/parameter limits. The router must not contain model-name or provider-to-task mappings. Rank eligible candidates quality- and suitability-first, using measured task-evaluation results where available. Treat cost and latency as explicit configurable constraints; use them as tie-breakers only among candidates with sufficiently comparable evaluated quality. If no quality evidence exists for a task/model pair, represent that uncertainty and do not claim the router found the “best” model. Never select a materially weaker model solely because it is cheaper or faster. Quality/latency metadata is versioned policy evidence, not an objective universal ranking, and must be validated in evaluation.

Current chat accepts text only; implemented model adapters do not expose vision, web-search tools or structured-output APIs to chat. Those capabilities must remain unavailable in the registry until request shapes, adapters and tests support them. A text request about research is not live web research. Do not advertise vision, document upload, tool use or agent execution as working merely because a routing profile exists.

The router interface should also accept explicit internal profiles for summarization and memory extraction, so those operations can be evaluated independently of interactive chat. Preserve current behavior during migration: a configured `SUMMARY_MODEL_ID` is an explicit Manual pin, and memory extraction in an existing Manual conversation remains on that conversation's provider/model. An Auto conversation may use the `memory_extraction` profile only after that behavior is covered by tests and documented; it must still obey account/provider availability and never route to mock in production. Usage rows/outbox entries already capture the actual provider/model for each background operation.

## Auto fallback and streaming semantics

Define one explicit Auto fallback policy. The first implementation may retry another eligible, configured **non-mock** candidate only for a retryable provider failure before any response text is emitted (for example a transient upstream 429/5xx/network failure). Do not retry validation, context, authentication/configuration, policy or other non-retriable failures. Do not retry after a delta, to avoid mixed or duplicated answers. Manual never retries on another model. Production never falls back to mock.

Current chat flushes SSE headers and sends `meta` before provider stream iteration. For truthful pre-delta Auto fallback, establish the provider stream and observe its initial outcome before committing model attribution; then send metadata containing final actual provider/model, requested mode, task, reason code and fallback indicator before the first delta. Preserve `delta`, `done` and `error` meanings. Persist actual provider/model on the assistant message before or alongside streaming. If Auto has no eligible candidate, fail with an actionable stable code before SSE headers. User-facing explanations should be short reason descriptions; never expose classifier prompts or sensitive routing signals.

## Mock-provider boundary

Replace automatic no-credential mock fallback with explicit `MOCK_PROVIDER_ENABLED=true`, accepted only for `NODE_ENV=development` or `test`. Production catalog and routing must never include mock, and production chat must fail clearly if no live model is configured. Tests/browser harnesses register mock explicitly instead of depending on process-wide fallback. Keep an unmistakable `Mock — local development, no live AI provider` label.

## Pricing semantics and data plan

Today, estimated cost is computed once using the model registry's configured input/output USD-per-million rates and copied to the durable outbox and `UsageRecord`; reads return that stored number without recalculation. A later rate change therefore does not mutate a historical `estimatedCost`, but current records do not identify which rate version produced it. The estimate excludes cached-token discounts and provider billing adjustments or untracked tool/image charges. It is an estimate, never an invoice or actual provider bill.

Document current semantics as **USD**, computed from the server pricing configuration loaded for the request and captured when the usage estimate is created. The stored amount is immutable after persistence. `createdAt` is usage-event persistence time, not necessarily the provider's official price effective date. There is no stored pricing version/effective timestamp today; do not claim that historic rates can be independently reconstructed.

In the later Usage phase, add additive `pricingCurrency`, `pricingVersion` and `pricingEffectiveAt` snapshots to both `UsageOutbox` and `UsageRecord`, and configure a version/effective timestamp with each rate-table change. Keep model ID, token counts, estimated amount and operation. Historical rows retain their captured amount and pricing snapshot; future rate changes never recalculate prior rows. This small schema addition belongs with usage history/dashboard, not settings Phase 2D.1.

## Updated Phase 2D sequence

The routing requirement changes the order and release gates. Each phase remains gated on explicit review and approval.

1. **Phase 2D.1 — Contract, settings and routing persistence foundation.** Update `API_CONTRACT.md` first. Add owner-scoped GET/PATCH settings reusing current columns; represent Auto/Manual account and conversation mode; preserve legacy Manual values; define backward-compatible chat precedence, unavailable preference state, saved-parameter errors, additive per-message route metadata and strict mock configuration. Add additive migrations only for mode/routing metadata. No UI, usage dashboard or onboarding work.
2. **Phase 2D.2 — Deterministic ModelRouter and chat selection experience (implemented).** Provider-independent classification, capability-aware registry filtering, deterministic evidence/preference ranking, context-fit handling, pre-delta Auto fallback, Manual no-fallback, per-answer provider/model/reason display, conversation-mode persistence, request/conversation overrides, and an offline routing evaluation harness are implemented. Vision/tools/structured output remain ineligible until implemented and verified. Summary/memory task profiles retain their existing explicit/pinned behavior.
3. **Phase 2D.3 — Usage experience and pricing provenance.** Add dated filters/aggregates with precise limits, operation separation, USD estimate labels, and additive pricing version/effective-date metadata in usage records/outbox. Never describe estimates as invoices.
4. **Phase 2D.4 — Onboarding and recovery polish.** Explain Auto versus Manual, guest limits/non-persistence, mock mode, memory/summary controls, unavailable models, and interrupted-response recovery. Keep the experience generic across customer segments.
5. **Release/evaluation gate.** Test old-client compatibility; legacy manual users; new Auto defaults; account defaults across conversations; conversation Manual mode; per-request override; Auto model changes across messages; stable route metadata; capability/context rejection; fallback error classes; no production mock; pricing provenance; memory-setting compatibility; guests; isolation; browser recovery; builds/migrations/audits. Report mock and live evidence separately. Measure classification accuracy, capability compliance, selection quality, latency, estimates, fallback frequency and blind human response quality on representative tasks. Do not call routing optimal without comparative evidence.

## Customer-discovery refinement

Keep exploratory interviews in four separate tracks: **B2C** (general consumers, students, creators, researchers); **professionals** (freelancers and independent professionals); **B2B** (agency founders, SME owners, team managers/buyers); and **developer infrastructure** (developers and software-company founders evaluating API/orchestration needs). Within each segment, report frequency, current alternative, quantified cost, purchasing authority, willingness-to-pay evidence and repeat-use trigger. The first 12–15 interviews are problem discovery, not market validation and not a basis for narrowing the four-market vision. Do not merge findings into one feature-request list.
