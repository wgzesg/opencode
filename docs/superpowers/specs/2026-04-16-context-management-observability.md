# Context Management Observability

**Date:** 2026-04-16
**Status:** Approved

## Problem

The context management system (pruning, compaction, overflow detection, tool output replacement) operates as a black box. There is no tracing, structured logging, or span attributes to understand:

- When and why pruning decisions are made
- How the context window fills up over a session
- What tool outputs are replaced and how many tokens are saved
- Where the compaction boundary falls and how many messages are discarded
- When tool outputs are truncated at the tool execution layer

## Scope

Lightweight logging + span attributes added to existing operations. No new services, no new dependencies. ~150 lines across 4 files.

## Changes

### 1. Pruning (`compaction.ts` — `prune()`)

Add structured logging with per-part detail and summary metrics:

- Log each pruned part: `tool`, `callID`, `estimated_tokens`
- Summary log: `pruned_tokens`, `total_tokens`, `parts_count`, `tool_names`
- The existing Effect.fn span `SessionCompaction.prune` already exists; add span attributes for `prune.total_tokens`, `prune.pruned_tokens`, `prune.parts_count`

### 2. Overflow Check (`overflow.ts`)

Add a structured log emitted on every call with:

- `token_count`, `usable_tokens`, `utilization_pct`, `overflow` (boolean)
- Token breakdown: `input`, `output`, `reasoning`, `cache_read`, `cache_write`

This fires on every step completion via the processor, giving a timeline of context fill-up.

### 3. Compaction Process (`compaction.ts` — `processCompaction()`)

Add structured logging at entry and exit:

- Entry: `messages_input` count, `has_replay`, `model` ID
- Exit: `result` ("continue"/"stop"), `messages_after` (if replay)

### 4. Tool Output Replacement (`message-v2.ts` — `toModelMessagesEffect()`)

At the point where compacted tool outputs are replaced with `"[Old tool result content cleared]"`:

- Accumulate count and estimated tokens of replaced outputs
- Emit summary log at end: `replaced_count`, `replaced_tokens_estimate`

### 5. filterCompacted (`message-v2.ts`)

After filtering, log:

- `total_messages`, `kept_messages`, `compaction_boundary_id` (or "none")

### 6. Tool Truncation (`truncate.ts`)

When output exceeds limits, log:

- `tool_name`, `original_bytes`, `final_bytes`, `original_lines`, `final_lines`

## Files

| File | Change |
|------|--------|
| `packages/opencode/src/session/compaction.ts` | Structured logs in `prune()` and `processCompaction()` |
| `packages/opencode/src/session/overflow.ts` | Structured log with token breakdown |
| `packages/opencode/src/session/message-v2.ts` | Replacement counting + filterCompacted logging |
| `packages/opencode/src/tool/truncate.ts` | Truncation event logging |

## Non-goals

- No new OTel metrics or dashboards
- No changes to pruning/compaction logic itself
- No per-step context budget span (deferred to phase 2)
