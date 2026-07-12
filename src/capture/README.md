# capture

**Purpose:** CapturePipeline + CaptureEvent — the ContextSource port. Receives
normalized inbound events from any channel or internal source and routes them to the
appropriate store (fact mirror, event sink, narrative log).

**Public API (index.ts):**
- `CapturePipeline` — `ingest(event)` method that classifies and routes capture events
  to the correct storage backend.

**Dependencies:** ports (fact-mirror, event-sink), memcore (types only)

**Extraction notes:** Pure routing logic behind port abstractions. No transport concerns.
