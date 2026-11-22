# ports

**Purpose:** The dependency-inversion seam for the v2 core. Pure interface contracts (plus a
couple of stateless default instances) that let stores/adapters depend on capabilities, not
concretes — so the memory core stays liftable and test-fakeable.

**Public API (index.ts):**
- Interfaces: `VectorIndex`, `KeywordIndex`, `FactMirror`, `EventSink`, `EmbeddingPort`,
  `Clock`, `IdGen` (+ their record/stat types).
- Owner/media seams: `OwnerStatePort` (its `replace` returns the typed `OwnerStateWriteResult`),
  `PairingCodePort`, `TransportIdentity`, `AdmissionDecision`, `AdmissionReason`, `PairingResult`,
  `MediaSourcePort`, `MediaReference`, `OpenedMedia`, `MediaStageResult`, `MediaStageReason`,
  `MediaLimits` (+ the media bound constants and the shared `OWNER_RECORD_MAX_BYTES` budget).
- Observability seam: `DiagnosticSink`, `DiagnosticEvent`, `DiagnosticStage`, `StartStopReason`,
  `PairingDiagnosticReason`, plus `SILENT_DIAGNOSTIC_SINK` and `guardedDiagnosticSink`.
- `SystemClock` / `CryptoIdGen` classes and the shared stateless singletons `systemClock` /
  `uuidIdGen` (injected as defaults across the memcore stores).

**Dependencies:** none (bottom of the dependency graph — ports import nothing from `src/`
outside `ports/`, enforced by `arch:check`). Sibling-port imports are allowed and used where two
seams genuinely share one vocabulary: `diagnostics.ts` references `AdmissionReason` /
`PairingResultKind` from `owner-state.ts` and `MediaStageReason` from `media-source.ts` rather than
restating them, so there is exactly one definition of "why did this refuse" in the system.

**Extraction notes:** Copy `src/ports/` alone; it has no runtime dependencies.

## owner-state.ts — the publication boundary

`OWNER_RECORD_MAX_BYTES` is ONE budget, declared here because policy, writer and reader must agree on
it: the writer enforces it on the encoded bytes BEFORE publishing and the reader enforces it on the
bytes it actually reads. A writer that may publish more than the reader accepts is how one owner's own
pairing traffic made the app's record unreadable after a restart.

`OwnerStatePort.replace` returns `OwnerStateWriteResult` — `committed`, `failed` (nothing published,
previous bytes unchanged) or `uncertain` (published or possibly published, confirmation incomplete) —
because only the adapter knows which side of the rename failed. Policy MUST NOT infer that from an
errno: `EACCES`/`EPERM`/`EROFS`/`ENOSPC`/`EIO` are all raised AFTER a rename has landed too.

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
| `operation` | Start-stop only: `start`, `promotion` or `stop`. One terminal result per attempt/flight. |
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

Reusable constructors default to silence. The daemon root deliberately selects `ConsoleDiagnosticSink`
from `../runtime` and shares it with admission/Gateway/staging. Local admin inspection stays separate.
Candidate-table saturation is `candidate-capacity-reached`, without a fabricated attempts count.
`stopped` describes Gateway stop completion; it does not assert root leases released or full quiescence.
