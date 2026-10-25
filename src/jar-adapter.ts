import type { JarConversationsResult, JarHistoryResult } from './conversation-adapter';

/** Only the exportable character is allowed across the backend/frontend boundary. */
export interface CardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    creator_notes: string;
    system_prompt: string;
    post_history_instructions: string;
    alternate_greetings: string[];
    tags: string[];
    creator: string;
    character_version: string;
    extensions: Record<string, unknown>;
    character_book?: Record<string, unknown>;
  };
}

export interface JarSummary { id: string; name: string; source: string; ts: number }
export interface JarCardResult {
  recordId: string;
  name: string;
  card: CardV2;
  avatarDataUrl?: string;
  warnings?: string[];
}
export interface JarLinkResult {
  kind: 'character' | 'chat';
  sourceUrl: string;
  recordId: string;
  characterUrl?: string;
  card?: JarCardResult;
  history?: JarHistoryResult;
  warning?: string;
}
export type JarCommand = 'connect' | 'list' | 'card' | 'conversations' | 'history' | 'preview-link' | 'cancel';
export interface JarRequest {
  type: 'jar_bridge:request'; id: string; command: JarCommand;
  baseUrl?: string; recordId?: string; chatId?: string; sourceUrl?: string;
}
export interface JarResponse {
  type: 'jar_bridge:response'; id: string; command: Exclude<JarCommand, 'cancel'>;
  result?: { version: string; captures: JarSummary[] } | { captures: JarSummary[] } | JarCardResult | JarConversationsResult | JarHistoryResult | JarLinkResult;
  error?: string;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function field(source: Record<string, unknown>, canonical: string, alias?: string): string {
  const value = source[canonical] === undefined && alias ? source[alias] : source[canonical];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('JAR returned an invalid character field. Finish card in JAR, then try again.');
  return value;
}
function strings(source: Record<string, unknown>, canonical: string, alias?: string): string[] {
  const value = source[canonical] === undefined && alias ? source[alias] : source[canonical];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error('JAR returned invalid greetings or tags. Finish card in JAR, then try again.');
  }
  return [...value];
}

// Preserve card extensions while excluding capture/session data even if a future
// JAR version nests that metadata inside a card extension.
const privateKeys = /^(?:payload|rawpayload|capturepayload|probepayload|rawprompt|systemcontent|messages|conversations?|settings|sessions?|sessionid|sessiontokens?|tokens?|accesstoken|refreshtoken|apikey|authorization|cookies?|password|credentials|clientsecret|secret|bearertoken|proto|prototype|constructor)$/;
function cardMetadata(value: unknown, depth = 0): unknown {
  if (depth > 24) throw new Error('JAR character metadata is too deeply nested. Finish card in JAR, then try again.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(item => cardMetadata(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object(value))) {
    if (!privateKeys.test(key.replace(/[_\s-]/g, '').toLowerCase()) && item !== undefined) result[key] = cardMetadata(item, depth + 1);
  }
  return result;
}

export function normalizeSummaries(value: unknown): JarSummary[] {
  if (!Array.isArray(value)) throw new Error('JAR returned an unexpected character list.');
  return value.map(item => {
    const row = object(item);
    const id = string(row.id);
    if (!isRecordId(id)) throw new Error('JAR returned an invalid character ID.');
    const stamps = [row.ts, row.refreshedAt, row.capturedAt].filter((stamp): stamp is number => typeof stamp === 'number' && Number.isFinite(stamp) && stamp >= 0);
    return { id, name: string(row.characterName) || string(row.name) || 'Unnamed character', source: string(row.source), ts: stamps.length ? Math.max(...stamps) : 0 };
  });
}

/** JAR's opaque local IDs are route segments, never routes or filesystem paths. */
export function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
}

/** Match JAR's CCv2 export mapping; do not reconstruct cards from captured prompts. */
export function toCardV2(recordValue: unknown, separationValue?: unknown): JarCardResult & { id: string } {
  const record = object(recordValue);
  const id = record.id;
  if (!isRecordId(id)) throw new Error('JAR returned an invalid character ID.');
  const computed = object(object(separationValue).character);
  const stored = object(record.character);
  const character = Object.keys(computed).length ? computed : stored;
  const source = character.spec === 'chara_card_v2' ? object(character.data) : character;
  if (character.definitionSource === 'pending' || source.definitionSource === 'pending') throw new Error('Finish card in JAR, then try again. This character does not have a saved definition yet.');
  const data: CardV2['data'] = {
    name: field(source, 'name') || string(record.characterName),
    description: field(source, 'description'), personality: field(source, 'personality'), scenario: field(source, 'scenario'),
    first_mes: field(source, 'first_mes', 'firstMessage'), mes_example: field(source, 'mes_example', 'exampleMessages'),
    creator_notes: field(source, 'creator_notes', 'creatorNotes'), system_prompt: field(source, 'system_prompt', 'systemPrompt'),
    post_history_instructions: field(source, 'post_history_instructions', 'postHistoryInstructions'),
    alternate_greetings: strings(source, 'alternate_greetings', 'alternateGreetings'), tags: strings(source, 'tags'),
    creator: field(source, 'creator'), character_version: field(source, 'character_version', 'characterVersion'),
    extensions: cardMetadata(object(source.extensions)) as Record<string, unknown>,
  };
  // JAR keeps JAI's optional public music attachment outside its CCv2 card.
  // Copy just the validated track ID, never the surrounding capture metadata.
  const rawTrackId = object(record.meta).soundcloud_track_id;
  const trackId = typeof rawTrackId === 'number' && Number.isSafeInteger(rawTrackId) ? String(rawTrackId) : rawTrackId;
  if (typeof trackId === 'string' && /^[1-9]\d{0,19}$/.test(trackId)) {
    data.extensions.jar_bridge = { ...object(data.extensions.jar_bridge), soundcloud_track_id: trackId };
  }
  if (!data.name.trim() || ![data.description, data.personality, data.scenario, data.first_mes, data.mes_example, data.system_prompt, data.post_history_instructions].some(value => value.trim())) {
    throw new Error('Finish card in JAR, then try again. This character does not have a saved definition yet.');
  }
  if (source.character_book && typeof source.character_book === 'object' && !Array.isArray(source.character_book)) {
    data.character_book = cardMetadata(source.character_book) as Record<string, unknown>;
  }
  const avatar = string(character.avatarBase64) || string(source.avatarBase64) || string(record.avatarBase64) || string(stored.avatarBase64);
  const result: JarCardResult & { id: string } = { id, recordId: id, name: data.name, card: { spec: 'chara_card_v2', spec_version: '2.0', data } };
  if (avatar.startsWith('data:image/')) result.avatarDataUrl = avatar;
  else if (avatar) result.warnings = ['The saved avatar is unavailable. The character card can still be imported.'];
  return result;
}
