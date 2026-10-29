import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import type { createJarClient } from './client';
import { importNativeLorebook, ImportError, type ImportedCharacter, type ImportedLorebook } from './import-flow';
import { defaultLoreTrigger, loreTriggerSources, MAX_TRIGGER_TEXT, nativeLorebook, type JarLoreTrigger, type JarLorebook, type JarLorebookAction, type JarLorebooksResult } from './lorebook-adapter';

type Client = ReturnType<typeof createJarClient>;
type Action = 'capture' | 'rebuild';
type TriggerSource = typeof loreTriggerSources[number];
const sourceLabels: Record<TriggerSource, string> = {
  card: 'Character card', siteDescription: 'Card description on JanitorAI', scenario: 'Scenario', greetings: 'First message(s)',
  lorebookNames: 'Lorebook names', savedDefault: 'JAR’s saved default trigger text',
};
export interface LorebookOptions {
  client: Client;
  getBaseUrl: () => string;
  /** Lorebook work shares the importer's single JAR request slot. */
  onBusy: (busy: boolean) => void;
  pollMs?: number;
  /** A capture for a hidden-definition character finished; the card can be read again. */
  onHiddenCardCaptured?: () => void;
}

const POLL_MS = 5000;
const WAIT_LIMIT_MS = 10 * 60_000;
const MAX_PREVIEW_ENTRIES = 200;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, click: () => void, cls = 'jar-button') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', click); return node; }
function isAbort(error: unknown) { return error instanceof Error && error.name === 'AbortError'; }
function keys(value: unknown): string[] { return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []; }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const confirmText: Record<Action, string> = {
  capture: 'JAR will open its signed-in JanitorAI browser, create a temporary chat with this character, send probe messages to trigger its lorebook entries, then delete the chat. Entries only appear when one of their keywords is in the trigger message, so add any words you expect to unlock more. This acts on the JanitorAI account signed into JAR. If your chat histories are already imported, sign JAR into a throwaway account first. The creator chose to keep this lorebook closed.',
  rebuild: 'JAR will send the captured lorebook text and this character’s card to the extraction LLM set in JAR’s ⚙ Settings. This uses that service’s quota or credit. The LLM infers trigger keywords, so review them after import.',
};

/** Explicit lorebook import, capture and rebuild for the previewed JAR character. */
export function createLorebooks(ctx: Pick<SpindleFrontendContext, 'permissions'>, options: LorebookOptions) {
  let recordId: string | undefined, data: JarLorebooksResult | undefined, character: ImportedCharacter | undefined;
  let hiddenCard = false, busy = false, outerBusy = false, loading = false, waiting = false, stopWaiting = false, generation = 0, disposed = false, confirming: Action | undefined;
  const imported = new Map<string, ImportedLorebook>();
  /** Public books already tried automatically for the imported character; a failure is not retried on its own. */
  const autoTried = new Set<string>();
  const uncertain = new Set<string>();
  const abort = new AbortController();

  const root = el('section', 'jar-lorebooks'); root.hidden = true; root.setAttribute('aria-label', 'Lorebooks from JAR');
  const heading = el('h2', '', 'Lorebooks');
  const intro = el('p', 'jar-help', 'Lorebooks JAR found for this character. Public lorebooks are imported and attached automatically when you import the character card; you can also import them on their own.');
  // Rebuilt books are not attached automatically, so they get their own prompt above the list.
  const callout = el('div', 'jar-lorebook-callout'); callout.hidden = true; callout.setAttribute('role', 'group'); callout.setAttribute('aria-label', 'Rebuilt lorebook');
  const calloutText = el('p', '');
  const calloutButton = button('', () => { const book = pendingRebuilt(); if (book) void importBook(book, !!character); }, 'jar-button jar-primary');
  callout.append(calloutText, calloutButton);
  const books = el('div', 'jar-lorebook-list');
  const closed = el('div', 'jar-lorebook-closed');
  const closedTitle = el('h3', '', 'Closed lorebook');
  const closedText = el('p', 'jar-help');
  const captureButton = button('Capture closed lorebook…', () => ask('capture'));
  const rebuildButton = button('Rebuild with JAR’s LLM…', () => ask('rebuild'));
  const closedActions = el('div', 'jar-actions jar-lorebook-actions'); closedActions.append(captureButton, rebuildButton);
  const confirm = el('div', 'jar-lorebook-confirm'); confirm.hidden = true; confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', 'Confirm lorebook action');
  const confirmMessage = el('p', 'jar-help');
  // What JAR's trigger message contains: the user's words plus the chosen sources.
  const trigger = el('div', 'jar-lorebook-trigger');
  const wordsLabel = el('label', 'jar-field');
  const words = el('textarea', 'jar-input'); words.rows = 3; words.maxLength = MAX_TRIGGER_TEXT;
  words.placeholder = 'Names, places, factions or other words likely to trigger hidden entries';
  words.addEventListener('input', () => render());
  wordsLabel.append(el('span', 'jar-help', 'Your words (optional), added to the trigger message'), words);
  const sources = el('details', 'jar-lorebook-sources'); sources.append(el('summary', '', 'Also include'));
  const sourceInputs = {} as Record<TriggerSource, HTMLInputElement>;
  for (const source of loreTriggerSources) {
    const label = el('label', 'jar-checkbox'); const input = el('input'); input.type = 'checkbox'; input.checked = defaultLoreTrigger[source];
    input.addEventListener('change', () => render());
    label.append(input, el('span', '', sourceLabels[source])); sources.append(label); sourceInputs[source] = input;
  }
  trigger.append(wordsLabel, sources);
  function triggerChoice(): JarLoreTrigger {
    const choice = { ...defaultLoreTrigger, customText: words.value.trim() };
    for (const source of loreTriggerSources) choice[source] = sourceInputs[source].checked;
    return choice;
  }
  function resetTrigger() { words.value = ''; for (const source of loreTriggerSources) sourceInputs[source].checked = defaultLoreTrigger[source]; }
  const confirmYes = button('', () => { const action = confirming; confirming = undefined; if (action) void run(action); }, 'jar-button jar-primary');
  const confirmNo = button('Cancel', () => { confirming = undefined; render(); });
  const confirmRow = el('div', 'jar-actions'); confirmRow.append(confirmNo, confirmYes); confirm.append(confirmMessage, trigger, confirmRow);
  closed.append(closedTitle, closedText, closedActions, confirm);
  const waitRow = el('div', 'jar-lorebook-wait'); waitRow.hidden = true;
  const waitText = el('span', 'jar-help');
  const stop = button('Stop waiting', () => { stopWaiting = true; options.client.cancel(); }, 'jar-link');
  waitRow.append(waitText, stop);
  const status = el('p', 'jar-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const refresh = button('Check JAR for lorebooks', () => { void load(); }, 'jar-link');
  root.append(heading, intro, refresh, callout, books, closed, waitRow, status);
  function pendingRebuilt() { return data?.books.find(book => book.kind === 'rebuilt' && !imported.has(bookKey(book)) && !uncertain.has(bookKey(book))); }

  function message(text: string, tone = '') { if (disposed) return; status.textContent = text; status.dataset.tone = tone; status.hidden = !text; }
  function setBusy(value: boolean) { busy = value; options.onBusy(value); render(); }
  function bookKey(book: JarLorebook) { return `${recordId}\0${book.key}`; }

  function render() {
    if (disposed) return;
    const locked = busy || outerBusy || loading;
    refresh.disabled = locked; refresh.hidden = !!data;
    const pending = pendingRebuilt();
    callout.hidden = !pending;
    if (pending) {
      calloutText.textContent = character
        ? `${pending.title} was rebuilt from the closed lorebook. It is not attached automatically because its keywords were inferred by an LLM; review it below, then add it to ${character.name}.`
        : `${pending.title} was rebuilt from the closed lorebook. Import the character card to attach it, or import it on its own.`;
      calloutButton.textContent = character ? `Import and attach to ${character.name}` : 'Import rebuilt lorebook';
    }
    calloutButton.disabled = locked;
    books.replaceChildren();
    for (const book of data?.books || []) books.append(renderBook(book, locked));
    if (data && !data.books.length) books.append(el('p', 'jar-help', data.closedTitles.length ? 'No lorebook is ready to import yet.' : 'JAR found no lorebooks for this character.'));
    heading.textContent = hiddenCard ? 'Hidden card and lorebooks' : 'Lorebooks';
    const showClosed = !!data && (hiddenCard || data.closedTitles.length > 0 || data.captured);
    closed.hidden = !showClosed;
    closedTitle.textContent = hiddenCard ? 'Hidden character definition' : 'Closed lorebook';
    if (data && showClosed && hiddenCard) {
      const lore = data.closedTitles.length ? ` The same capture collects its closed lorebooks (${data.closedTitles.join(', ')}) for rebuilding.` : '';
      closedText.textContent = !data.allowProxy
        ? 'The creator hides this character’s definition and does not allow proxies, so JAR cannot recover it. Use a downloaded card file instead.'
        : `The creator hides this character’s definition. JAR can recover it from a temporary chat.${lore} The recovered card is pieced together from the chat prompt, so review it before importing.`;
      captureButton.hidden = !data.allowProxy; captureButton.textContent = 'Capture hidden card with JAR…';
      rebuildButton.hidden = true;
    } else if (data && showClosed) {
      const earlier = data.earlierRecordAt ? `Using the capture JAR saved with an earlier copy of this character (captured ${new Date(data.earlierRecordAt).toLocaleString()}). ` : '';
      const titles = `${data.closedTitles.length ? `JAR could not download: ${data.closedTitles.join(', ')}. ` : ''}${earlier}`;
      const rebuilt = data.books.some(book => book.kind === 'rebuilt');
      closedText.textContent = !data.allowProxy
        ? `${titles}This character’s creator does not allow proxies, so JAR cannot capture its closed lorebook.`
        : rebuilt ? `${titles}A rebuilt copy is listed above. You can capture or rebuild again if the lorebook changed.`
          : data.captured ? `${titles}JAR has captured the closed lorebook text. Rebuild it with JAR’s LLM to get entries with trigger keywords.`
            : `${titles}JAR can capture closed lorebook text, then rebuild it into entries with its LLM. Each step runs only when you confirm it.`;
      captureButton.hidden = !data.allowProxy; captureButton.textContent = data.captured ? 'Capture again…' : 'Capture closed lorebook…';
      rebuildButton.hidden = !data.captured; rebuildButton.textContent = rebuilt ? 'Rebuild again…' : 'Rebuild with JAR’s LLM…';
    }
    captureButton.disabled = locked || !!confirming; rebuildButton.disabled = locked || !!confirming;
    confirm.hidden = !confirming;
    if (confirming) { confirmMessage.textContent = (hiddenCard && confirming === 'capture' ? 'JAR also recovers the hidden character definition from this chat. ' : '') + confirmText[confirming]; confirmYes.textContent = confirming === 'capture' ? 'Yes, capture' : 'Yes, rebuild'; }
    trigger.hidden = confirming !== 'capture';
    const choice = triggerChoice(), empty = !choice.customText && !loreTriggerSources.some(source => choice[source]);
    words.disabled = locked; for (const source of loreTriggerSources) sourceInputs[source].disabled = locked;
    confirmYes.disabled = locked || (confirming === 'capture' && empty); confirmNo.disabled = locked;
    waitRow.hidden = !waiting; stop.disabled = !waiting;
    root.setAttribute('aria-busy', String(busy));
  }

  function renderBook(book: JarLorebook, locked: boolean) {
    const card = el('details', book.kind === 'rebuilt' ? 'jar-lorebook jar-lorebook-rebuilt' : 'jar-lorebook');
    const done = imported.get(bookKey(book)), unsure = uncertain.has(bookKey(book));
    const label = book.kind === 'rebuilt' ? `Rebuilt${book.model ? ` · ${book.model}` : ''}` : 'Public';
    card.append(el('summary', '', `${book.title} · ${book.entries.length} entr${book.entries.length === 1 ? 'y' : 'ies'} · ${label}`));
    if (book.description) card.append(el('p', 'jar-help', book.description));
    const list = el('div', 'jar-lorebook-entries');
    for (const entry of book.entries.slice(0, MAX_PREVIEW_ENTRIES)) {
      const row = el('details', 'jar-lorebook-entry');
      const words = keys(entry.key);
      row.append(el('summary', '', `${typeof entry.comment === 'string' && entry.comment.trim() ? entry.comment.trim() : 'Untitled entry'}${entry.constant === true ? ' · always active' : ''}`),
        el('p', 'jar-lorebook-keys', words.length ? `Keywords: ${words.join(', ')}` : 'No keywords'), el('p', '', String(entry.content)));
      list.append(row);
    }
    if (book.entries.length > MAX_PREVIEW_ENTRIES) list.append(el('p', 'jar-help', `Showing the first ${MAX_PREVIEW_ENTRIES} entries. All ${book.entries.length} will be imported.`));
    card.append(list);
    if (book.kind === 'rebuilt') card.append(el('p', 'jar-help', 'Keywords were inferred by an LLM. Very general keywords can make an entry trigger too often; edit them in Lumiverse’s World Info after import.'));
    const row = el('div', 'jar-actions jar-lorebook-actions');
    const attach = el('label', 'jar-checkbox'); const attachInput = el('input'); attachInput.type = 'checkbox'; attachInput.checked = !!character;
    attach.append(attachInput, el('span', '', character ? `Attach to ${character.name}` : 'Import the character card to attach this lorebook to it'));
    attachInput.disabled = locked || !character || !!done; attach.hidden = !!done;
    const go = button(done ? 'Imported' : 'Import lorebook', () => { void importBook(book, attachInput.checked); }, 'jar-button jar-primary');
    go.disabled = locked || !!done || unsure;
    row.append(attach, go);
    if (unsure) row.append(button('I checked World Info — retry', () => { uncertain.delete(bookKey(book)); render(); }, 'jar-link'));
    if (done) row.append(el('span', 'jar-help', `${done.name} is in your World Info.`));
    card.append(row);
    return card;
  }

  /**
   * A read-only background request: it does not lock the importer. Any other
   * importer request replaces it, leaving the explicit check button.
   */
  async function load() {
    if (disposed || busy || outerBusy || loading || !recordId) return;
    const token = ++generation, id = recordId;
    loading = true; render(); message('Checking JAR for lorebooks…');
    try {
      const result = await options.client.request('lorebooks', options.getBaseUrl(), id) as JarLorebooksResult;
      if (disposed || token !== generation) return;
      data = result; message('');
    } catch (error) { if (!disposed && token === generation) message(isAbort(error) ? '' : error instanceof Error ? error.message : 'Could not read lorebooks from JAR.', isAbort(error) ? '' : 'error'); }
    finally { if (!disposed && token === generation) { loading = false; render(); autoImport(); } }
  }

  /** Public books need no capture, so they follow the imported character card in one go. */
  function autoImport() {
    if (disposed || busy || outerBusy || loading || !character || !data) return;
    const next = data.books.find(book => book.kind === 'public' && !imported.has(bookKey(book)) && !uncertain.has(bookKey(book)) && !autoTried.has(bookKey(book)));
    if (!next) return;
    autoTried.add(bookKey(next));
    void importBook(next, true).then(autoImport);
  }

  function ask(action: Action) { if (disposed || busy || outerBusy || !data) return; confirming = action; render(); confirmYes.focus?.({ preventScroll: true }); }

  async function run(action: Action) {
    if (disposed || busy || outerBusy || !recordId || !data) return;
    const token = ++generation, id = recordId, before = data, forCard = hiddenCard && action === 'capture';
    let recovered = false;
    const verb = action === 'capture' ? 'capturing the closed lorebook' : 'rebuilding the lorebook with its LLM';
    setBusy(true); message(`JAR is ${verb}…`);
    const finished = (next: JarLorebooksResult) => action === 'capture'
      ? next.captured && (next.capturedAt > before.capturedAt || !before.captured)
      : next.rebuiltAt > before.rebuiltAt;
    try {
      const reply = await options.client.request(action === 'capture' ? 'capture-lorebook' : 'rebuild-lorebook', options.getBaseUrl(), id, undefined, undefined,
        action === 'capture' ? { ...(before.captured ? { force: true } : {}), trigger: triggerChoice() } : undefined) as JarLorebookAction;
      if (disposed || token !== generation) return;
      data = reply.lorebooks;
      if (reply.state === 'running' && !finished(data)) {
        // JAR keeps working after Lumiverse's proxy gives up; read the record until it lands.
        waiting = true; stopWaiting = false; render();
        const started = Date.now();
        while (!disposed && token === generation && !stopWaiting) {
          if (Date.now() - started > WAIT_LIMIT_MS) { message('JAR has not finished after 10 minutes. Check JAR’s console, then choose Check JAR for lorebooks.', 'warning'); data = undefined; return; }
          waitText.textContent = `JAR is still ${verb}… ${Math.round((Date.now() - started) / 1000)} s`;
          await sleep(options.pollMs ?? POLL_MS);
          if (disposed || token !== generation || stopWaiting) break;
          try { data = await options.client.request('lorebooks', options.getBaseUrl(), id) as JarLorebooksResult; }
          catch (error) { if (isAbort(error) && stopWaiting) break; throw error; }
          if (disposed || token !== generation) return;
          if (finished(data)) break;
        }
        if (stopWaiting) { message('Stopped waiting. JAR may still finish; choose Check JAR for lorebooks later.', 'warning'); data = undefined; return; }
      }
      if (disposed || token !== generation) return;
      if (forCard && finished(data)) { recovered = true; message('Captured. Loading the recovered card…', 'success'); return; }
      message(!finished(data) ? 'JAR did not report a new result. Check JAR’s console, then try again.'
        : action === 'capture' ? 'Captured. Rebuild it with JAR’s LLM to get entries with trigger keywords.' : 'Rebuilt. Review the entries, then import the lorebook.', finished(data) ? 'success' : 'warning');
    } catch (error) { if (!isAbort(error) && !disposed && token === generation) message(error instanceof Error ? error.message : 'JAR could not finish this step.', 'error'); }
    finally { if (!disposed && token === generation) { waiting = false; setBusy(false); if (recovered) options.onHiddenCardCaptured?.(); } }
  }

  async function importBook(book: JarLorebook, attach: boolean) {
    const key = bookKey(book);
    if (disposed || busy || outerBusy || imported.has(key) || uncertain.has(key)) return;
    const token = ++generation, target = attach ? character : undefined;
    setBusy(true); message(`Importing ${book.title}…`);
    try {
      const result = await importNativeLorebook(ctx, nativeLorebook(book), () => !disposed && token === generation, abort.signal);
      imported.set(key, result);
      if (disposed || token !== generation) return;
      if (!target) { message(`Imported ${result.entryCount} entries into World Info.`, 'success'); return; }
      try {
        await options.client.request('attach-lorebook', options.getBaseUrl(), undefined, undefined, undefined, { characterId: target.id, worldBookId: result.id });
        if (!disposed && token === generation) message(`Imported ${result.entryCount} entries and attached them to ${target.name}.`, 'success');
      } catch (error) {
        if (!isAbort(error) && !disposed && token === generation) message(`Imported into World Info, but not attached: ${error instanceof Error ? error.message : 'attachment failed.'} Attach it from the character’s lorebook settings.`, 'warning');
      }
    } catch (error) {
      if (disposed || token !== generation || isAbort(error)) return;
      if (error instanceof ImportError && error.uncertain) uncertain.add(key);
      message(error instanceof Error ? error.message : 'The lorebook could not be imported.', 'error');
    } finally { if (!disposed && token === generation) setBusy(false); }
  }

  return {
    root,
    /** Read lorebooks for a newly previewed JAR character. Does not capture anything. */
    show(id: string, hidden = false) {
      if (disposed) return;
      if (recordId !== id || hiddenCard !== hidden) { hiddenCard = hidden; generation++; loading = false; recordId = id; data = undefined; confirming = undefined; autoTried.clear(); resetTrigger(); message(''); }
      root.hidden = false; render(); if (!data) void load();
    },
    hide() { if (disposed) return; generation++; if (waiting) options.client.cancel(); waiting = false; loading = false; recordId = undefined; hiddenCard = false; data = undefined; confirming = undefined; root.hidden = true; message(''); if (busy) setBusy(false); },
    setCharacter(value?: ImportedCharacter) {
      character = value; render(); autoImport();
      if (value && pendingRebuilt()) callout.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    },
    setBusy(value: boolean) { outerBusy = value && !busy; render(); autoImport(); },
    destroy() { disposed = true; generation++; abort.abort(); root.remove(); },
  };
}
