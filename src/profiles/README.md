# profiles

**Purpose:** The selected owner's identity and paths, the enrollment/admission state machine,
and a serialized mutation queue that all writers funnel through.

**Public API (index.ts):**
- `resolveOwnerPaths` / `derivedPathsFor` — PURE derivation of every owner resource path from one
  base directory and one owner id. No disk access, no config read, no fallback.
- `asProfileId` / `isValidProfileId` / `OWNER_ID_PATTERN` — the owner-id grammar, shared with the
  config decoder so both refuse the same identities. The id is a path segment, so the grammar is
  also the traversal guard.
- `OwnerAdmissionService` — the ONLY authority for who may reach a clinical runtime. Reads the owner
  record fresh per decision; owns pairing, binding, throttling and destination authorization.
  Publication truth comes from the port's typed result, never from an errno: `initialize()` reports
  `created` only for a confirmed replacement and otherwise reports `exists` (record already there),
  `unavailable` (existing record unreadable), `refused` (nothing published) or `uncertain` (possibly
  published, confirmation incomplete).
- `decodeOwnerState` / `encodeOwnerState` — the closed owner-record schema.
- `WriteQueue` — per-profile serialized mutation queue: single promise-chain per profile.
  Every mutation (agent turn, dream, heartbeat, TTL sweep, ledger or memory write) goes
  through this queue to guarantee ordering.

**No profile registry:** chat→identity resolution and every grant of authority belong to owner
admission alone. Nothing else may map a chat to an identity.

**Dependencies:** ports (clock, id-gen), memcore (types only)

**Extraction notes:** Depends only on ports/ for interfaces; memcore/types.ts is pure types.
Standalone extraction = copy `src/profiles/` + `src/ports/`.
