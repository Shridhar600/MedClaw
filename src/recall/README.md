# recall

**Purpose:** The 4-stage per-turn recall pipeline that retrieves relevant context from
all memory subsystems. Runs within a 200ms latency budget.

**Public API (index.ts):**
- `RecallEngine` — orchestrates safety, ledger, narrative, and entity stages.
  Takes injected ports (embedding, vector-index, keyword-index, fact-mirror) + config.
- `scoreChunk` — pure scoring function: (0.7·cos + 0.3·bm25n) · exp(-ageDays/45) · authBoost.

**Dependencies:** ports (embedding-port, vector-index, keyword-index, fact-mirror), shared

**Extraction notes:** Pure orchestration + scoring; no I/O except through ports.
