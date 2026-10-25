const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 20_000;
const MAX_SWIPES = 1_000;

export class RawJarHistoryError extends Error {
  constructor(message: string) { super(message); this.name = 'RawJarHistoryError'; }
}
function fail(detail: string): never {
  throw new RawJarHistoryError(`This JAR JSON conversation ${detail} Nothing has been imported.`);
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function chatId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,31}$/.test(value)) return value;
  return undefined;
}
function name(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === 'string' && value.trim()) as string | undefined;
}
function timestamp(value: unknown, label: string): { value: number; iso: string } {
  // Raw JAR archives use ISO timestamps. Never replace missing dates with now.
  let parsed: number;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string') {
    const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:?\d{2})$/.exec(value);
    if (!parts) return fail(`has a missing or invalid ${label} timestamp.`);
    const [, year, month, day, hour, minute, second] = parts.map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return fail(`has an invalid ${label} timestamp.`);
    parsed = Date.parse(value);
  } else return fail(`has a missing or invalid ${label} timestamp.`);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isSafeInteger(Math.floor(parsed / 1000)) || parsed > 8_640_000_000_000_000) return fail(`has an invalid ${label} timestamp.`);
  return { value: parsed, iso: new Date(parsed).toISOString() };
}

type RawMessage = { isBot: boolean; text: string; isMain: boolean; time: number; date: string; index: number };

/** Projects JAR's raw download into message-only JSONL; no settings or raw metadata escape. */
export function rawJarToJsonl(value: unknown): string {
  const root = object(value);
  const chat = object(root?.chat);
  const character = object(root?.character);
  if (!root || !chat || !character || !Array.isArray(root.chatMessages) || object(root.raw)) return fail('must contain its chat, character and chatMessages from JAR’s JSON download.');
  const id = chatId(chat.id);
  const characterId = typeof character.id === 'string' && UUID.test(character.id) ? character.id.toLowerCase() : undefined;
  if (!id || !characterId) return fail('has an invalid chat or character ID.');
  if (chat.character_id !== undefined && (typeof chat.character_id !== 'string' || chat.character_id.toLowerCase() !== characterId)) return fail('has conflicting character IDs.');
  if (root.chatMessages.length > MAX_MESSAGES) return fail('has more than 20000 messages. Choose a smaller export.');
  const rows: RawMessage[] = root.chatMessages.map((value, index) => {
    const row = object(value);
    if (!row || typeof row.is_bot !== 'boolean' || typeof row.message !== 'string' || (row.is_main !== undefined && typeof row.is_main !== 'boolean')) return fail(`has an invalid message at position ${index + 1}; speaker flags must be booleans and text must be a string.`);
    if (row.chat_id !== undefined && chatId(row.chat_id) !== id) return fail(`has a message belonging to a different chat at position ${index + 1}.`);
    const date = timestamp(row.created_at, `message ${index + 1}`);
    return { isBot: row.is_bot, text: row.message, isMain: row.is_main === true, time: date.value, date: date.iso, index };
  });
  rows.sort((a, b) => a.time - b.time || a.index - b.index);

  const personas = Array.isArray(root.personas) ? root.personas.map(object).filter((value): value is Record<string, unknown> => !!value) : [];
  const persona = personas.find(value => value.is_default === true) ?? personas[0];
  const botName = name(character.name, character.chat_name, character.character_name) ?? 'Character';
  const userName = name(root.persona_name, persona?.name) ?? 'User';
  const header: Record<string, unknown> = {
    user_name: userName,
    character_name: botName,
    chat_metadata: { imported_from: 'janitorai', janitor_chat_id: chat.id, janitor_character_id: characterId },
  };
  const title = name(chat.name, chat.title, chat.chat_name, chat.name_for_display);
  if (title) header.name = title;
  if (chat.created_at !== undefined) header.create_date = timestamp(chat.created_at, 'chat creation').iso;
  const result: Record<string, unknown>[] = [header];
  let pending: RawMessage[] = [];
  const flush = () => {
    if (!pending.length) return;
    const selected = pending.find(value => value.isMain) ?? pending[pending.length - 1];
    const ordered = [selected, ...pending.filter(value => value !== selected)];
    result.push({ name: botName, is_user: false, mes: selected.text, send_date: selected.date,
      swipes: ordered.map(value => value.text), swipe_id: 0, swipe_dates: ordered.map(value => value.date) });
    pending = [];
  };
  for (const row of rows) {
    if (row.isBot) {
      if (pending.length >= MAX_SWIPES) return fail('has more than 1000 alternatives for one reply. Choose a smaller export.');
      pending.push(row);
    } else {
      flush();
      result.push({ name: userName, is_user: true, mes: row.text, send_date: row.date });
    }
  }
  flush();
  return result.map(value => JSON.stringify(value)).join('\n');
}
