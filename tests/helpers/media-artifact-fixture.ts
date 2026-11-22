import { FsMediaStager } from '../../src/runtime';
import type { OpenedMedia } from '../../src/ports';

/** Persist recognizable fixture bytes through the production stager, never a parallel naming regex. */
export async function stageMediaFixture(trustedBaseDir: string, staging: string, bytes: string, displayName = 'fixture.pdf'): Promise<string> {
  const stager = new FsMediaStager({
    open: async (): Promise<OpenedMedia> => ({ chunks: (async function* (): AsyncGenerator<Uint8Array, void, unknown> { yield Buffer.from(bytes); })(), cancel: async (): Promise<void> => {} }),
  }, staging, { trustedBaseDir });
  const result = await stager.stage({ channel: 'local', fileId: 'synthetic-fixture', kind: 'document', displayName }, new AbortController().signal);
  if (result.kind !== 'saved') throw new Error('media fixture did not stage');
  return result.absolutePath;
}
