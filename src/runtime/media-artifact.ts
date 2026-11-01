import { randomUUID } from 'crypto';

const ARTIFACT_PREFIX = 'medclaw-media-';
export const MEDIA_PARTIAL_SUFFIX = '.part';
const IDENTITY = /^medclaw-media-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-(.+)$/su;

/** One reserved namespace for streaming partials and their unadopted final files. */
export function createMediaArtifactName(displayName?: string): string {
  return `${ARTIFACT_PREFIX}${randomUUID()}-${sanitizeBasename(displayName) || 'upload'}`;
}

/** Match the complete generated grammar, never arbitrary `.part` files or prefix lookalikes. */
export function isMediaStagingArtifact(name: string): boolean {
  const basename = IDENTITY.exec(name)?.[1];
  if (!basename) return false;
  const valid = (value: string): boolean => value.length > 0 && sanitizeBasename(value) === value;
  return valid(basename)
    || (basename.endsWith(MEDIA_PARTIAL_SUFFIX) && valid(basename.slice(0, -MEDIA_PARTIAL_SUFFIX.length)));
}

function sanitizeBasename(name: string | undefined): string {
  return (name ?? '')
    .replace(/[\\/\0]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
}
