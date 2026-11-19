import type { SpindleAPI } from 'lumiverse-spindle-types';
import { isRecordId, object } from './jar-adapter';
import { MAX_LOREBOOK_ENTRIES, worldInfoEntries, type JarLorebook, type JarLorebooksResult } from './lorebook-adapter';

/** Largest rebuild prompt passed from JAR to the user's Lumiverse connection. */
export const MAX_PROMPT_CHARS = 2_000_000;
const FILE_PREFIX = 'rebuilt-';

export interface PromptMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface SavedRebuild { schemaVersion: 1; recordId: string; rebuiltAt: number; capturedAt: number; model: string; entries: Record<string, unknown>[] }

/** JAR's /api/extract-preview messages, checked before they reach the user's connection. */
export function promptMessages(value: unknown): PromptMessage[] {
  const list = object(value).messages;
  if (!Array.isArray(list) || !list.length || list.length > 20) throw new Error('JAR returned an unexpected rebuild prompt. Update JAR, then try again.');
  let size = 0;
  const messages = list.map(item => {
    const row = object(item);
    if ((row.role !== 'system' && row.role !== 'user' && row.role !== 'assistant') || typeof row.content !== 'string') throw new Error('JAR returned an unexpected rebuild prompt. Update JAR, then try again.');
    size += row.content.length;
    return { role: row.role, content: row.content } as PromptMessage;
  });
  if (size > MAX_PROMPT_CHARS) throw new Error('This captured lorebook is too large to rebuild in one request.');
  if (!messages.some(message => message.role === 'user' && message.content.trim())) throw new Error('JAR found no closed-lorebook text in its capture. Capture the closed lorebook again, then rebuild.');
  return messages;
}

/** The model's JSON, without code fences or chatter around it (as JAR reads it). */
function stripFences(text: string): string {
  let value = text.trim();
  const fence = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) value = fence[1].trim();
  const first = value.search(/[[{]/);
  const last = Math.max(value.lastIndexOf('}'), value.lastIndexOf(']'));
  if (first >= 0 && last > first) value = value.slice(first, last + 1);
  return value;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** One World Info entry, with the same fields JAR's rebuild writes. */
function buildEntry(raw: Record<string, unknown>, uid: number): Record<string, unknown> {
  const constant = raw.constant === true;
  const probability = raw.probability === undefined || !finite(raw.probability) ? 100 : raw.probability <= 1 ? raw.probability * 100 : raw.probability;
  return {
    uid, key: asArray(raw.key ?? raw.keys ?? raw.keywords), keysecondary: asArray(raw.keysecondary ?? raw.secondary_keys ?? raw.keySecondary),
    comment: String(raw.comment || raw.title || raw.name || raw.category || `Entry ${uid}`).trim().slice(0, 300),
    content: String(raw.content || raw.text || '').trim(), constant, selective: !constant,
    order: finite(raw.order) ? raw.order : finite(raw.priority) ? raw.priority : finite(raw.insertion_order) ? raw.insertion_order : 100,
    position: finite(raw.position) ? raw.position : 0, disable: raw.enabled === false, displayIndex: uid, addMemo: true,
    group: '', groupOverride: false, groupWeight: finite(raw.groupWeight) ? raw.groupWeight : 100, sticky: 0, cooldown: 0, delay: 0,
    probability, depth: 4, useProbability: true, role: null, vectorized: false, excludeRecursion: false, preventRecursion: false,
    delayUntilRecursion: false, scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '',
    selectiveLogic: finite(raw.selectiveLogic) ? raw.selectiveLogic : 0, ignoreBudget: false,
  };
}

/** Lorebook entries from the model's reply. */
export function parseRebuiltEntries(reply: string): Record<string, unknown>[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stripFences(reply)); }
  catch { throw new Error('Your Lumiverse AI did not return a usable lorebook. Try again, or switch to a model that follows instructions closely.'); }
  const root = object(parsed);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(root.entries) ? root.entries
    : root.entries && typeof root.entries === 'object' ? Object.values(root.entries) : Array.isArray(root.lorebook) ? root.lorebook : [];
  const entries: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (entries.length >= MAX_LOREBOOK_ENTRIES) break;
    const entry = buildEntry(object(row), entries.length);
    if (entry.content) entries.push(entry);
  }
  if (!entries.length) throw new Error('Your Lumiverse AI returned no lorebook entries. Try again, or switch to another model.');
  return entries;
}

/** The text of a generate.quiet() reply. */
export function replyText(value: unknown): { text: string; model: string } {
  const result = object(value);
  const text = typeof result.content === 'string' ? result.content : typeof value === 'string' ? value : '';
  if (!text.trim()) throw new Error('Your Lumiverse AI returned an empty reply. Check the connection you chat with, then try again.');
  return { text, model: typeof result.model === 'string' ? result.model.slice(0, 120) : '' };
}

/**
 * Lumiverse rebuilds, kept per JAR record: JAR has no way to store a rebuild made
 * elsewhere. A newer capture in JAR makes a saved rebuild out of date.
 */
export function createRebuildStore(api: Pick<SpindleAPI, 'storage'>) {
  const file = (recordId: string) => `${FILE_PREFIX}${recordId}.json`;
  return {
    async load(recordId: string): Promise<SavedRebuild | undefined> {
      if (!isRecordId(recordId)) return undefined;
      try {
        const stored = object(JSON.parse(await api.storage.read(file(recordId))));
        if (stored.schemaVersion !== 1 || stored.recordId !== recordId || typeof stored.rebuiltAt !== 'number' || typeof stored.capturedAt !== 'number') return undefined;
        const entries = worldInfoEntries({ entries: stored.entries });
        return entries.length ? { schemaVersion: 1, recordId, rebuiltAt: stored.rebuiltAt, capturedAt: stored.capturedAt, model: typeof stored.model === 'string' ? stored.model : '', entries } : undefined;
      } catch { return undefined; }
    },
    async save(rebuild: SavedRebuild) {
      if (!isRecordId(rebuild.recordId)) throw new Error('Preview the character from JAR again.');
      await api.storage.write(file(rebuild.recordId), JSON.stringify(rebuild));
    },
    async remove(recordId: string) { if (isRecordId(recordId)) try { await api.storage.delete(file(recordId)); } catch { /* already gone */ } },
  };
}

/** Show a saved Lumiverse rebuild in place of an older (or missing) JAR rebuild. */
export function withSavedRebuild(lorebooks: JarLorebooksResult, saved: SavedRebuild | undefined): JarLorebooksResult {
  if (!saved || !lorebooks.captured || saved.capturedAt < lorebooks.capturedAt || saved.rebuiltAt <= lorebooks.rebuiltAt) return lorebooks;
  const name = lorebooks.closedTitles.length === 1 ? lorebooks.closedTitles[0] : `${lorebooks.characterName.trim() || 'Character'} closed lorebook`;
  const book: JarLorebook = {
    key: `rebuilt:lumiverse:${saved.rebuiltAt}`, kind: 'rebuilt', title: `${name} (rebuilt)`,
    description: 'Rebuilt with your Lumiverse AI connection from JAR’s capture. Trigger keywords were inferred by the AI.',
    entries: saved.entries, model: saved.model ? `Lumiverse · ${saved.model}` : 'Lumiverse', rebuiltAt: saved.rebuiltAt,
  };
  return { ...lorebooks, rebuiltAt: saved.rebuiltAt, books: [...lorebooks.books.filter(item => item.kind !== 'rebuilt'), book] };
}
