import type { SpindleAPI } from 'lumiverse-spindle-types';
import { isRecordId, normalizeSummaries, object, toCardV2, type JarCardResult, type JarDeleteResult, type JarLinkResult, type JarRecordDetails, type JarResponse, type JarScriptsResult } from './jar-adapter';
import { createJarTransport, JarStillRunningError, normalizeJarBase, type JarRoute } from './transport';
import { characterIdOf, loreTrigger, mergeEarlierCapture, toLorebooks, type JarLorebookAction, type JarLorebooksResult } from './lorebook-adapter';
import { assertLinkedConversation, isChatId, toConversations, toHistory } from './conversation-adapter';
import { characterPageUrl, parseJanitorLink } from './janitor-link';
import { createOwnerBinding, hasJarAccess } from './owner-binding';
import { createLinkIndex } from './link-index';
import { registerUuidHost } from './uuid-host';
import { createJanitorDirect } from './janitor-direct';
import { createScriptHost } from './script-host';
import { createRebuildStore, parseRebuiltEntries, promptMessages, replyText, withSavedRebuild } from './lumiverse-rebuild';
import { hasScriptMacro, toScripts, withoutScriptMacros, withScriptMacro } from './script-source';

type Job = { id: string; cancelled: boolean; timer: ReturnType<typeof setTimeout>; abort: AbortController };
/** A rebuild with the user's own AI can take minutes for a large lorebook. */
const LONG_COMMANDS: Record<string, number> = { 'rebuild-lumiverse': 15 * 60_000 };
const requestChannel = 'jar_bridge:request';
const responseChannel = 'jar_bridge:response';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const commands = new Set(['check', 'connect', 'list', 'card', 'conversations', 'history', 'preview-link', 'lorebooks', 'capture-lorebook', 'rebuild-lorebook', 'attach-lorebook', 'delete-records', 'record-details', 'direct-save', 'direct-status', 'direct-clear', 'direct-preview', 'attach-scripts', 'detach-scripts', 'rebuild-lumiverse']);
/** Lumiverse entity IDs are opaque; accept only short route-safe tokens. */
function isEntityId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function characterUrl(record: Record<string, unknown>): string | undefined {
  return typeof record.characterId === 'string' && uuid.test(record.characterId)
    ? `https://janitorai.com/characters/${record.characterId.toLowerCase()}` : undefined;
}

function exportCard(record: unknown): JarCardResult {
  const card = toCardV2(record);
  return { recordId: card.recordId, name: card.name, card: card.card, ...sourceOf(object(record)),
    ...(card.avatarDataUrl ? { avatarDataUrl: card.avatarDataUrl } : {}), ...(card.warnings ? { warnings: card.warnings } : {}) };
}

/** The record's own page link when it is a link to this same character, else the plain ID link. */
function sourceOf(record: Record<string, unknown>): { sourceUrl?: string } {
  const canonical = characterUrl(record);
  if (!canonical) return {};
  const page = characterPageUrl(record.url);
  return { sourceUrl: page && page.toLowerCase().startsWith(canonical) ? page : canonical };
}

function availableCard(record: unknown): JarCardResult | undefined {
  try { return exportCard(record); } catch { return undefined; }
}

/** Session-targeted, permission-gated archive access and explicit selected-link previews. */
export function setupJarBackend(api: SpindleAPI): () => void {
  const stopUuids = registerUuidHost(api);
  const jobs = new Map<string, Job>();
  const binding = createOwnerBinding(api);
  // The JAR record remembered for each character link, reused after checking it
  // still holds that link. JAR's list omits source IDs; unrelated records are never read.
  const linkIndex = createLinkIndex(api);
  // Experimental JAR-free reads with the user's own JanitorAI login.
  const direct = createJanitorDirect(api);
  // JanitorAI scripts run each reply through the jarScripts macro, in a sandbox.
  const scriptHost = createScriptHost(api);
  const rebuilds = createRebuildStore(api);
  // Earlier JAR record holding a closed-lorebook capture for a previewed record.
  const captureTargets = new Map<string, string>();
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
      if (job?.id === id) { job.cancelled = true; job.abort.abort(); clearTimeout(job.timer); jobs.delete(owner); binding.cancel(userId, frontendSessionId, id); }
      return;
    }
    const command = request.command as JarResponse['command'];
    if (typeof command !== 'string' || !commands.has(command)) return;
    const prior = jobs.get(owner);
    if (prior) { prior.cancelled = true; prior.abort.abort(); clearTimeout(prior.timer); binding.cancel(userId, frontendSessionId, prior.id); }
    const reply = (data: Pick<JarResponse, 'result' | 'error'>) => {
      if (!disposed) api.sendToFrontend({ type: responseChannel, id, command, ...data } satisfies JarResponse, userId, { frontendSessionId });
    };
    const job: Job = { id, cancelled: false, abort: new AbortController(), timer: setTimeout(() => {
      if (!disposed && jobs.get(owner) === job) {
        job.cancelled = true; job.abort.abort(); jobs.delete(owner); binding.cancel(userId, frontendSessionId, id);
        reply({ error: command === 'rebuild-lumiverse' ? 'Your Lumiverse AI took longer than 15 minutes, so the rebuild was stopped. Try a faster model, then try again.' : 'JAR took too long to respond. Check JAR, then try again.' });
      }
    }, LONG_COMMANDS[command] ?? 90_000) };
    jobs.set(owner, job);
    const current = () => !disposed && !job.cancelled && jobs.get(owner) === job;
    void (async () => {
      try {
        if (!await binding.ensure({ userId, sessionId: frontendSessionId, id, command, current })) {
          if (current()) reply({ error: 'JAR Bridge could not verify access for your Lumiverse account. Reopen the importer and retry. Personal installations can only be used by their owning account.' });
          return;
        }
        if (!current()) return;
        if (command === 'attach-lorebook') {
          // Link a book the frontend just imported natively. Both entities must
          // already belong to this account; the merge keeps existing links.
          if (!isEntityId(request.characterId) || !isEntityId(request.worldBookId)) throw new Error('Choose the imported character and lorebook again.');
          const granted = await api.permissions.getGranted();
          if (!current()) return;
          if (!granted.includes('characters') || !granted.includes('world_books')) throw new Error('Allow Characters and World Books to attach this lorebook.');
          const book = await api.world_books.get(request.worldBookId, userId);
          if (!current()) return;
          if (!book || book.id !== request.worldBookId) throw new Error('The imported lorebook is no longer in your library. Nothing was attached.');
          const character = await api.characters.get(request.characterId, userId);
          if (!current()) return;
          if (!character || character.id !== request.characterId) throw new Error('This character is no longer in your library. The lorebook was imported but not attached.');
          const ids = [...new Set([...(Array.isArray(character.world_book_ids) ? character.world_book_ids : []), request.worldBookId])];
          if (!await hasJarAccess(api, userId)) throw new Error('JAR Bridge can no longer verify access for your Lumiverse account.');
          if (!current()) return;
          const updated = await api.characters.update(request.characterId, { world_book_ids: ids }, userId);
          if (!current()) return;
          const worldBookIds = Array.isArray(updated?.world_book_ids) ? updated.world_book_ids.filter(id => typeof id === 'string') : [];
          if (!worldBookIds.includes(request.worldBookId)) throw new Error('Lumiverse did not confirm the attachment. Check the character’s lorebooks before retrying.');
          if (current()) reply({ result: { characterId: request.characterId, worldBookIds } });
          return;
        }
        if (command === 'detach-scripts') {
          // Removes only the bridge's macros and saved scripts; the rest of the card is kept.
          if (!isEntityId(request.characterId)) throw new Error('Choose the character again.');
          const granted = await api.permissions.getGranted();
          if (!current()) return;
          if (!granted.includes('characters')) throw new Error('Allow Characters to change this character.');
          const character = await api.characters.get(request.characterId, userId);
          if (!current()) return;
          if (!character || character.id !== request.characterId) throw new Error('This character is no longer in your library.');
          if (!await hasJarAccess(api, userId)) throw new Error('JAR Bridge can no longer verify access for your Lumiverse account.');
          if (!current()) return;
          if (hasScriptMacro(character.description) || hasScriptMacro(character.scenario)) {
            await api.characters.update(request.characterId, { description: withoutScriptMacros(character.description || ''), scenario: withoutScriptMacros(character.scenario || '') }, userId);
          }
          await scriptHost.remove(request.characterId);
          if (current()) reply({ result: { characterId: request.characterId, scripts: [] } satisfies JarScriptsResult });
          return;
        }
        if (command === 'direct-save' || command === 'direct-status' || command === 'direct-clear' || command === 'direct-preview') {
          // JanitorAI is reached through Lumiverse's CORS proxy; JAR is not involved.
          const granted = await api.permissions.getGranted();
          if (!current()) return;
          if (!granted.includes('cors_proxy')) throw new Error('Allow Local JAR connection (the CORS proxy) in this extension’s permissions, then try again.');
          const result = command === 'direct-save' ? await direct.save(request.token, userId)
            : command === 'direct-status' ? await direct.status(userId)
              : command === 'direct-clear' ? await direct.clear(userId)
                : await direct.preview(request.sourceUrl, userId);
          if (current()) reply({ result });
          return;
        }
        if (request.baseUrl !== undefined && typeof request.baseUrl !== 'string') throw new Error('Enter a local JAR address.');
        const baseUrl = normalizeJarBase(request.baseUrl as string | undefined);
        const transport = createJarTransport(api, baseUrl, { current });
        const get = async (route: JarRoute): Promise<unknown> => {
          if (!await hasJarAccess(api, userId)) throw new Error('JAR Bridge can no longer verify access for your Lumiverse account.');
          if (!current()) throw new Error('Request cancelled.');
          return transport(route);
        };
        // Remember the record used for a link, so later previews reuse it instead of
        // asking JAR to inspect the link again (each inspection is a new JAR record).
        const remember = async (record: Record<string, unknown>): Promise<void> => {
          const url = characterUrl(record);
          if (url && isRecordId(record.id)) await linkIndex.set(`${baseUrl}\0${url}`, record.id);
        };
        let result: NonNullable<JarResponse['result']>;
        if (command === 'preview-link') {
          // JAR accepts arbitrary HTTP URLs containing UUIDs. Validate and
          // canonicalize here before allowing it to navigate its signed-in browser.
          const link = parseJanitorLink(request.sourceUrl);
          let record: Record<string, unknown> | undefined;
          let card: JarCardResult | undefined;
          if (link.kind === 'character') {
            const cacheKey = `${baseUrl}\0${link.sourceUrl}`;
            const cachedId = await linkIndex.get(cacheKey);
            if (cachedId) {
              // A record deleted in JAR, or one now holding another character, is forgotten.
              // A failed read keeps the entry: inspecting again replaces it if the record is gone.
              let candidate: Record<string, unknown> | undefined;
              try { candidate = object(await get({ kind: 'card', recordId: cachedId })); }
              catch (error) { if (!current() || !await hasJarAccess(api, userId)) throw error; }
              if (!current()) return;
              if (candidate?.id === cachedId && characterUrl(candidate) === link.sourceUrl) { record = candidate; card = availableCard(candidate); }
              else if (candidate) await linkIndex.delete(cacheKey);
            }
            if (!record) {
              const inspected = object(await get({ kind: 'inspect', sourceUrl: link.sourceUrl }));
              if (!current()) return;
              if (!isRecordId(inspected.id)) throw new Error('JAR returned an invalid character record for this link.');
              record = object(await get({ kind: 'card', recordId: inspected.id }));
              if (!current()) return;
              if (record.id !== inspected.id || characterUrl(record) !== link.sourceUrl) throw new Error('JAR returned a different character for this link. Nothing was imported.');
              card = availableCard(record);
            }
            if (!card) {
              // Each preview makes a new JAR record. A hidden definition JAR recovered
              // by an earlier capture lives on an older record of the same character.
              // Only same-named records are read, and only one for this exact link is
              // used. The lookup is best-effort: on failure the capture step is offered.
              const name = typeof record.characterName === 'string' ? record.characterName : '';
              try {
                const summaries = name ? normalizeSummaries(await get({ kind: 'captures' })) : [];
                for (const item of summaries.filter(item => item.id !== record!.id && item.name === name).sort((a, b) => b.ts - a.ts).slice(0, 5)) {
                  if (!current()) return;
                  const older = object(await get({ kind: 'card', recordId: item.id }));
                  if (older.id !== item.id || characterUrl(older) !== link.sourceUrl) continue;
                  const recovered = availableCard(older);
                  if (recovered) { record = older; card = recovered; break; }
                }
              } catch { /* keep the hidden-card result */ }
              if (!current()) return;
            }
            await remember(record);
            if (!current()) return;
            result = { kind: 'character', sourceUrl: link.sourceUrl, recordId: record.id as string, characterUrl: link.sourceUrl,
              ...(card ? { card } : { hiddenCard: true, warning: 'This character’s creator hides its definition, so the link preview has only its public details. JAR can recover it with a capture below, or use a downloaded card file.' }) } satisfies JarLinkResult;
          } else {
            const linked = object(await get({ kind: 'link-chat', sourceUrl: link.sourceUrl }));
            if (!current()) return;
            if (!isRecordId(linked.id) || object(linked.conversation).chatId !== link.chatId) throw new Error('JAR returned a different conversation for this link. Nothing was imported.');
            record = object(await get({ kind: 'card', recordId: linked.id }));
            if (!current()) return;
            if (record.id !== linked.id) throw new Error('JAR returned a different character record for this link. Nothing was imported.');
            const linkage = assertLinkedConversation(record, link.chatId);
            const exported = await get({ kind: 'history', chatId: linkage.chatId });
            if (!current()) return;
            const history = toHistory(record, linkage.chatId, exported);
            card = availableCard(record);
            if (card) await remember(record);
            const url = characterUrl(record);
            result = { kind: 'chat', sourceUrl: link.sourceUrl, recordId: linked.id, history,
              ...(url ? { characterUrl: url } : {}), ...(card ? { card } : {
                warning: 'This conversation is ready to review, but its character definition is incomplete. Choose an existing Lumiverse character for the history, or import a downloaded card file first.' }) } satisfies JarLinkResult;
          }
        } else if (command === 'lorebooks' || command === 'capture-lorebook' || command === 'rebuild-lorebook' || command === 'rebuild-lumiverse') {
          if (!isRecordId(request.recordId)) throw new Error('Preview a character from JAR first.');
          const recordId = request.recordId;
          const targetKey = `${owner}\0${baseUrl}\0${recordId}`;
          const hasCapture = (books: JarLorebooksResult) => books.captured || books.books.some(book => book.kind === 'rebuilt');
          // Returns the lorebook view and the JAR record capture/rebuild act on.
          const readJar = async (): Promise<{ lorebooks: JarLorebooksResult; target: string }> => {
            const record = object(await get({ kind: 'card', recordId }));
            if (record.id !== recordId) throw new Error('JAR returned a different character. Preview the link again.');
            const fresh = toLorebooks(record);
            const characterId = characterIdOf(record);
            if (hasCapture(fresh) || !characterId || !fresh.characterName) return { lorebooks: fresh, target: recordId };
            // Only same-named records are read, and only one with the same
            // JanitorAI character ID is used.
            const cached = captureTargets.get(targetKey);
            const summaries = normalizeSummaries(await get({ kind: 'captures' }));
            const candidates = summaries.filter(item => item.id !== recordId && item.name === fresh.characterName)
              .sort((a, b) => Number(b.id === cached) - Number(a.id === cached) || b.ts - a.ts).slice(0, 5);
            for (const item of candidates) {
              if (!current()) break;
              const older = object(await get({ kind: 'card', recordId: item.id }));
              if (older.id !== item.id || characterIdOf(older) !== characterId) continue;
              const earlier = toLorebooks(older);
              if (!hasCapture(earlier)) continue;
              captureTargets.set(targetKey, item.id);
              // The capture record also holds the public details: preview it next time.
              await remember(older);
              return { lorebooks: mergeEarlierCapture(fresh, earlier, earlier.capturedAt || item.ts), target: item.id };
            }
            captureTargets.delete(targetKey);
            return { lorebooks: fresh, target: recordId };
          };
          // A rebuild made with the user's Lumiverse AI is kept by the bridge, not JAR.
          const read = async () => {
            const view = await readJar();
            return { ...view, lorebooks: withSavedRebuild(view.lorebooks, await rebuilds.load(view.target)) };
          };
          const { lorebooks: before, target } = await read();
          if (!current()) return;
          if (command === 'lorebooks') result = before;
          else if (command === 'rebuild-lumiverse') {
            // JAR prepares the same prompt its own rebuild would send; the user's
            // Lumiverse connection answers it instead of JAR's extraction LLM.
            if (!before.captured) throw new Error('Capture the closed lorebook in JAR first, then rebuild it.');
            const granted = await api.permissions.getGranted();
            if (!current()) return;
            if (!granted.includes('generation')) throw new Error('Allow Generation for JAR Bridge to rebuild with your Lumiverse AI.');
            const messages = promptMessages(await get({ kind: 'rebuild-prompt', recordId: target }));
            if (!current()) return;
            if (!await hasJarAccess(api, userId)) throw new Error('JAR Bridge can no longer verify access for your Lumiverse account.');
            if (!current()) return;
            const reply = replyText(await api.generate.quiet({ type: 'quiet', messages, parameters: { temperature: 0.2 }, userId, signal: job.abort.signal }));
            if (!current()) return;
            await rebuilds.save({ schemaVersion: 1, recordId: target, rebuiltAt: Date.now(), capturedAt: before.capturedAt, model: reply.model, entries: parseRebuiltEntries(reply.text) });
            if (!current()) return;
            result = { state: 'done', lorebooks: (await read()).lorebooks } satisfies JarLorebookAction;
          } else {
            // Capture sends messages through JAR's signed-in JanitorAI browser and
            // rebuild calls JAR's configured LLM. Each runs once, only on request.
            if (command === 'capture-lorebook' && !before.allowProxy) throw new Error('This character’s creator does not allow proxies, so JAR cannot capture its closed lorebook. Its public lorebooks can still be imported.');
            if (command === 'rebuild-lorebook' && !before.captured) throw new Error('Capture the closed lorebook in JAR first, then rebuild it.');
            let state: JarLorebookAction['state'] = 'done';
            try { await get(command === 'capture-lorebook' ? { kind: 'capture', recordId: target, force: request.force === true, ...(request.trigger !== undefined ? { trigger: loreTrigger(request.trigger) } : {}) } : { kind: 'rebuild', recordId: target }); }
            catch (error) { if (!(error instanceof JarStillRunningError)) throw error; state = 'running'; }
            if (!current()) return;
            result = { state, lorebooks: (await read()).lorebooks } satisfies JarLorebookAction;
          }
        } else if (command === 'attach-scripts') {
          // Only scripts whose code the creator made public. They run in an
          // interpreter with no network, files or Lumiverse access.
          if (!isRecordId(request.recordId)) throw new Error('Preview a character from JAR first.');
          if (!isEntityId(request.characterId)) throw new Error('Choose the imported character again.');
          const granted = await api.permissions.getGranted();
          if (!current()) return;
          if (!granted.includes('characters')) throw new Error('Allow Characters to run scripts on this character.');
          const record = object(await get({ kind: 'card', recordId: request.recordId }));
          if (!current()) return;
          if (record.id !== request.recordId) throw new Error('JAR returned a different character. Preview the link again.');
          const scripts = toScripts(record);
          if (!scripts.length) throw new Error('JAR found no scripts with public code for this character.');
          const character = await api.characters.get(request.characterId, userId);
          if (!current()) return;
          if (!character || character.id !== request.characterId) throw new Error('This character is no longer in your library.');
          if (!await hasJarAccess(api, userId)) throw new Error('JAR Bridge can no longer verify access for your Lumiverse account.');
          if (!current()) return;
          await scriptHost.save(request.characterId, character.name, scripts);
          if (!current()) return;
          const updated = await api.characters.update(request.characterId, {
            description: withScriptMacro(character.description || '', 'personality', request.characterId),
            scenario: withScriptMacro(character.scenario || '', 'scenario', request.characterId),
          }, userId);
          if (!hasScriptMacro(updated?.description)) throw new Error('Lumiverse did not confirm the change. Check the character’s description before retrying.');
          result = { characterId: request.characterId, scripts: scripts.map(({ id, title }) => ({ id, title })) } satisfies JarScriptsResult;
        } else if (command === 'record-details') {
          const ids = request.recordIds;
          if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every(isRecordId) || new Set(ids).size !== ids.length) throw new Error('Choose the JAR records to check again.');
          const records: JarRecordDetails['records'] = [];
          for (const id of ids) {
            if (!current()) return;
            let record: Record<string, unknown>;
            try { record = object(await get({ kind: 'card', recordId: id })); }
            catch (error) { if (!current() || !await hasJarAccess(api, userId)) throw error; continue; }
            if (record.id !== id) continue;
            records.push({ id, characterId: characterIdOf(record), conversations: Array.isArray(record.conversations) ? record.conversations.length : 0,
              captured: !!record.payload || typeof record.capturedAt === 'number' || !!record.privateLorebookReconstruction });
          }
          result = { records } satisfies JarRecordDetails;
        } else if (command === 'delete-records') {
          // Removes records from JAR only. Nothing in Lumiverse refers to JAR records,
          // so imported characters, chats and lorebooks are unaffected.
          const ids = request.recordIds;
          if (!Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(isRecordId) || new Set(ids).size !== ids.length) throw new Error('Choose the JAR records to delete again.');
          const deleted: string[] = [], failed: string[] = [];
          for (const id of ids) {
            if (!current()) return;
            try { (object(await get({ kind: 'delete', recordId: id })).ok === true ? deleted : failed).push(id); }
            catch (error) { if (!current() || !await hasJarAccess(api, userId)) throw error; failed.push(id); }
          }
          for (const [key, target] of captureTargets) if (deleted.includes(target)) captureTargets.delete(key);
          result = { deleted, failed } satisfies JarDeleteResult;
        } else if (command === 'card' || command === 'conversations' || command === 'history') {
          if (!isRecordId(request.recordId)) throw new Error('Choose a character from the JAR list.');
          if (command === 'history' && !isChatId(request.chatId)) throw new Error('Choose a conversation linked to this JAR character.');
          const record = object(await get({ kind: 'card', recordId: request.recordId }));
          if (!current()) return;
          if (record.id !== request.recordId) throw new Error('JAR returned a different character. Refresh the list and try again.');
          if (command === 'conversations') result = toConversations(record);
          else if (command === 'history') {
            const linkage = assertLinkedConversation(record, request.chatId);
            if (!await hasJarAccess(api, userId)) throw new Error('JAR Bridge can no longer verify access for your Lumiverse account.');
            if (!current()) return;
            const exported = await get({ kind: 'history', chatId: linkage.chatId });
            if (!current()) return;
            result = toHistory(record, linkage.chatId, exported);
          } else {
            const card = exportCard(record);
            await remember(record);
            result = card;
          }
        } else {
          const version = command === 'connect' || command === 'check' ? object(await get({ kind: 'version' })).version : undefined;
          if (!current()) return;
          if ((command === 'connect' || command === 'check') && (typeof version !== 'string' || !version || version.length > 120)) throw new Error('This address did not return a JAR version. Check the local JAR address.');
          // A fresh JAR needs neither a signed-in browser nor saved cards for a
          // connection check. Keep archive loading as a separate explicit action.
          if (command === 'check') result = { version: version as string };
          else {
            const captures = normalizeSummaries(await get({ kind: 'captures' }));
            result = command === 'connect' ? { version: version as string, captures } : { captures };
          }
        }
        if (!current()) return;
        if (!await hasJarAccess(api, userId)) throw new Error('JAR Bridge can no longer verify access for your Lumiverse account.');
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
  return () => { disposed = true; stopUuids(); scriptHost.dispose(); off(); binding.dispose(); for (const job of jobs.values()) { job.cancelled = true; job.abort.abort(); clearTimeout(job.timer); } jobs.clear(); captureTargets.clear(); };
}

declare const spindle: SpindleAPI;
if (typeof spindle !== 'undefined') setupJarBackend(spindle);
