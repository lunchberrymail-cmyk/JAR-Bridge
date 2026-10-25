import { isRecordId, object } from './jar-adapter';

export interface JarConversationSummary {
  chatId: string; title: string; messageCount: number; updatedAt?: string; createdAt?: string;
}
export interface JarConversationsResult { recordId: string; characterName: string; conversations: JarConversationSummary[] }
export interface JarHistoryResult { recordId: string; chatId: string; characterName: string; userName: string; messageCount: number; jsonl: string }

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function isChatId(value: unknown): value is string { return typeof value === 'string' && /^[0-9]{1,32}$/.test(value); }
function sourceId(value: unknown): string { return typeof value === 'string' || typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : ''; }
function date(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? value : undefined;
}
function characterName(record: Record<string, unknown>): string {
  return text(object(record.character).name) || text(record.characterName) || 'Character';
}

/** Saved links only. This does not discover or fetch remote conversations. */
export function toConversations(recordValue: unknown): JarConversationsResult {
  const record = object(recordValue);
  if (!isRecordId(record.id)) throw new Error('JAR returned an invalid character ID.');
  const seen = new Set<string>();
  const conversations: JarConversationSummary[] = [];
  for (const value of Array.isArray(record.conversations) ? record.conversations : []) {
    const row = object(value); const chatId = row.chatId;
    if (!isChatId(chatId) || seen.has(chatId)) continue;
    seen.add(chatId);
    const updatedAt = date(row.updatedAt), createdAt = date(row.createdAt);
    conversations.push({ chatId, title: text(row.label) || text(row.title) || `Chat ${chatId}`,
      messageCount: typeof row.messageCount === 'number' && Number.isSafeInteger(row.messageCount) && row.messageCount >= 0 ? row.messageCount : 0,
      ...(updatedAt ? { updatedAt } : {}), ...(createdAt ? { createdAt } : {}) });
  }
  return { recordId: record.id, characterName: characterName(record), conversations };
}

/** Never pass a frontend-provided chat ID to JAR unless it is saved on this record. */
export function assertLinkedConversation(recordValue: unknown, chatId: unknown): { recordId: string; characterId: string; chatId: string } {
  const record = object(recordValue);
  if (!isRecordId(record.id) || !isChatId(chatId)) throw new Error('Choose a conversation linked to this JAR character.');
  const characterId = sourceId(record.characterId);
  if (!characterId || !toConversations(record).conversations.some(item => item.chatId === chatId)) throw new Error('This conversation is not linked to the selected character. Find or link it in JAR, then refresh linked chats.');
  return { recordId: record.id, characterId, chatId };
}

const dateKeys = ['send_date', 'gen_started', 'gen_finished'] as const;
function dates(source: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of dateKeys) {
    if (source[key] === undefined || source[key] === null || source[key] === '') continue;
    const value = date(source[key]);
    if (!value) throw new Error('JAR returned an invalid message date. Export the conversation from JAR instead.');
    result[key] = value;
  }
  return result;
}
function extra(value: unknown): Record<string, unknown> {
  const source = object(value), result: Record<string, unknown> = {};
  for (const key of ['api', 'model', 'reasoning', 'reasoning_signature', 'reasoning_type']) {
    if (typeof source[key] === 'string' || source[key] === null) result[key] = source[key];
  }
  for (const key of ['token_count', 'reasoning_duration', 'time_to_first_token']) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key])) result[key] = source[key];
  }
  return result;
}
function message(value: unknown): Record<string, unknown> {
  const row = object(value);
  if (typeof row.mes !== 'string' || typeof row.is_user !== 'boolean' || typeof row.name !== 'string' || row.is_system !== undefined && typeof row.is_system !== 'boolean') {
    throw new Error('JAR returned an invalid message. Export the conversation from JAR instead.');
  }
  const result: Record<string, unknown> = { name: row.name, is_user: row.is_user, is_system: row.is_system === true, mes: row.mes, ...dates(row) };
  const metadata = extra(row.extra); if (Object.keys(metadata).length) result.extra = metadata;
  if (row.swipes !== undefined) {
    if (!Array.isArray(row.swipes) || !row.swipes.length || !row.swipes.every(item => typeof item === 'string')) throw new Error('JAR returned invalid message alternatives. Export the conversation from JAR instead.');
    result.swipes = [...row.swipes];
    if (row.swipe_id !== undefined) {
      if (typeof row.swipe_id !== 'number' || !Number.isSafeInteger(row.swipe_id) || row.swipe_id < 0 || row.swipe_id >= row.swipes.length) throw new Error('JAR returned an invalid selected alternative. Export the conversation from JAR instead.');
      result.swipe_id = row.swipe_id;
    }
    if (row.swipe_info !== undefined) {
      if (!Array.isArray(row.swipe_info) || row.swipe_info.length !== row.swipes.length || row.swipe_info.some(value => value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error('JAR returned incomplete alternative dates. Export the conversation from JAR instead.');
      result.swipe_info = row.swipe_info.map(value => { const info = object(value); const item: Record<string, unknown> = dates(info); const metadata = extra(info.extra); if (Object.keys(metadata).length) item.extra = metadata; return item; });
    }
  }
  return result;
}

/** Strip raw archives and arbitrary message metadata before crossing to the UI. */
export function toHistory(recordValue: unknown, chatId: string, exportValue: unknown): JarHistoryResult {
  const linkage = assertLinkedConversation(recordValue, chatId);
  const result = object(exportValue), raw = object(result.raw), rawChat = object(raw.chat), rawCharacter = object(raw.character);
  const rawChatId = sourceId(rawChat.id ?? rawChat.chat_id);
  const rawCharacterId = sourceId(rawCharacter.id ?? rawChat.character_id);
  const conflicting = [rawChat.id, rawChat.chat_id].some(value => value !== undefined && value !== null && sourceId(value) !== chatId)
    || [rawCharacter.id, rawChat.character_id].some(value => value !== undefined && value !== null && sourceId(value) !== linkage.characterId);
  if (result.chatId !== chatId || rawChatId !== chatId || rawCharacterId !== linkage.characterId || conflicting) throw new Error('JAR returned a conversation for a different character or chat. Nothing was imported.');
  if (typeof result.jsonl !== 'string' || !result.jsonl.trim()) throw new Error('This conversation has no exported messages.');
  let rows: unknown[];
  try { rows = result.jsonl.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch { throw new Error('JAR returned unreadable conversation data. Export the conversation from JAR instead.'); }
  const header = object(rows[0]), metadata = object(header.chat_metadata);
  if (!Object.keys(metadata).length || sourceId(metadata.janitor_chat_id) !== chatId || sourceId(metadata.janitor_character_id) !== linkage.characterId) throw new Error('The exported conversation does not match the selected JAR character and chat.');
  const messages = rows.slice(1).map(message);
  if (!messages.length) throw new Error('This conversation has no exported messages.');
  const safeHeader: Record<string, unknown> = { chat_metadata: { imported_from: 'janitorai', janitor_chat_id: chatId, janitor_character_id: linkage.characterId } };
  if (typeof header.name === 'string' && header.name.trim()) safeHeader.name = header.name;
  else if (typeof metadata.name === 'string' && metadata.name.trim()) safeHeader.name = metadata.name;
  if (header.create_date !== undefined) {
    const createdAt = date(header.create_date);
    if (!createdAt) throw new Error('JAR returned an invalid conversation date. Export the conversation from JAR instead.');
    safeHeader.create_date = createdAt;
  } else {
    // Current JAR JSONL omits chat creation time although the source archive can
    // contain it. Retain an explicit date string; do not guess numeric units.
    const createdAt = date(rawChat.created_at) ?? date(rawChat.createdAt);
    if (createdAt) safeHeader.create_date = createdAt;
  }
  return { recordId: linkage.recordId, chatId, characterName: text(result.characterName) || characterName(object(recordValue)), userName: text(result.userName) || 'User', messageCount: messages.length,
    jsonl: [safeHeader, ...messages].map(row => JSON.stringify(row)).join('\n') };
}
