# memcore

**Purpose:** Core memory stores — the v2 memory system's heart. Manages the ledger
(Markdown + SQLite mirror), daily narratives, episodes, curated MEMORY.md, scratch notes,
inferences, curiosity items, and the SAFETY.md rendered view.

**Public API (index.ts):**
- `LedgerStore` — CRUD for typed ledger facts with versioning, NEEDS_CONFIRM token flow,
  conflict resolution, and Markdown round-trip serialization.
- `parseLedgerFile` / `renderLedgerFile` — pure Markdown round-trip for ledger files.
- Types: `LedgerFact`, `Provenance`, `FactStatus`, `FactType`, `Authority`, etc.

**Dependencies:** ports, shared (errors)

**Extraction notes:** Markdown is source of truth; SQLite is a disposable mirror.
Copy `src/memcore/` + `src/ports/` + `src/shared/` for standalone use.
