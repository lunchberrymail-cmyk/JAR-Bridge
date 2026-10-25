export type JanitorLink =
  | { kind: 'character'; sourceUrl: string; characterId: string; chatId?: never }
  | { kind: 'chat'; sourceUrl: string; chatId: string; characterId?: never };

const INVALID_LINK = 'Paste a full JanitorAI character or chat link from https://janitorai.com. Other websites and routes are not supported.';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SLUG = '[a-z0-9][a-z0-9_-]{0,199}';
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
  if (path.includes('%') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) throw new Error(INVALID_LINK);
  const character = CHARACTER_PATH.exec(path);
  if (character) {
    const characterId = character[1].toLowerCase();
    return { kind: 'character', characterId, sourceUrl: `https://janitorai.com/characters/${characterId}` };
  }
  const chat = CHAT_PATH.exec(path);
  if (chat) return { kind: 'chat', chatId: chat[1], sourceUrl: `https://janitorai.com/chats/${chat[1]}` };
  throw new Error(INVALID_LINK);
}
export type { JarLinkResult } from './jar-adapter';
