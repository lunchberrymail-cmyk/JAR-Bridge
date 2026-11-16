export type JanitorLink =
  | { kind: 'character'; sourceUrl: string; characterId: string; chatId?: never }
  | { kind: 'chat'; sourceUrl: string; chatId: string; characterId?: never };

const INVALID_LINK = 'Paste a full JanitorAI character or chat link from https://janitorai.com. Other websites and routes are not supported.';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// The name part after the ID is decorative and never sent anywhere: the link is
// rebuilt from the ID. JanitorAI keeps emojis and symbols in it, raw or
// percent-encoded (e.g. `_character-takoda-%E2%9C%A9-riv-ally`).
const SLUG = '[^/?#\\\\\\s]{1,600}';
const CHARACTER_PATH = new RegExp(`^/characters/(${UUID})(?:(?:-|_character-)${SLUG})?/?$`, 'i');
// JAR's chat-export tests document /chats/<id>/messages/<id> permalinks.
const CHAT_PATH = /^\/chats\/([1-9]\d{0,31})(?:\/messages\/[1-9]\d{0,31})?\/?$/;

/** Reduce an explicit JanitorAI link to its source identity, never an arbitrary URL. */
export function parseJanitorLink(value: unknown): JanitorLink {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f-\u009f\\]/.test(value)) throw new Error(INVALID_LINK);
  const input = value.trim();
  if (!input || /\s/.test(input)) throw new Error(INVALID_LINK);
  // Check the literal authority and path before any URL parser can normalize
  // credentials, default ports, dot segments, escapes, or backslashes for us.
  const authority = /^https:\/\/(?:www\.)?janitorai\.com(?=\/|[?#]|$)/i.exec(input);
  if (!authority) throw new Error(INVALID_LINK);
  const path = input.slice(authority[0].length).split(/[?#]/, 1)[0];
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) throw new Error(INVALID_LINK);
  const character = CHARACTER_PATH.exec(path);
  if (character && !/%(?:2f|5c)/i.test(path)) {
    const characterId = character[1].toLowerCase();
    return { kind: 'character', characterId, sourceUrl: `https://janitorai.com/characters/${characterId}` };
  }
  // Escapes are only tolerated in a character link's name part.
  if (path.includes('%')) throw new Error(INVALID_LINK);
  const chat = CHAT_PATH.exec(path);
  if (chat) return { kind: 'chat', chatId: chat[1], sourceUrl: `https://janitorai.com/chats/${chat[1]}` };
  throw new Error(INVALID_LINK);
}
/**
 * The character page as linked, keeping its readable name part, for display only.
 * Query strings and fragments are dropped; the host is always janitorai.com.
 */
export function characterPageUrl(value: unknown): string | undefined {
  let link: JanitorLink;
  try { link = parseJanitorLink(value); } catch { return undefined; }
  if (link.kind !== 'character') return undefined;
  const path = String(value).trim().replace(/^https:\/\/(?:www\.)?janitorai\.com/i, '').split(/[?#]/, 1)[0].replace(/\/$/, '');
  try { return new URL(`https://janitorai.com${path}`).href; } catch { return link.sourceUrl; }
}

/** Add "Original source: <link>" to creator notes once; a note already naming this character is left alone. */
export function withSourceNote(notes: string, pageUrl: string | undefined): string {
  if (!pageUrl) return notes;
  let id: string;
  try { const link = parseJanitorLink(pageUrl); if (link.kind !== 'character') return notes; id = link.characterId; } catch { return notes; }
  if (notes.toLowerCase().includes(id)) return notes;
  return `${notes.trimEnd()}${notes.trim() ? '\n\n' : ''}Original source: ${pageUrl}`;
}
export type { JarLinkResult } from './jar-adapter';
