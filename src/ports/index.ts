export type { VectorIndex, VectorStats, Chunk, ChunkWithScore } from './vector-index';
export type { KeywordIndex } from './keyword-index';
export type { FactMirror, FactRecord } from './fact-mirror';
export type { EventSink, EventRecord, TimeRange } from './event-sink';
export type { ChunkStatsWriter, ChunkStat } from './chunk-stats';
export type { EmbeddingPort } from './embedding-port';
export type { BlobStore } from './blob-store';
export type { KVCache } from './kv-cache';
export type { Clock } from './clock';
export type { IdGen } from './id-gen';
export { SystemClock, CryptoIdGen, systemClock, uuidIdGen } from './defaults';
export type {
  AdmissionDecision,
  AdmissionReason,
  OwnerBinding,
  OwnerChallenge,
  OwnerReadReason,
  OwnerState,
  OwnerStatePort,
  OwnerStateRead,
  OwnerStateWriteResult,
  OwnerWriteReason,
  PairingAttempts,
  PairingCandidateChat,
  PairingCodePort,
  PairingResult,
  PairingResultKind,
  TransportIdentity,
} from './owner-state';
export { isBoundOwnerState, isUnpairedOwnerState, OWNER_RECORD_MAX_BYTES } from './owner-state';
export type {
  DiagnosticEvent,
  DiagnosticSink,
  DiagnosticStage,
  StartStopReason,
} from './diagnostics';
export { SILENT_DIAGNOSTIC_SINK, guardedDiagnosticSink } from './diagnostics';
export type {
  MediaReference,
  MediaSourcePort,
  MediaStageResult,
  MediaStageReason,
  MediaLimits,
  OpenedMedia,
} from './media-source';
export {
  DEFAULT_MEDIA_LIMITS,
  MEDIA_INTAKE_TIMEOUT_MS,
  MEDIA_MAX_ACTIVE,
  MEDIA_MAX_FILE_BYTES,
  MEDIA_MAX_WAITING,
} from './media-source';
export {
  PAIRING_ATTEMPTS_PER_CHAT_PER_DAY,
  PAIRING_CODE_EXPIRY_MS,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_SYMBOLS,
  PAIRING_MAX_CANDIDATE_CHATS,
  PAIRING_MAX_EVENT_ID_LENGTH,
  PAIRING_MAX_EVENT_IDS_PER_CHAT,
  PAIRING_MAX_ID_LENGTH,
} from './owner-state';
