# capture

**Purpose:** CapturePipeline — the turn-level `CaptureEvent` router. Given a normalized
event it writes BOTH memory lanes (structured ledger + lossless narrative) with
cross-anchors and re-renders SAFETY.md on safety-relevant facts, all inside ONE
turn-priority write-queue op per event (IO-only). The `CaptureEvent` type
(a discriminated union of INPUT shapes) lives in `memcore`.

**Public API (index.ts):**
- `CapturePipeline` — `ingest(event)` routes by `event.kind`:
  - `ledger-fact` — narrative note → set `provenance.anchor` → `ledger.recordFact` →
    `narrative.appendLedgerAnchor` → re-render SAFETY when the applied fact is
    safety-relevant. On `needs-confirmation`/`disputed` the note stands but no anchor
    is written and SAFETY is not re-rendered (no applied change); the result is returned so
    the tool layer can relay the question.
  - `narrative-note` — narrative lane only.
  - `metric-point` — a `metric` fact whose `fields` carry a `date` + a note.
  - `curiosity-item` — routed to the curiosity queue (dropped-with-warn if none injected).
  - `ledger-correction` — record the corrected fact (with `corrects`/`replaces` cross-link)
    and retract the mistaken one, both lanes, one op.
  - unknown kind — warn-and-continue, never throw.
- In-module port types: `QueuePort`, `LedgerWriter`, `NarrativeWriter`, `SafetyRenderer`,
  `CuriosityWriter`, `CapturePipelineDeps`.

**Dependencies:** ports (event-sink, clock), security (sanitized logging), memcore
(TYPE-ONLY). No concrete-class import from memcore.

**Extraction notes:** Depends only on in-module interfaces — the Gateway
injects the concrete `LedgerStore`/`NarrativeStore`/`SafetyView`-adapter/`WriteQueue`/
`CuriosityQueue`, which structurally satisfy them. The day for both lanes is derived from
the event's `capturedAt`, not a store clock.
