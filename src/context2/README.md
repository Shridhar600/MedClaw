# context2

**Purpose:** ContextAssembler v2 — builds the assembled prompt from L1/L2/L3 sections,
applies cache boundaries, and enforces invariants (SAFETY must be present, no volatile
tokens in stable sections, per-section truncation).

**Public API (index.ts):**
- `ContextAssembler` — takes recall results and assembles them into structured context.
  Returns `ContextReport` (sections, token counts, truncation info).

**Dependencies:** ports (fact-mirror, kv-cache), shared, memcore (types only)

**Extraction notes:** No I/O except through ports. Invariant violations abort the turn.
