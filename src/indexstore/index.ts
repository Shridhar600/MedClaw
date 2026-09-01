export {
  SqliteVecIndex,
  VectorDimensionMismatchError,
  VectorIndexUnavailableError,
  VectorQueryFailedError,
} from './adapters/sqlite-vec-index';
export type { SqliteVecIndexConfig } from './adapters/sqlite-vec-index';
export { SqliteFactMirror } from './adapters/sqlite-fact-mirror';
export type { SqliteFactMirrorConfig } from './adapters/sqlite-fact-mirror';
export { SqliteKeywordIndex } from './adapters/sqlite-keyword-index';
export type { SqliteKeywordIndexConfig } from './adapters/sqlite-keyword-index';
export { SqliteEventSink } from './adapters/sqlite-event-sink';
export type { SqliteEventSinkConfig } from './adapters/sqlite-event-sink';
export { SqliteChunkStats } from './adapters/sqlite-chunk-stats';
export type { SqliteChunkStatsConfig } from './adapters/sqlite-chunk-stats';
export { SqliteSessionIndex } from './session-index';
export type { SqliteSessionIndexConfig, SessionHit, SessionSearchResult } from './session-index';
export { ledgerFactToRecord } from './fact-record';
export { isRemoteEmbeddingBaseUrl } from './embedding-identity';
