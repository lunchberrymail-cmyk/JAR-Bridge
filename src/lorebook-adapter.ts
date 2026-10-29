import { cardMetadata, isRecordId, object } from './jar-adapter';

/** One importable book. Entries keep JAR's SillyTavern World Info fields. */
export interface JarLorebook {
  key: string;
  kind: 'public' | 'rebuilt';
  title: string;
  description: string;
  entries: Record<string, unknown>[];
  model?: string;
  rebuiltAt?: number;
}
export interface JarLorebooksResult {
  recordId: string;
  characterName: string;
  /** JanitorAI's per-character proxy setting. JAR refuses capture when false. */
  allowProxy: boolean;
  captured: boolean;
  capturedAt: number;
  rebuiltAt: number;
  /** Titles of linked books JAR could not download (closed or removed). */
  closedTitles: string[];
  books: JarLorebook[];
  /** Set when capture data comes from an earlier JAR record of the same character. */
  earlierRecordAt?: number;
}
export type JarLorebookAction = { state: 'done' | 'running'; lorebooks: JarLorebooksResult };

export const MAX_LOREBOOK_ENTRIES = 5000;
const MAX_TITLE = 200;

function text(value: unknown, limit = 20_000): string { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function stamp(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0; }

/** JAR keeps JanitorAI's HTML description; native books expect plain text. */
function plain(value: unknown): string {
  return text(value, 4000).replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/** Accept SillyTavern's keyed object or an array; reject entries without text. */
export function worldInfoEntries(value: unknown): Record<string, unknown>[] {
  const source = object(value).entries;
  const rows = Array.isArray(source) ? source : source && typeof source === 'object' ? Object.values(source) : [];
  if (rows.length > MAX_LOREBOOK_ENTRIES) throw new Error('This lorebook has too many entries to import.');
  return rows.flatMap(item => {
    const entry = cardMetadata(item) as Record<string, unknown>;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.content !== 'string' || !entry.content.trim()) return [];
    for (const name of ['key', 'keysecondary']) {
      const keys = entry[name];
      entry[name] = Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string' && !!key.trim()) : [];
    }
    return [entry];
  });
}

/** Read only lorebook state from a JAR record; captured prompts never leave the backend. */
export function toLorebooks(recordValue: unknown): JarLorebooksResult {
  const record = object(recordValue);
  if (!isRecordId(record.id)) throw new Error('JAR returned an invalid character ID.');
  const meta = object(record.meta);
  const books: JarLorebook[] = [];
  const closedTitles: string[] = [];
  const linked = Array.isArray(record.publicLorebooks) ? record.publicLorebooks : [];
  for (const item of linked) {
    const book = object(item);
    const title = text(book.title, MAX_TITLE).trim() || 'Untitled lorebook';
    const entries = book.accessible === false ? [] : worldInfoEntries(book.worldInfo);
    if (!entries.length) { closedTitles.push(title); continue; }
    const id = text(book.id, 120);
    books.push({ key: `public:${id || books.length}`, kind: 'public', title, description: plain(book.description), entries });
  }
  const rebuilt = object(record.privateLorebookReconstruction);
  const rebuiltAt = stamp(rebuilt.reconstructedAt);
  const rebuiltEntries = worldInfoEntries(rebuilt.worldInfo);
  if (rebuiltEntries.length) {
    const name = closedTitles.length === 1 ? closedTitles[0] : `${text(record.characterName, MAX_TITLE).trim() || 'Character'} closed lorebook`;
    books.push({ key: `rebuilt:${rebuiltAt}`, kind: 'rebuilt', title: `${name} (rebuilt)`, description: 'Rebuilt by JAR from a captured JanitorAI prompt. Trigger keywords were inferred by an LLM.',
      entries: rebuiltEntries, model: text(rebuilt.reconstructedModel, 120), rebuiltAt });
  }
  const payload = record.payload;
  return {
    recordId: record.id, characterName: text(record.characterName, MAX_TITLE),
    allowProxy: meta.allow_proxy !== false,
    captured: !!payload && typeof payload === 'object' && Object.keys(payload).length > 0,
    capturedAt: stamp(record.capturedAt), rebuiltAt, closedTitles, books,
  };
}

/** JanitorAI character UUID of a record, used to match JAR records of one character. */
export function characterIdOf(recordValue: unknown): string {
  const id = object(recordValue).characterId;
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : '';
}

/**
 * Each JAR link preview creates a fresh record, so a closed lorebook captured
 * earlier lives on an older record. Keep the fresh public books and take the
 * capture state and rebuilt book from the earlier record.
 */
export function mergeEarlierCapture(fresh: JarLorebooksResult, earlier: JarLorebooksResult, earlierAt: number): JarLorebooksResult {
  return { ...fresh, captured: earlier.captured, capturedAt: earlier.capturedAt, rebuiltAt: earlier.rebuiltAt,
    books: [...fresh.books.filter(book => book.kind === 'public'), ...earlier.books.filter(book => book.kind === 'rebuilt')], earlierRecordAt: earlierAt };
}

/** The exact body sent to Lumiverse's native world book importer. */
export function nativeLorebook(book: JarLorebook): { name: string; description: string; entries: Record<string, unknown>[] } {
  return { name: book.title, description: book.description, entries: book.entries };
}
