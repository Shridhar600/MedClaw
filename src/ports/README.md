# ports

**Purpose:** The dependency-inversion seam for the v2 core. Pure interface contracts (plus a
couple of stateless default instances) that let stores/adapters depend on capabilities, not
concretes — so the memory core stays liftable and test-fakeable.

**Public API (index.ts):**
- Interfaces: `VectorIndex`, `KeywordIndex`, `FactMirror`, `EventSink`, `EmbeddingPort`,
  `BlobStore`, `KVCache`, `Clock`, `IdGen` (+ their record/stat types).
- `SystemClock` / `CryptoIdGen` classes and the shared stateless singletons `systemClock` /
  `uuidIdGen` (injected as defaults across the memcore stores).

**Dependencies:** none (bottom of the v2 dependency graph — ports import nothing from `src/`
outside `ports/`, enforced by `arch:check`).

**Extraction notes:** Copy `src/ports/` alone; it has no runtime dependencies.
