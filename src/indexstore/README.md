# indexstore

**Purpose:** Index building and storage — vector (sqlite-vec vec0) and keyword (SQLite FTS5)
indexes for chunk-level search. Adapters implement ports/ interfaces. The indexer2 module
handles incremental chunk/embed on write.

**Public API (index.ts):**
- `SqliteVecIndex` — VectorIndex adapter backed by sqlite-vec.

**Dependencies:** ports (vector-index, keyword-index, embedding-port), sqlite-vec (npm)

**Extraction notes:** Adapter layer — swap sqlite-vec for ChromaDB by writing a new adapter
that implements the same port interface. No core module changes needed.
