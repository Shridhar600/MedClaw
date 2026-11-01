# context2

**Purpose:** ContextAssembler v2 — builds the assembled prompt from L1/L2/L3 sections,
applies cache boundaries, and enforces invariants (SAFETY must be present, no volatile
tokens in stable sections, per-section truncation).

**Public API (index.ts):**
- `ContextAssembler` — takes recall results and assembles them into structured context.
  Returns `ContextReport` (sections, token counts, truncation info). Skeleton only.
- `assertSafetyInjected(assembledPrompt, safetyContent)` — the boot-time SAFETY.md
  non-omission guard. Pure: no-op on empty content, throws
  `InvariantViolationError` when non-empty SAFETY.md is not present in full. Wired into the
  legacy `agent/context.ts` builder, which runs once at `Gateway.start()`; a violation
  aborts boot (medical-safety > resilience). There is no per-turn refresh yet.

**Dependencies:** ports (fact-mirror, kv-cache), shared, memcore (types only)

**Extraction notes:** No I/O except through ports. Invariant violations abort the turn/boot.
