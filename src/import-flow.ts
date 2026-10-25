import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

export type ImportedCharacter = { id: string; name: string; image_id?: string };
export class ImportError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); this.name = 'ImportError'; }
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** A single explicit native import. Callers lock the selected source while this runs. */
export async function importNativeCard(
  ctx: Pick<SpindleFrontendContext, 'permissions'>,
  makeFile: () => Promise<File>,
  current: () => boolean,
  signal: AbortSignal,
): Promise<ImportedCharacter> {
  const active = () => current() && !signal.aborted;
  if (!active()) throw new DOMException('Import cancelled.', 'AbortError');
  let granted = await ctx.permissions.getGranted();
  if (!active()) throw new DOMException('Import cancelled.', 'AbortError');
  if (!granted.includes('characters')) {
    granted = await ctx.permissions.request(['characters'], { reason: 'Import the character card you selected into your normal Lumiverse library.' });
    if (!active()) throw new DOMException('Import cancelled.', 'AbortError');
    if (!granted.includes('characters')) throw new ImportError('Allow Characters to import this card.');
  }
  const file = await makeFile();
  if (!active()) throw new DOMException('Import cancelled.', 'AbortError');
  // Conversion and permission prompts may take time. Recheck immediately before writing.
  granted = await ctx.permissions.getGranted();
  if (!active()) throw new DOMException('Import cancelled.', 'AbortError');
  if (!granted.includes('characters')) throw new ImportError('Characters permission was removed. The card has not been imported.');
  const body = new FormData(); body.append('file', file);
  let response: Response;
  try { response = await fetch('/api/v1/characters/import', { method: 'POST', credentials: 'same-origin', body, signal }); }
  catch { throw new ImportError('The import response was interrupted. Check your character library before trying again.', true); }
  let data: Record<string, unknown>;
  try { data = object(await response.json()); }
  catch { throw new ImportError('Lumiverse returned an unreadable result. Check your character library before trying again.', true); }
  if (!response.ok) {
    const code = typeof data.code === 'string' ? data.code : '';
    const known = response.status === 413
      ? ['file_too_large', 'archive_decompresses_too_large'].includes(code)
      : response.status === 400 && ['invalid_archive', 'invalid_card', 'unsupported_format'].includes(code);
    throw new ImportError(known ? 'This file could not be read as a character card. Choose a JAR card export (PNG or JSON).' : 'Lumiverse could not confirm the import. Check your character library before trying again.', !known);
  }
  const character = object(data.character ?? data);
  if (typeof character.id !== 'string' || !character.id.trim()) throw new ImportError('Lumiverse did not return a character ID. Check your character library before trying again.', true);
  return { id: character.id, name: typeof character.name === 'string' ? character.name : file.name, ...(typeof character.image_id === 'string' ? { image_id: character.image_id } : {}) };
}
