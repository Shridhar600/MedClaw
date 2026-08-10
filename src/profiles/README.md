# profiles

**Purpose:** Profile lifecycle — ids, paths, pairing, per-profile config overlay, and a
serialized mutation queue that all writers funnel through.

**Public API (index.ts):**
- `ProfileRegistry` — manage profile identities, resolve IDs from channel chat/user IDs,
  enforce pairing flows in coordination with the gateway.
- `WriteQueue` — per-profile serialized mutation queue: single promise-chain per profile.
  Every mutation (agent turn, dream, heartbeat, TTL sweep, ledger or memory write) goes
  through this queue to guarantee ordering.

**Dependencies:** ports (clock, id-gen), memcore (types only)

**Extraction notes:** Depends only on ports/ for interfaces; memcore/types.ts is pure types.
Standalone extraction = copy `src/profiles/` + `src/ports/`.
