// memcore barrel — the v2 memory system's public surface.
// Stores are pure + injected (no module-level state); Markdown is the source of truth.

// Ledger (versioned health facts)
export { LedgerStore } from './ledger-store';
export { parseLedgerFile, renderLedgerFile, canonicalFieldValue, canonicalFields } from './ledger-parser';

// Render-boundary sanitizer (INJ) — single-line discipline for embedded text
export { sanitizeSingleLine } from './sanitize';

// Typed confirmation-token rejections (PHI-free reasons)
export { TokenRejectedError } from './token-errors';
export type { TokenRejectionReason } from './token-errors';

// Narrative lane (daily logs)
export { NarrativeStore } from './narrative-store';
export type { NarrativeAppendResult } from './narrative-store';

// SAFETY.md rendered view
export { SafetyView, SafetyRemovalRefusedError, SafetyProjectionDirtyError } from './safety-view';
export type { CriticalEvent } from './safety-view';

// MEMORY.md curated budget engine
export { CuratedMemory } from './curated-memory';
export type { MemorySection, CuratedMemoryOptions } from './curated-memory';

// Episodes (health-arc grouping)
export { EpisodeStore } from './episode-store';
export type {
  Episode, EpisodeStatus, CreateEpisodeInput, UpdateEpisodePatch,
  EpisodeListOptions, EpisodePage,
} from './episode-store';

// Scratch notes (ephemeral, TTL-swept, promotion-scanned)
export { ScratchStore, INJECTION_PATTERNS, DEFAULT_TTL_MS } from './scratch-store';
export type { ScratchNote, ScratchStoreOptions, PromotionScanResult } from './scratch-store';

// Curiosity queue (durable follow-up items, consumed P4)
export { CuriosityQueue } from './curiosity-queue';
export type { AddCuriosityInput } from './curiosity-queue';

// Nightly transcript sweep (spec 14 §5) — deterministic capture-miss detector, no LLM
export { sweep, normalizeEntity, DEFAULT_SWEEP_LEXICON } from './transcript-sweep';
export type { SweepInput, SweepResult, SweepLexicon } from './transcript-sweep';

// Core types
export type {
  Authority, Provenance, FactStatus, FactType, LedgerFact,
  ConfirmationToken, ConfirmationContext, MetricPoint, NarrativeNote, CuriosityKind,
  CuriosityItem, CaptureEvent, PendingOp, StoredToken,
  RecordFactResult, RetractResult, LedgerMutationResult,
  LedgerFactInput, NarrativeNoteInput, MetricPointInput, LedgerCorrectionInput,
} from './types';
export { AUTHORITY_RANK, TYPE_TO_FILE } from './types';
