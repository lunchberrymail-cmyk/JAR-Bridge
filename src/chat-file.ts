import type { NativeChatImport, NativeChatMessage } from './chat-import';
import { rawJarToJsonl, RawJarHistoryError } from './jar-raw-history';

export type PreparedChat = NativeChatImport;
export const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGES = 20_000;
const MAX_SWIPES = 1_000;
const JSONL_GUIDANCE = 'Choose JAR’s JSON (.json) or SillyTavern (.jsonl) conversation download.';

export class ChatFileError extends Error {
  constructor(message: string) { super(message); this.name = 'ChatFileError'; }
}
function fail(message: string): never { throw new ChatFileError(message); }
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function rowError(line: number, detail: string): never { return fail(`Conversation line ${line}: ${detail} Nothing has been imported.`); }

function date(value: unknown, line: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let seconds: number;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const numeric = Number(value);
    seconds = Math.floor(numeric >= 1_000_000_000_000 ? numeric / 1000 : numeric);
  } else if (typeof value === 'string') seconds = Math.floor(Date.parse(value) / 1000);
  else return rowError(line, 'a timestamp is invalid.');
  if (!Number.isSafeInteger(seconds) || seconds < 0) rowError(line, 'a timestamp is invalid.');
  return seconds;
}
function datesFrom(row: Record<string, unknown>, line: number): number | undefined {
  // Validate every known date, including fields that are not the selected source.
  const sent = date(row.send_date, line);
  const started = date(row.gen_started, line);
  const finished = date(row.gen_finished, line);
  return sent ?? started ?? finished;
}
function safeExtra(value: unknown, line: number): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  const source = object(value);
  if (!source) return rowError(line, 'message details must be an object.');
  const result: Record<string, unknown> = {};
  for (const key of ['api', 'model'] as const) {
    if (typeof source[key] === 'string') result[key] = source[key].slice(0, 200);
  }
  if (typeof source.reasoning === 'string' && source.reasoning) result.reasoning = source.reasoning;
  for (const [native, exported] of [['tokenCount', 'token_count'], ['reasoningDuration', 'reasoning_duration']] as const) {
    const value = source[native] ?? source[exported];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) result[native] = value;
  }
  // No arbitrary metadata, persona IDs, avatar paths, settings, or API credentials.
  return result;
}

function message(row: Record<string, unknown>, line: number): NativeChatMessage {
  if (typeof row.is_user !== 'boolean' || typeof row.name !== 'string' || !row.name.trim()) {
    return rowError(line, 'each message needs its original speaker name and user/bot role.');
  }
  if (row.is_system !== undefined && row.is_system !== false) return rowError(line, 'system-role messages are not supported by this JAR import.');
  if (row.mes !== undefined && typeof row.mes !== 'string') return rowError(line, 'message text must be a string.');
  if (row.content !== undefined && typeof row.content !== 'string') return rowError(line, 'message text must be a string.');
  if (typeof row.mes === 'string' && typeof row.content === 'string' && row.mes !== row.content) return rowError(line, 'the message has conflicting text fields.');
  const text = typeof row.mes === 'string' ? row.mes : typeof row.content === 'string' ? row.content : undefined;
  if (row.swipes !== undefined && (!Array.isArray(row.swipes) || !row.swipes.length || row.swipes.length > MAX_SWIPES || !row.swipes.every(value => typeof value === 'string'))) {
    return rowError(line, 'alternate replies must be a nonempty list of text values (up to 1000).');
  }
  const swipes = row.swipes ? [...row.swipes as string[]] : text !== undefined ? [text] : [];
  if (!swipes.length) return rowError(line, 'message text is missing.');
  const selected = row.swipe_id ?? 0;
  if (typeof selected !== 'number' || !Number.isSafeInteger(selected) || selected < 0 || selected >= swipes.length) return rowError(line, 'the selected alternate reply is invalid.');
  const content = swipes[selected];
  if (text !== undefined && text !== content) return rowError(line, 'the selected alternate does not match the visible message.');
  const sent = datesFrom(row, line);
  const extra = safeExtra(row.extra, line);
  let info: Record<string, unknown>[] | undefined;
  if (row.swipe_info !== undefined) {
    if (!Array.isArray(row.swipe_info) || row.swipe_info.length !== swipes.length || !row.swipe_info.every(value => !!object(value))) {
      return rowError(line, 'alternate reply details do not match the replies.');
    }
    info = row.swipe_info as Record<string, unknown>[];
  }
  let explicitDates: number[] | undefined;
  if (row.swipe_dates !== undefined) {
    if (!Array.isArray(row.swipe_dates) || row.swipe_dates.length !== swipes.length) return rowError(line, 'alternate reply dates do not match the replies.');
    explicitDates = row.swipe_dates.map(value => date(value, line) ?? rowError(line, 'an alternate reply date is missing.'));
  }
  const infoDates = info?.map(value => datesFrom(value, line));
  if (explicitDates && infoDates?.some((value, index) => value !== undefined && value !== explicitDates![index])) return rowError(line, 'alternate reply dates conflict.');
  const sendDate = sent ?? explicitDates?.[selected] ?? infoDates?.[selected];
  const swipeDates = explicitDates ?? swipes.map((_, index) => infoDates?.[index] ?? sendDate);
  if (swipeDates.some(value => value !== undefined) && swipeDates.some(value => value === undefined)) return rowError(line, 'some alternate reply dates are missing.');
  if (info) {
    const perSwipe = info.map((value, index) => ({ ...(index === selected ? extra : {}), ...safeExtra(value.extra, line) }));
    Object.assign(extra, perSwipe[selected]);
    for (const [field, bySwipe] of [['reasoning', 'reasoningBySwipe'], ['reasoningDuration', 'reasoningDurationBySwipe'], ['tokenCount', 'tokenCountBySwipe']] as const) {
      const values = perSwipe.map(value => value[field] ?? null);
      if (values.some(value => value !== null)) extra[bySwipe] = values;
    }
  }
  return {
    is_user: row.is_user, name: row.name, content, swipes, swipe_id: selected,
    ...(sendDate !== undefined ? { send_date: sendDate } : {}),
    ...(swipeDates.every(value => value !== undefined) ? { swipe_dates: swipeDates as number[] } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

function sourceMetadata(header: Record<string, unknown>): Record<string, unknown> | undefined {
  const source = object(header.chat_metadata);
  if (!source) return undefined;
  const metadata: Record<string, unknown> = {};
  if (source.imported_from === 'janitorai') metadata.imported_from = 'janitorai';
  const chatId = source.janitor_chat_id;
  if ((typeof chatId === 'number' && Number.isSafeInteger(chatId) && chatId > 0) || (typeof chatId === 'string' && /^[1-9]\d{0,31}$/.test(chatId))) metadata.janitor_chat_id = chatId;
  const characterId = source.janitor_character_id;
  if (typeof characterId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(characterId)) metadata.janitor_character_id = characterId;
  return Object.keys(metadata).length ? metadata : undefined;
}

/** Strictly projects a complete JAR JSON or JSONL conversation; never sends or evaluates it. */
export function parseChatHistory(jsonl: string, fileName = 'Imported JAR chat.jsonl'): PreparedChat {
  if (typeof jsonl !== 'string' || !jsonl.trim()) fail(`Choose a nonempty conversation export. ${JSONL_GUIDANCE}`);
  if (jsonl.length > MAX_CHAT_FILE_BYTES || new TextEncoder().encode(jsonl).byteLength > MAX_CHAT_FILE_BYTES) fail('This conversation is larger than the 10 MiB import limit.');
  const raw = jsonl.replace(/^\uFEFF/, '');
  try {
    const single = object(JSON.parse(raw));
    if (single && ('chatMessages' in single || ('chat' in single && 'character' in single))) return parseJsonlHistory(rawJarToJsonl(single), fileName);
    if (single && object(single.raw)) fail(`Choose the JSON conversation file downloaded by JAR, rather than an API response. ${JSONL_GUIDANCE}`);
  } catch (error) {
    if (error instanceof ChatFileError) throw error;
    if (error instanceof RawJarHistoryError) fail(error.message);
  }
  return parseJsonlHistory(raw, fileName);
}

// The 10 MiB limit applies to the selected file; the canonical swipe projection
// can repeat the selected text without making a valid raw download oversized.
function parseJsonlHistory(raw: string, fileName: string): PreparedChat {
  const lines = raw.split(/\r?\n/).map((text, index) => ({ text, line: index + 1 })).filter(value => value.text.trim());
  let header: Record<string, unknown> | undefined;
  const messages: NativeChatMessage[] = [];
  for (const [index, entry] of lines.entries()) {
    let parsed: unknown;
    try { parsed = JSON.parse(entry.text); }
    catch { return rowError(entry.line, `invalid JSON. ${JSONL_GUIDANCE}`); }
    const row = object(parsed);
    if (!row) return rowError(entry.line, 'a JSON object is required.');
    const isHeader = row.chat_metadata !== undefined || row.user_name !== undefined || (row.create_date !== undefined && row.is_user === undefined);
    if (isHeader) {
      if (index !== 0 || row.is_user !== undefined || row.mes !== undefined || row.content !== undefined) return rowError(entry.line, 'conversation metadata must appear only before the messages.');
      if (row.chat_metadata !== undefined && !object(row.chat_metadata)) return rowError(entry.line, 'conversation metadata is invalid.');
      header = row; continue;
    }
    if (messages.length >= MAX_MESSAGES) fail('This conversation has more than 20000 messages. Choose a smaller export.');
    messages.push(message(row, entry.line));
  }
  if (!messages.length || !messages.some(value => value.content.length)) fail('This conversation has no message text to import.');
  const headerDate = header ? date(header.create_date, lines[0].line) : undefined;
  const dates = messages.flatMap(value => [...(value.send_date !== undefined ? [value.send_date] : []), ...(value.swipe_dates ?? [])]);
  const createdAt = headerDate ?? (dates.length ? dates.reduce((earliest, value) => Math.min(earliest, value)) : undefined);
  const metadata = header ? sourceMetadata(header) : undefined;
  const headerName = typeof header?.name === 'string' && header.name.trim() ? header.name : header ? object(header.chat_metadata)?.name : undefined;
  const fallbackName = fileName.replace(/\.(?:jsonl|json)$/i, '').trim() || 'Imported JAR chat';
  return {
    name: typeof headerName === 'string' && headerName.trim() ? headerName : fallbackName,
    ...(createdAt !== undefined ? { created_at: createdAt } : {}),
    ...(metadata ? { metadata } : {}), messages,
  };
}

export async function parseChatFile(file: File): Promise<PreparedChat> {
  if (!file || !file.size) fail(`Choose a nonempty conversation export. ${JSONL_GUIDANCE}`);
  if (file.size > MAX_CHAT_FILE_BYTES) fail('This conversation is larger than the 10 MiB import limit.');
  if (!/\.(?:jsonl|json)$/i.test(file.name)) fail(JSONL_GUIDANCE);
  return parseChatHistory(await file.text(), file.name);
}
