import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { uuid } from './uuid';
import { isRecordId, type JarLinkResult, type JarRequest, type JarResponse } from './jar-adapter';
import { parseJanitorLink, type JanitorLink } from './janitor-link';

type Command = Exclude<JarRequest['command'], 'cancel'>;
type Result = JarResponse['result'];
type Context = Pick<SpindleFrontendContext, 'sendToBackend' | 'onBackendMessage'>;
export type RequestExtras = Pick<JarRequest, 'force' | 'characterId' | 'worldBookId' | 'trigger'>;
type Pending = {
  id: string;
  command: Command;
  recordId?: string;
  chatId?: string;
  link?: JanitorLink;
  extras?: RequestExtras;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  ownerProofSent?: boolean;
};

/** Closing or replacing a request is an expected UI action. */
export class CancelledError extends Error {
  readonly name = 'AbortError';
  constructor() { super('JAR request cancelled.'); }
}

let clientSequence = 0;
const TIMEOUT_MS = 90_000;
const GENERIC_ERROR = 'JAR could not complete this request. Check JAR and try again.';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function errorMessage(value: string): string {
  return value.slice(0, 500).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim() || GENERIC_ERROR;
}

function isResult(value: unknown, pending: Pending): value is NonNullable<Result> {
  const result = object(value);
  if (!result) return false;
  if (pending.command === 'check') return typeof result.version === 'string' && !!result.version && result.version.length <= 120;
  if (pending.command === 'connect') return typeof result.version === 'string' && !!result.version && Array.isArray(result.captures);
  if (pending.command === 'list') return Array.isArray(result.captures);
  if (pending.command === 'conversations') return result.recordId === pending.recordId && typeof result.characterName === 'string' && Array.isArray(result.conversations);
  if (pending.command === 'history') return result.recordId === pending.recordId && result.chatId === pending.chatId && typeof result.jsonl === 'string' && typeof result.characterName === 'string' && typeof result.userName === 'string' && typeof result.messageCount === 'number';
  if (pending.command === 'preview-link') {
    const link = pending.link;
    if (!link || result.kind !== link.kind || result.sourceUrl !== link.sourceUrl || !isRecordId(result.recordId)) return false;
    if (result.warning !== undefined && (typeof result.warning !== 'string' || !result.warning.trim())) return false;
    if (result.characterUrl !== undefined) {
      try { const character = parseJanitorLink(result.characterUrl); if (character.kind !== 'character' || character.sourceUrl !== result.characterUrl || link.kind === 'character' && character.sourceUrl !== link.sourceUrl) return false; }
      catch { return false; }
    }
    if (result.card !== undefined && !isCardResult(result.card, result.recordId)) return false;
    if (result.hiddenCard !== undefined && (result.hiddenCard !== true || result.card !== undefined || link.kind !== 'character')) return false;
    if (link.kind === 'character') return result.history === undefined && (result.card !== undefined || typeof result.warning === 'string');
    const history = object(result.history);
    return !!history && history.recordId === result.recordId && history.chatId === link.chatId
      && typeof history.jsonl === 'string' && !!history.jsonl && typeof history.characterName === 'string' && typeof history.userName === 'string'
      && typeof history.messageCount === 'number' && Number.isSafeInteger(history.messageCount) && history.messageCount > 0;
  }
  if (pending.command === 'lorebooks') return isLorebooks(result, pending.recordId);
  if (pending.command === 'capture-lorebook' || pending.command === 'rebuild-lorebook') return (result.state === 'done' || result.state === 'running') && isLorebooks(result.lorebooks, pending.recordId);
  if (pending.command === 'attach-lorebook') return result.characterId === pending.extras?.characterId && Array.isArray(result.worldBookIds) && result.worldBookIds.includes(pending.extras?.worldBookId);
  if (pending.command !== 'card') return false;
  return isCardResult(result, pending.recordId);
}

function isLorebooks(value: unknown, recordId?: string): boolean {
  const result = object(value);
  return !!result && isRecordId(result.recordId) && result.recordId === recordId && typeof result.allowProxy === 'boolean' && typeof result.captured === 'boolean'
    && typeof result.capturedAt === 'number' && typeof result.rebuiltAt === 'number' && Array.isArray(result.closedTitles)
    && Array.isArray(result.books) && result.books.every(item => {
      const book = object(item);
      return !!book && typeof book.key === 'string' && (book.kind === 'public' || book.kind === 'rebuilt') && typeof book.title === 'string'
        && typeof book.description === 'string' && Array.isArray(book.entries) && book.entries.every(entry => typeof object(entry)?.content === 'string');
    });
}

function isCardResult(value: unknown, recordId?: string): boolean {
  const result = object(value);
  if (!result) return false;
  const card = object(result.card);
  return isRecordId(result.recordId) && (!recordId || result.recordId === recordId) &&
    typeof result.name === 'string' && card?.spec === 'chara_card_v2' && card.spec_version === '2.0' && !!object(card.data);
}

/** One request per frontend document, with no archive state retained after settlement. */
export function createJarClient(ctx: Context): {
  request(command: Command, baseUrl: string, recordId?: string, chatId?: string, link?: JanitorLink, extras?: RequestExtras): Promise<Result>;
  requestLink(baseUrl: string, sourceUrl: string): Promise<JarLinkResult>;
  cancel(): void;
  dispose(): void;
} {
  const nonce = uuid();
  const prefix = `jar-${++clientSequence}-${nonce}`;
  let sequence = 0;
  let active: Pending | undefined;
  let disposed = false;

  function detach(pending: Pending): boolean {
    if (active !== pending) return false;
    active = undefined;
    clearTimeout(pending.timer);
    return true;
  }

  function sendCancel(pending: Pending): void {
    try { ctx.sendToBackend({ type: 'jar_bridge:request', command: 'cancel', id: pending.id } satisfies JarRequest); }
    catch { /* Local cancellation still completes if the backend is unloading. */ }
  }

  function cancel(): void {
    const pending = active;
    if (!pending || !detach(pending)) return;
    pending.reject(new CancelledError());
    sendCancel(pending);
  }

  const unsubscribe = ctx.onBackendMessage(payload => {
    if (disposed || !active) return;
    const response = object(payload);
    const pending = active;
    if (response?.type === 'jar_bridge:owner-challenge') {
      if (response.id !== pending.id || response.command !== pending.command || pending.ownerProofSent
        || typeof response.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(response.nonce)) return;
      pending.ownerProofSent = true;
      try { ctx.sendToBackend({ type: 'jar_bridge:owner-proof', id: pending.id, command: pending.command, nonce: response.nonce }); }
      catch { if (detach(pending)) pending.reject(new Error('Could not confirm this personal extension installation. Reopen the importer and try again.')); }
      return;
    }
    if (!response || response.type !== 'jar_bridge:response' || response.id !== pending.id || response.command !== pending.command) return;
    if (typeof response.error === 'string') {
      if (detach(pending)) pending.reject(new Error(errorMessage(response.error)));
    } else if (isResult(response.result, pending)) {
      if (detach(pending)) pending.resolve(response.result);
    }
  });

  function request(command: Command, baseUrl: string, recordId?: string, chatId?: string, link?: JanitorLink, extras?: RequestExtras): Promise<Result> {
      if (disposed) return Promise.reject(new CancelledError());
      cancel();
      return new Promise<Result>((resolve, reject) => {
        const pending: Pending = {
          id: `${prefix}-${++sequence}`, command, recordId, chatId, link, extras, resolve, reject,
          timer: setTimeout(() => {
            if (!detach(pending)) return;
            reject(new Error('JAR Bridge did not reply. Reload the extension in Lumiverse, then check the JAR connection again.'));
            sendCancel(pending);
          }, TIMEOUT_MS),
        };
        active = pending;
        try {
          ctx.sendToBackend({ type: 'jar_bridge:request', id: pending.id, command, baseUrl, ...(recordId !== undefined ? { recordId } : {}), ...(chatId !== undefined ? { chatId } : {}), ...(link ? { sourceUrl: link.sourceUrl } : {}), ...(extras?.force === true ? { force: true } : {}), ...(extras?.characterId !== undefined ? { characterId: extras.characterId } : {}), ...(extras?.worldBookId !== undefined ? { worldBookId: extras.worldBookId } : {}), ...(extras?.trigger !== undefined ? { trigger: extras.trigger } : {}) } satisfies JarRequest);
        } catch {
          if (detach(pending)) reject(new Error('Could not send this request to the JAR bridge. Try again.'));
        }
      });
  }

  return {
    request,
    requestLink(baseUrl, sourceUrl) {
      if (disposed) return Promise.reject(new CancelledError());
      let link: JanitorLink;
      try { link = parseJanitorLink(sourceUrl); } catch (error) { return Promise.reject(error); }
      return request('preview-link', baseUrl, undefined, undefined, link) as Promise<JarLinkResult>;
    },
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      unsubscribe();
    },
  };
}
