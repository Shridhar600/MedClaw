# memcore

**Purpose:** Core memory stores — the v2 memory system's heart. Manages the ledger
(Markdown + SQLite mirror), daily narratives, episodes, curated MEMORY.md, scratch notes,
inferences, curiosity items, and the SAFETY.md rendered view.

**Public API (index.ts):**
- `LedgerStore` — CRUD for typed ledger facts with versioning, NEEDS_CONFIRM token flow,
  conflict resolution, and Markdown round-trip serialization. Lifecycle mutations
  `discontinue` / `restart` / `pause` (med-class changes require confirmation) and cross-entity
  links (`replaces`/`replacedBy`, `corrects`/`correctedBy`) surfaced via `getCrossLinks`.
- `NarrativeStore` — append-only daily logs (`memory/YYYY-MM-DD.md`) with verbatim-quote
  preservation and a `## Ledger writes` cross-anchor section; explicit-date-over-clock so the
  narrative and ledger lanes agree on the day.
- `SafetyView` — renders `SAFETY.md` (always-injected safety net) from safety-relevant
  active/resolved facts; preserves agent-add-only `## Critical Events` + user `## Notes` and any
  hand-written section; date-free (C6a); base allergy/med removal refused in code without user
  confirmation (`SafetyRemovalRefusedError`).
- `CuratedMemory` — `MEMORY.md` budget engine, Health 60% / Life 20% / Agent 20%, fail-loud
  (`BudgetExceededError`), never auto-evicts across categories, never evicts health for non-health.
- `EpisodeStore` — episode CRUD + fact linking + a **paged** `list` (no whole-dir slurp); one file
  per episode under `episodes/`.
- `ScratchStore` — ephemeral `scratch/<id>.md` notes with a TTL sweep (injected clock) and a
  `scanForPromotion` safety gate (credential reuse + `INJECTION_PATTERNS` defense-in-depth).
- `CuriosityQueue` — durable `curiosity.md` follow-up items (add/list/resolve); consumed by P4.
- `parseLedgerFile` / `renderLedgerFile` — pure Markdown round-trip for ledger files.
- Types: `LedgerFact`, `Provenance`, `FactStatus`, `FactType`, `Authority`, `NarrativeAppendResult`,
  `Episode`, `ScratchNote`, `CuratedMemoryOptions`, etc.

**Dependencies:** `ports`, `shared` (errors), and `security` (six of the seven stores use
`secureWriteViaTmp` / `summarizeErrorForLog` / `quarantineToSideFile` / `contentContainsCredentials`).

**Extraction notes:** Markdown is source of truth; SQLite is a disposable mirror.
Copy `src/memcore/` + `src/ports/` + `src/shared/` + `src/security/` for standalone use.
