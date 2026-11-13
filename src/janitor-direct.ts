import type { SpindleAPI } from 'lumiverse-spindle-types';
import { cardMetadata, distinctGreetings, object, type CardV2, type DirectStatus, type JarCardResult } from './jar-adapter';
import { parseJanitorLink } from './janitor-link';

/**
 * Experimental: read a character straight from JanitorAI's API with the user's
 * own login, without JAR. Read-only: nothing here sends messages or changes the
 * JanitorAI account. Only the short-lived access token is kept, encrypted in
 * Lumiverse's per-user enclave; it is never returned to the browser.
 */

const ORIGIN = 'https://janitorai.com';
const AVATAR_ORIGIN = 'https://ella.janitorai.com/bot-avatars/';
const TOKEN_KEY = 'janitorai_access_token';
const MAX_INPUT = 65_536;

function base64Url(value: string): string | undefined {
  try { return atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')); } catch { return undefined; }
}
function isJwt(value: unknown): value is string { return typeof value === 'string' && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.length < 8192; }
/** Expiry (Unix seconds) from the token's own payload; the signature is JanitorAI's to check. */
export function tokenExpiry(token: string): number | undefined {
  const payload = object(safeJson(base64Url(token.split('.')[1] ?? '')));
  return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
}
function safeJson(value: string | undefined): unknown { try { return value === undefined ? undefined : JSON.parse(value); } catch { return undefined; } }

/**
 * `name=value; name=value` as copied by the bookmarklet (or from a Cookie header):
 * the session cookie's chunks (`sb-…-auth-token`, `.0`, `.1`, …) joined in order.
 * Sign-in leftovers such as `…-auth-token-code-verifier` are not session chunks.
 */
function joinCookieChunks(text: string): string | undefined {
  const chunks = new Map<string, Map<number, string>>();
  for (const pair of text.split(/;\s*/)) {
    const match = /^(sb-[^=;\s]*-auth-token)(?:\.(\d{1,3}))?=(.*)$/.exec(pair.trim());
    if (!match) continue;
    const parts = chunks.get(match[1]) ?? new Map<number, string>();
    parts.set(match[2] === undefined ? 0 : Number(match[2]), match[3]);
    chunks.set(match[1], parts);
  }
  for (const parts of chunks.values()) return [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value).join('');
  return undefined;
}

/** The raw-token and decoded-session forms, returning undefined instead of throwing. */
function fromRaw(input: string): string | undefined {
  let raw = input.replace(/^bearer\s+/i, '');
  try { raw = decodeURIComponent(raw); } catch { /* keep as pasted */ }
  if (isJwt(raw)) return raw;
  for (const text of [raw.startsWith('base64-') ? base64Url(raw.slice(7)) : undefined, raw]) {
    const session = object(safeJson(text));
    const token = session.access_token ?? object(session.currentSession).access_token;
    if (isJwt(token)) return token;
  }
  return undefined;
}

/**
 * Accept what a user can copy from the browser:
 *  - a "Copy as cURL" command or request headers — the request's own Bearer token
 *    is the access token, with its Cookie header as a fallback;
 *  - the access token itself, or the whole `sb-…-auth-token` cookie value(s).
 * Only the access token is kept; any refresh token is discarded.
 */
export function accessTokenFrom(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_INPUT) throw new Error('Paste your JanitorAI login — the “Copy as cURL” from your browser, or the access token.');
  const text = input.trim();
  // The API request's own bearer token is the access token: the most reliable source.
  const bearer = /authorization:\s*bearer\s+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i.exec(text);
  if (bearer && isJwt(bearer[1])) return bearer[1];
  // Otherwise its Cookie header, a pasted cookie list, or a raw token/session.
  const cookieHeader = /(['"])cookie:\s*([^'"]*)\1/i.exec(text);
  for (const candidate of [cookieHeader ? joinCookieChunks(cookieHeader[2]) : undefined, joinCookieChunks(text), text]) {
    const token = candidate ? fromRaw(candidate) : undefined;
    if (token) return token;
  }
  throw new Error('That does not look like a JanitorAI login. In your browser’s Network tab, right-click a janitorai.com request, choose Copy as cURL, and paste it here.');
}

function apiError(status: number, body: string, contentType: string): Error {
  if (status === 401 || status === 403) return new Error('JanitorAI did not accept this login. It may have expired: paste a fresh one.');
  if (/text\/html/i.test(contentType) && /challenge-platform|cf-chl|Just a moment/i.test(body)) return new Error('JanitorAI’s protection blocked a request from this server. Use JAR for now.');
  if (status === 404) return new Error('JanitorAI could not find this character.');
  if (status === 429) return new Error('JanitorAI is limiting requests. Wait a moment, then try again.');
  return new Error(`JanitorAI returned an error (HTTP ${status}).`);
}

export function createJanitorDirect(api: Pick<SpindleAPI, 'cors' | 'enclave'>) {
  async function request(token: string, path: string): Promise<Record<string, unknown>> {
    const response = object(await api.cors(`${ORIGIN}${path}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, responseType: 'text' }));
    const status = typeof response.status === 'number' ? response.status : 0;
    const body = typeof response.body === 'string' ? response.body : '';
    const contentType = String(object(response.headers)['content-type'] ?? '');
    if (status < 200 || status >= 300) throw apiError(status, body, contentType);
    const data = safeJson(body);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw apiError(status, body, contentType);
    return data as Record<string, unknown>;
  }
  async function token(userId: string): Promise<string> {
    const saved = await api.enclave.get(TOKEN_KEY, userId);
    if (!isJwt(saved)) throw new Error('Save your JanitorAI login first.');
    const exp = tokenExpiry(saved);
    if (exp !== undefined && exp * 1000 <= Date.now()) throw new Error('Your saved JanitorAI login has expired. Paste a fresh one.');
    return saved;
  }
  /** A display name only; never the account email or IDs. */
  async function account(value: string): Promise<string> {
    const profile = await request(value, '/hampter/profiles/mine');
    const name = [profile.name, profile.username, profile.display_name, object(profile.profile).name].find(item => typeof item === 'string' && item.trim());
    return typeof name === 'string' ? name.trim().slice(0, 80) : 'your JanitorAI account';
  }
  async function avatar(file: unknown): Promise<string | undefined> {
    if (typeof file !== 'string' || !/^[A-Za-z0-9_.-]{1,200}$/.test(file)) return undefined;
    try {
      const response = object(await api.cors(`${AVATAR_ORIGIN}${encodeURIComponent(file)}?width=1200`, { method: 'GET', responseType: 'arraybuffer', mediaType: 'image' }));
      const type = String(object(response.headers)['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (response.status !== 200 || typeof response.body !== 'string' || !/^image\/(?:png|jpeg|webp)$/.test(type)) return undefined;
      return `data:${type};base64,${response.body}`;
    } catch { return undefined; }
  }

  return {
    /** Check a pasted login against JanitorAI before keeping it. */
    async save(input: unknown, userId: string): Promise<DirectStatus> {
      const value = accessTokenFrom(input);
      const exp = tokenExpiry(value);
      if (exp !== undefined && exp * 1000 <= Date.now()) throw new Error('This login has already expired. Paste a fresh one.');
      const name = await account(value);
      await api.enclave.put(TOKEN_KEY, value, userId);
      return { saved: true, account: name, ...(exp !== undefined ? { expiresAt: exp * 1000 } : {}) };
    },
    async status(userId: string): Promise<DirectStatus> {
      const saved = await api.enclave.get(TOKEN_KEY, userId);
      if (!isJwt(saved)) return { saved: false };
      const exp = tokenExpiry(saved);
      if (exp !== undefined && exp * 1000 <= Date.now()) return { saved: true, expired: true, expiresAt: exp * 1000 };
      return { saved: true, account: await account(saved), ...(exp !== undefined ? { expiresAt: exp * 1000 } : {}) };
    },
    async clear(userId: string): Promise<DirectStatus> { await api.enclave.delete(TOKEN_KEY, userId); return { saved: false }; },
    /** One character as a card, from the creator's public definition. */
    async preview(sourceUrl: unknown, userId: string): Promise<JarCardResult> {
      const link = parseJanitorLink(sourceUrl);
      if (link.kind !== 'character') throw new Error('Paste a character link to preview it with your JanitorAI login.');
      const meta = await request(await token(userId), `/hampter/characters/${link.characterId}`);
      if (String(meta.id ?? '').toLowerCase() !== link.characterId) throw new Error('JanitorAI returned a different character. Nothing was imported.');
      return toDirectCard(meta, link.characterId, await avatar(meta.avatar));
    },
  };
}

const text = (value: unknown) => typeof value === 'string' ? value : '';
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** JanitorAI fields to a CCv2 card. A hidden definition comes back empty and is refused. */
export function toDirectCard(meta: Record<string, unknown>, characterId: string, avatarDataUrl?: string): JarCardResult {
  const name = text(meta.name).trim() || text(meta.chat_name).trim();
  const greetings: string[] = [];
  for (const greeting of [...strings(meta.first_messages), text(meta.first_message)]) if (greeting.trim() && !greetings.includes(greeting)) greetings.push(greeting);
  const description = text(meta.personality).trim(), scenario = text(meta.scenario).trim(), examples = text(meta.example_dialogs).trim();
  if (!name || !(description || scenario || greetings.length || examples)) {
    throw new Error(meta.showdefinition === false
      ? 'This character’s creator hides its definition. Use JAR to capture it.'
      : 'JanitorAI returned no definition for this character with your login. Use JAR for this one.');
  }
  const first = greetings[0] ?? '';
  const data: CardV2['data'] = {
    name, description, personality: '', scenario, first_mes: first, mes_example: examples,
    creator_notes: text(meta.description), system_prompt: '', post_history_instructions: '',
    alternate_greetings: distinctGreetings(first, greetings.slice(1)),
    tags: strings(meta.custom_tags).slice(0, 100), creator: text(meta.creator_name).trim(), character_version: '',
    extensions: cardMetadata({ jar_bridge: { source: 'janitorai', direct: true, ...(text(meta.creator_name) ? { creator_name: text(meta.creator_name).trim() } : {}) } }) as Record<string, unknown>,
  };
  const sourceUrl = `${ORIGIN}/characters/${characterId}`;
  return { recordId: `jai-${characterId}`, name, card: { spec: 'chara_card_v2', spec_version: '2.0', data }, sourceUrl,
    ...(avatarDataUrl ? { avatarDataUrl } : { warnings: ['JanitorAI’s avatar could not be downloaded. The card can still be imported.'] }) };
}
