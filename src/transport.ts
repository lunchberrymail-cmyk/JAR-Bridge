import type { SpindleAPI } from 'lumiverse-spindle-types';
import { isRecordId, object } from './jar-adapter';
import { isChatId } from './conversation-adapter';
import { parseJanitorLink } from './janitor-link';

export const DEFAULT_JAR_URL = 'http://127.0.0.1:4577';
export const MAX_JAR_RESPONSE_BYTES = 25 * 1024 * 1024;

/** Accept literal loopback addresses only; never resolve arbitrary hostnames. */
export function normalizeJarBase(value?: string): string {
  const input = value === undefined || value.trim() === '' ? DEFAULT_JAR_URL : value.trim();
  // Validate before URL parsing: WHATWG accepts alternate numeric loopback forms.
  const match = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?\/?$/i.exec(input);
  if (!match) throw new Error('Use a local JAR address, such as http://127.0.0.1:4577. Paths, sign-in details, and remote addresses are not supported.');
  const port = match[2] === undefined ? 4577 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('JAR needs a port between 1 and 65535.');
  const hostname = match[1].toLowerCase() === 'localhost' ? '127.0.0.1' : match[1].toLowerCase();
  return `http://${hostname}:${port}`;
}

export type JarRoute = { kind: 'version' } | { kind: 'captures' } | { kind: 'card'; recordId: string } | { kind: 'history'; chatId: string }
  | { kind: 'inspect'; sourceUrl: string } | { kind: 'link-chat'; sourceUrl: string };
export interface JarTransportOptions { current: () => boolean }

const JSON_CONTENT_TYPE = /\bapplication\/(?:[\w.-]+\+)?json\b/i;
const MAX_ERROR_BODY_BYTES = 8192;
const HISTORY_FILE_HELP = 'In JAR, export the conversation as JSON or SillyTavern JSONL. In Lumiverse, open Chat history → History file and choose the download.';

function contentType(response: Record<string, unknown>): unknown {
  return Object.entries(object(response.headers)).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
}

/** Classify only bounded JSON error replies; remote text never becomes UI text. */
function knownJarError(response: Record<string, unknown>, route: JarRoute): string | undefined {
  if (typeof response.status !== 'number' || !Number.isInteger(response.status) || response.status < 400 || response.status > 599
    || response.encoding || typeof response.body !== 'string' || response.body.length > MAX_ERROR_BODY_BYTES
    || new TextEncoder().encode(response.body).byteLength > MAX_ERROR_BODY_BYTES) return;
  const type = contentType(response);
  if (typeof type !== 'string' || !JSON_CONTENT_TYPE.test(type)) return;
  let raw: unknown;
  try { raw = JSON.parse(response.body); } catch { return; }
  const detail = object(raw).error;
  if (typeof detail !== 'string' || detail.length > 2048) return;
  if (/executable\s+(?:doesn.t|does not)\s+exist|playwright\s+install|browser\s+(?:executable\s+)?(?:not found|is missing)/i.test(detail)) {
    return 'JAR is running, but its Chromium browser is missing. In the extracted JAR folder, run npx.cmd playwright install chromium on Windows (npx playwright install chromium on macOS or Linux), restart JAR, then sign in using JAR’s Log in button.';
  }
  if (/\bnot\s+(?:logged|signed)\s+in(?:to)?\b|\b(?:log[ -]?in|sign[ -]?in)\s+(?:first|required)\b|\bsession\s+(?:expired|unauthenticated)\b|\bunauthorized\b|\bfetch\s+(?:chat|character)\s+failed:\s*HTTP\s+401\b/i.test(detail)) {
    return 'JAR is not signed into JanitorAI, or its session has expired. Open JAR on the Lumiverse server computer, use its Log in button, then retry this import.';
  }
  if (/\b(?:capture\s+)?browser\s+is\s+busy\b|\b(?:login|extraction|operation|request)\s+is\s+already\s+running\b/i.test(detail)) {
    return 'JAR’s browser is already handling another operation. Finish signing in or wait for its current operation to finish, then try again.';
  }
  if (/^this conversation has no messages[.!]?$/i.test(detail.trim())) {
    return `JAR found this conversation, but it has no messages to import. Choose another conversation or a saved JAR JSON or SillyTavern JSONL file. ${HISTORY_FILE_HELP}`;
  }
  if (/\b(?:forbidden|not\s+found|unavailable|no\s+longer\s+available)\b|\bfetch\s+(?:chat|character)\s+failed:\s*HTTP\s+(?:403|404|410)\b/i.test(detail)) {
    if (route.kind === 'history' || route.kind === 'link-chat') return `JAR cannot access this conversation. Check that JAR is signed into the JanitorAI account that owns it and that the chat link is still available. ${HISTORY_FILE_HELP}`;
    if (route.kind === 'inspect') return 'JAR cannot access this character. Check that its JanitorAI page is still available to JAR’s signed-in account, or import a downloaded card file.';
    return 'JAR cannot access the selected content. Check that it is still available in JAR, then refresh and try again.';
  }
}

function connectionError(error: unknown): string {
  const detail = (error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : '').slice(0, 2048);
  if (/response too large/i.test(detail)) return `This JAR response is too large for the connection. ${HISTORY_FILE_HELP}`;
  if (/timed?\s*out|timeout/i.test(detail)) return `JAR did not finish within Lumiverse’s connection time limit. Wait for JAR’s browser to finish, then try again. ${HISTORY_FILE_HELP}`;
  if (/\babort(?:ed|error)?\b/i.test(detail)) return `The connection to JAR was interrupted. Wait for JAR’s browser to finish, then retry. ${HISTORY_FILE_HELP}`;
  if (/ECONNREFUSED|FailedToOpenSocket|connection\s+(?:was\s+)?refused|unable to connect/i.test(detail)) {
    return 'JAR is not accepting connections at this local address. On the Lumiverse server computer, open start.bat in the extracted JAR folder (or run npm start), keep its console open, then check the connection again. Use the port printed in that console.';
  }
  return 'Could not reach JAR. On the Lumiverse server computer, start JAR from its extracted folder and keep its console open. Check the local address and port, then try again.';
}

/** Native cors follows redirects. This bridge trusts the user's local JAR service. */
export function createJarTransport(api: Pick<SpindleAPI, 'permissions' | 'cors'>, baseUrl: string, options: JarTransportOptions) {
  const base = normalizeJarBase(baseUrl);
  return async (route: JarRoute): Promise<unknown> => {
    if (!options.current()) throw new Error('Request cancelled.');
    const granted = await api.permissions.getGranted();
    if (!options.current()) throw new Error('Request cancelled.');
    if (!granted.includes('cors_proxy')) throw new Error('Allow Local JAR connection in this extension’s permissions, then try again.');
    let path: string; let body: string | undefined;
    if (route.kind === 'version') path = '/api/version';
    else if (route.kind === 'captures') path = '/api/captures';
    else if (route.kind === 'card' && isRecordId(route.recordId)) path = `/api/captures/${encodeURIComponent(route.recordId)}`;
    else if (route.kind === 'history' && isChatId(route.chatId)) { path = '/api/chat-export'; body = JSON.stringify({ chat: route.chatId }); }
    else if (route.kind === 'inspect' || route.kind === 'link-chat') {
      const link = parseJanitorLink(route.sourceUrl);
      if (route.kind === 'inspect' && link.kind === 'character') { path = '/api/inspect'; body = JSON.stringify({ url: link.sourceUrl }); }
      else if (route.kind === 'link-chat' && link.kind === 'chat') { path = '/api/chat-import'; body = JSON.stringify({ chat: link.sourceUrl }); }
      else throw new Error('Choose a JanitorAI character or chat link.');
    }
    else throw new Error('Invalid JAR character request.');
    let result: unknown;
    try { result = await api.cors(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}), responseType: 'text' }); }
    catch (error) { if (!options.current()) throw new Error('Request cancelled.'); throw new Error(connectionError(error)); }
    if (!options.current()) throw new Error('Request cancelled.');
    // Recheck after each asynchronous call as well: revoked access must not expose
    // an already in-flight archive response or start another request.
    const latestGranted = await api.permissions.getGranted();
    if (!options.current()) throw new Error('Request cancelled.');
    if (!latestGranted.includes('cors_proxy')) throw new Error('Local JAR connection permission was removed.');
    const response = object(result);
    if (response.status === 404 && route.kind === 'card') throw new Error('This character is no longer in JAR. Refresh the list.');
    if (typeof response.status !== 'number' || response.status < 200 || response.status > 299) throw new Error(knownJarError(response, route) || (route.kind === 'history'
      ? `JAR could not load this conversation through the connection. ${HISTORY_FILE_HELP}`
      : route.kind === 'inspect' || route.kind === 'link-chat'
        ? `JAR could not load this link. Check that JAR is running and its browser is signed into JanitorAI, then try again.${route.kind === 'link-chat' ? ` ${HISTORY_FILE_HELP}` : ''}`
        : 'JAR could not complete this request. Check JAR and try again.'));
    if (response.encoding || typeof response.body !== 'string') throw new Error('JAR returned an unexpected response.');
    const type = contentType(response);
    if (typeof type === 'string' && !JSON_CONTENT_TYPE.test(type)) throw new Error('This address did not return JAR data. Check the local JAR address.');
    if (response.body.length > MAX_JAR_RESPONSE_BYTES || new TextEncoder().encode(response.body).byteLength > MAX_JAR_RESPONSE_BYTES) throw new Error('This JAR response is too large. Export the card or conversation from JAR and import that file instead.');
    try { return JSON.parse(response.body); }
    catch { throw new Error('JAR returned unreadable data. Check JAR and try again.'); }
  };
}
