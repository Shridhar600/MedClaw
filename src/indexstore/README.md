# indexstore

**Purpose:** Index building and storage — vector (sqlite-vec vec0) and keyword (SQLite FTS5)
indexes for chunk-level search. Adapters implement `ports/` interfaces. The indexer2 module
handles incremental chunk/embed on write.

**Public API (index.ts):**
- `SqliteVecIndex` — `VectorIndex` adapter backed by sqlite-vec. Opens its OWN
  `better-sqlite3` connection to the injected `search.db` (WAL permits multiple
  connections) and imports `better-sqlite3` + `sqlite-vec` DIRECTLY — never `src/memory/`
  (the v2→legacy boundary forbids it). Targets the same `chunks` + `chunks_vec0` tables
  idempotently and self-migrates the two columns the port carries beyond P0's schema
  (`lane`, `created_at`). Dimension is fixed eagerly via config or lazily on the first
  embedded upsert; a mismatch throws `VectorDimensionMismatchError` (B3).
- `VectorDimensionMismatchError`, `SqliteVecIndexConfig`.

**P1 scope (specs/16 §8 obligation — no waiver, G2):** the port seam + the shared contract
(`tests/ports/vector-index.contract.ts`), NOT a live write-path swap. P0's indexer stays
the primary writer; the adapter's writes are exercised by the contract suite against a temp
DB. Live wiring is P2.

**Dependencies:** ports (vector-index), security (sanitized logging), better-sqlite3 +
sqlite-vec (npm).

**Extraction notes:** Adapter layer — swap sqlite-vec for another backend by writing a new
adapter that passes `runVectorIndexContract`. No core module changes needed.
