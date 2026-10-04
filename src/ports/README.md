# ports

**Purpose:** The dependency-inversion seam for the v2 core. Pure interface contracts (plus a
couple of stateless default instances) that let stores/adapters depend on capabilities, not
concretes — so the memory core stays liftable and test-fakeable.

**Public API (index.ts):**
- Interfaces: `VectorIndex`, `KeywordIndex`, `FactMirror`, `EventSink`, `EmbeddingPort`,
  `BlobStore`, `KVCache`, `Clock`, `IdGen` (+ their record/stat types).
- Owner/media seams: `OwnerStatePort`, `PairingCodePort`, `TransportIdentity`, `AdmissionDecision`,
  `AdmissionReason`, `PairingResult`, `MediaSourcePort`, `MediaReference`, `OpenedMedia`,
  `MediaStageResult`, `MediaStageReason`, `MediaLimits` (+ the S1 media bound constants).
- Observability seam: `DiagnosticSink`, `DiagnosticEvent`, `DiagnosticStage`, `StartStopReason`,
  `PairingDiagnosticReason`, plus `SILENT_DIAGNOSTIC_SINK` and `guardedDiagnosticSink`.
- `SystemClock` / `CryptoIdGen` classes and the shared stateless singletons `systemClock` /
  `uuidIdGen` (injected as defaults across the memcore stores).

**Dependencies:** none (bottom of the v2 dependency graph — ports import nothing from `src/`
outside `ports/`, enforced by `arch:check`). Sibling-port imports are allowed and used where two
seams genuinely share one vocabulary: `diagnostics.ts` references `AdmissionReason` /
`PairingResultKind` from `owner-state.ts` and `MediaStageReason` from `media-source.ts` rather than
restating them, so there is exactly one definition of "why did this refuse" in the system.

**Extraction notes:** Copy `src/ports/` alone; it has no runtime dependencies.

## diagnostics.ts — the observability boundary

`DiagnosticSink.emit(event: DiagnosticEvent): void` takes a **closed tagged union**. The event is a
discriminated union on `stage` (`owner-admission` | `pairing` | `media-intake` | `start-stop`) and,
within each stage, on `outcome`. There is deliberately **no `payload`, no `message`, no `error`, no
`detail` and no `path` field**, because this sink runs while a stranger is talking to the process:
if it could carry arbitrary content, a stranger could put arbitrary content in the logs.

What each variant may carry:

| Field | Meaning |
|---|---|
| `stage` | Which bounded operation produced the event. |
| `outcome` | Allowlisted. `admitted` / `pairing-only` / `refused` for admission; progress vs refusal for pairing; `saved` / `refused` for intake; `started` / `stopped` / `refused` / `failed` for start-stop. |
| `reason` | **Required** on every refusal variant, never optional. "Refused, but nobody said why" is unrepresentable. |
| `durationMs` | Measured span, always present. |
| `bytes` / `attempts` | At most one bounded count per variant. |

Deliberately **excluded**: ids of any kind (owner, chat, sender, event), filesystem paths, URLs,
pairing codes, health text, exception objects and their messages.

`guardedDiagnosticSink(sink)` wraps any adapter so a throwing one cannot propagate. This is a
guarantee, not a convention: `emit` is on the critical path of `admit()` and of media intake, so an
adapter that threw on an unexpected value would otherwise be reachable from a stranger's message and
would turn a logging fault into a denial of service. A guarded sink that fails degrades to silence,
which is the same outcome as having no sink — so observability can never change control flow.
`OwnerAdmissionService` and `FsMediaStager` each guard once in their constructor, so no call site can
forget.

Production supplies **no sink** and therefore prints nothing: the brief requires outcomes to be
*emittable* through this contract and requires local explicit output to be a separate surface.
