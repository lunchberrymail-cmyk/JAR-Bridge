import type { SpindleAPI } from 'lumiverse-spindle-types';
import { isRecordId, normalizeSummaries, object, toCardV2, type JarCardResult, type JarLinkResult, type JarResponse } from './jar-adapter';
import { createJarTransport, normalizeJarBase, type JarRoute } from './transport';
import { assertLinkedConversation, isChatId, toConversations, toHistory } from './conversation-adapter';
import { parseJanitorLink } from './janitor-link';
import { createOwnerBinding, isPinnedOwner } from './owner-binding';

type Job = { id: string; cancelled: boolean; timer: ReturnType<typeof setTimeout> };
const requestChannel = 'jar_bridge:request';
const responseChannel = 'jar_bridge:response';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function characterUrl(record: Record<string, unknown>): string | undefined {
  return typeof record.characterId === 'string' && uuid.test(record.characterId)
    ? `https://janitorai.com/characters/${record.characterId.toLowerCase()}` : undefined;
}

function exportCard(record: unknown): JarCardResult {
  const card = toCardV2(record);
  return { recordId: card.recordId, name: card.name, card: card.card,
    ...(card.avatarDataUrl ? { avatarDataUrl: card.avatarDataUrl } : {}), ...(card.warnings ? { warnings: card.warnings } : {}) };
}

function availableCard(record: unknown): JarCardResult | undefined {
  try { return exportCard(record); } catch { return undefined; }
}

/** Session-targeted, permission-gated archive access and explicit selected-link previews. */
export function setupJarBackend(api: SpindleAPI): () => void {
  const jobs = new Map<string, Job>();
  const binding = createOwnerBinding(api);
  // Reuse only records already verified by this account and frontend document.
  // JAR's list omits source IDs; never scan unrelated records to find a match.
  const knownCards = new Map<string, string>();
  let disposed = false;
  const off = api.onFrontendMessage((payload, userId, frontendSessionId) => {
    // Older hosts cannot guarantee document-only delivery; fail closed there.
    if (disposed || !userId || !frontendSessionId || !(api.host.capabilities['frontend-session-routing-v1'] >= 1)) return;
    if (binding.accept(payload, userId, frontendSessionId)) return;
    const request = object(payload);
    if (request.type !== requestChannel) return;
    const id = request.id;
    if (typeof id !== 'string' || !id || id.length > 160) return;
    const owner = `${userId}\0${frontendSessionId}`;
    if (request.command === 'cancel') {
      const job = jobs.get(owner);
      if (job?.id === id) { job.cancelled = true; clearTimeout(job.timer); jobs.delete(owner); binding.cancel(userId, frontendSessionId, id); }
      return;
    }
    const command = request.command;
    if (command !== 'connect' && command !== 'list' && command !== 'card' && command !== 'conversations' && command !== 'history' && command !== 'preview-link') return;
    const prior = jobs.get(owner);
    if (prior) { prior.cancelled = true; clearTimeout(prior.timer); binding.cancel(userId, frontendSessionId, prior.id); }
    const reply = (data: Pick<JarResponse, 'result' | 'error'>) => {
      if (!disposed) api.sendToFrontend({ type: responseChannel, id, command, ...data } satisfies JarResponse, userId, { frontendSessionId });
    };
    const job: Job = { id, cancelled: false, timer: setTimeout(() => {
      if (!disposed && jobs.get(owner) === job) { job.cancelled = true; jobs.delete(owner); binding.cancel(userId, frontendSessionId, id); reply({ error: 'JAR took too long to respond. Check JAR, then try again.' }); }
    }, 90_000) };
    jobs.set(owner, job);
    const current = () => !disposed && !job.cancelled && jobs.get(owner) === job;
    void (async () => {
      try {
        if (!await binding.ensure({ userId, sessionId: frontendSessionId, id, command, current })) {
          if (current()) reply({ error: 'Install JAR Bridge for your personal Lumiverse account, then reopen the importer and retry. An existing account binding cannot be replaced.' });
          return;
        }
        if (!current()) return;
        if (request.baseUrl !== undefined && typeof request.baseUrl !== 'string') throw new Error('Enter a local JAR address.');
        const baseUrl = normalizeJarBase(request.baseUrl as string | undefined);
        const get = createJarTransport(api, baseUrl, { current });
        const ownedGet = async (route: JarRoute): Promise<unknown> => {
          if (!await isPinnedOwner(api, userId)) throw new Error('This JAR bridge is no longer linked to your Lumiverse account.');
          if (!current()) throw new Error('Request cancelled.');
          return get(route);
        };
        const rememberCard = (record: Record<string, unknown>, card: JarCardResult | undefined): void => {
          const url = characterUrl(record);
          if (card && url) knownCards.set(`${owner}\0${baseUrl}\0${url}`, card.recordId);
        };
        let result: NonNullable<JarResponse['result']>;
        if (command === 'preview-link') {
          // JAR accepts arbitrary HTTP URLs containing UUIDs. Validate and
          // canonicalize here before allowing it to navigate its signed-in browser.
          const link = parseJanitorLink(request.sourceUrl);
          let record: Record<string, unknown> | undefined;
          let card: JarCardResult | undefined;
          if (link.kind === 'character') {
            const cacheKey = `${owner}\0${baseUrl}\0${link.sourceUrl}`;
            const cachedId = knownCards.get(cacheKey);
            if (cachedId) {
              const candidate = object(await ownedGet({ kind: 'card', recordId: cachedId }));
              if (!current()) return;
              if (candidate.id === cachedId && characterUrl(candidate) === link.sourceUrl) {
                card = availableCard(candidate);
                if (card) record = candidate;
              }
              if (!record) knownCards.delete(cacheKey);
            }
            if (!record) {
              const inspected = object(await ownedGet({ kind: 'inspect', sourceUrl: link.sourceUrl }));
              if (!current()) return;
              if (!isRecordId(inspected.id)) throw new Error('JAR returned an invalid character record for this link.');
              record = object(await ownedGet({ kind: 'card', recordId: inspected.id }));
              if (!current()) return;
              if (record.id !== inspected.id || characterUrl(record) !== link.sourceUrl) throw new Error('JAR returned a different character for this link. Nothing was imported.');
              card = availableCard(record);
            }
            rememberCard(record, card);
            result = { kind: 'character', sourceUrl: link.sourceUrl, recordId: record.id as string, characterUrl: link.sourceUrl,
              ...(card ? { card } : { warning: 'A complete character definition is not available from this link. Download a PNG or JSON card and choose Import card file. No hidden-card extraction was attempted.' }) } satisfies JarLinkResult;
          } else {
            const linked = object(await ownedGet({ kind: 'link-chat', sourceUrl: link.sourceUrl }));
            if (!current()) return;
            if (!isRecordId(linked.id) || object(linked.conversation).chatId !== link.chatId) throw new Error('JAR returned a different conversation for this link. Nothing was imported.');
            record = object(await ownedGet({ kind: 'card', recordId: linked.id }));
            if (!current()) return;
            if (record.id !== linked.id) throw new Error('JAR returned a different character record for this link. Nothing was imported.');
            const linkage = assertLinkedConversation(record, link.chatId);
            const exported = await ownedGet({ kind: 'history', chatId: linkage.chatId });
            if (!current()) return;
            const history = toHistory(record, linkage.chatId, exported);
            card = availableCard(record);
            rememberCard(record, card);
            const url = characterUrl(record);
            result = { kind: 'chat', sourceUrl: link.sourceUrl, recordId: linked.id, history,
              ...(url ? { characterUrl: url } : {}), ...(card ? { card } : {
                warning: 'This conversation is ready to review, but its character definition is incomplete. Choose an existing Lumiverse character for the history, or import a downloaded card file first.' }) } satisfies JarLinkResult;
          }
        } else if (command === 'card' || command === 'conversations' || command === 'history') {
          if (!isRecordId(request.recordId)) throw new Error('Choose a character from the JAR list.');
          if (command === 'history' && !isChatId(request.chatId)) throw new Error('Choose a conversation linked to this JAR character.');
          const record = object(await get({ kind: 'card', recordId: request.recordId }));
          if (!current()) return;
          if (record.id !== request.recordId) throw new Error('JAR returned a different character. Refresh the list and try again.');
          if (command === 'conversations') result = toConversations(record);
          else if (command === 'history') {
            const linkage = assertLinkedConversation(record, request.chatId);
            if (!await isPinnedOwner(api, userId)) throw new Error('This JAR bridge is no longer linked to your Lumiverse account.');
            if (!current()) return;
            const exported = await get({ kind: 'history', chatId: linkage.chatId });
            if (!current()) return;
            result = toHistory(record, linkage.chatId, exported);
          } else {
            const card = exportCard(record);
            rememberCard(record, card);
            result = card;
          }
        } else {
          const version = command === 'connect' ? object(await get({ kind: 'version' })).version : undefined;
          if (!current()) return;
          if (command === 'connect' && (typeof version !== 'string' || !version || version.length > 120)) throw new Error('This address did not return a JAR version. Check the local JAR address.');
          const captures = normalizeSummaries(await get({ kind: 'captures' }));
          result = command === 'connect' ? { version: version as string, captures } : { captures };
        }
        if (!current()) return;
        if (!await isPinnedOwner(api, userId)) throw new Error('This JAR bridge is no longer linked to your Lumiverse account.');
        if (current()) reply({ result });
      } catch (error) {
        if (current()) reply({ error: error instanceof Error ? error.message : 'JAR could not complete this request.' });
      } finally {
        clearTimeout(job.timer);
        if (jobs.get(owner) === job) jobs.delete(owner);
      }
    })();
  });
  // cors has no cancellation signal: ignore in-flight results after cancellation
  // and prevent any remaining request in a sequence from starting.
  return () => { disposed = true; off(); binding.dispose(); for (const job of jobs.values()) { job.cancelled = true; clearTimeout(job.timer); } jobs.clear(); knownCards.clear(); };
}

declare const spindle: SpindleAPI;
if (typeof spindle !== 'undefined') setupJarBackend(spindle);
