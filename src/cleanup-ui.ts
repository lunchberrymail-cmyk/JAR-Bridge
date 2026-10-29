import type { createJarClient } from './client';
import type { JarDeleteResult, JarRecordDetail, JarRecordDetails, JarSummary } from './jar-adapter';

type Client = ReturnType<typeof createJarClient>;
export interface CleanupOptions {
  client: Client;
  getBaseUrl: () => string;
  /** Deleting shares the importer's single JAR request slot. */
  onBusy: (busy: boolean) => void;
  /** Some records were deleted; the saved-card list should be read again. */
  onDeleted: (deleted: string[]) => void;
}

const BATCH = 100;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, click: () => void, cls = 'jar-button') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', click); return node; }
function isAbort(error: unknown) { return error instanceof Error && error.name === 'AbortError'; }

/** JAR's record source, in the words the importer uses. */
export function recordKind(item: JarSummary): string {
  if (item.source === 'inspect') return 'Link preview';
  if (item.source === 'generateAlpha') return 'Capture';
  return item.source ? `Saved (${item.source})` : 'Saved';
}

/** Records worth reading to find duplicates: those sharing a name with another record. */
export function duplicateCandidates(items: JarSummary[]): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  return items.filter(item => (counts.get(item.name) || 0) > 1).map(item => item.id);
}

/**
 * Empty link previews JAR made again for a JanitorAI character it already has,
 * matched by character ID, never by name. A record with a capture or linked
 * conversations is never selected; without one, the newest empty preview is kept.
 */
export function duplicatePreviews(items: JarSummary[], details: JarRecordDetail[]): string[] {
  const known = new Map(details.map(detail => [detail.id, detail]));
  const groups = new Map<string, JarSummary[]>();
  for (const item of items) {
    const characterId = known.get(item.id)?.characterId;
    if (characterId) groups.set(characterId, [...groups.get(characterId) || [], item]);
  }
  const duplicates: string[] = [];
  for (const group of groups.values()) {
    const isEmpty = (item: JarSummary) => { const detail = known.get(item.id)!; return item.source === 'inspect' && !detail.captured && !detail.conversations; };
    const empty = group.filter(isEmpty).sort((a, b) => b.ts - a.ts);
    duplicates.push(...empty.slice(empty.length === group.length ? 1 : 0).map(item => item.id));
  }
  return duplicates;
}

/** Explicit, confirmed deletion of JAR records. Lumiverse data is never touched. */
export function createCleanup(options: CleanupOptions) {
  let items: JarSummary[] = [], busy = false, outerBusy = false, confirming = false, disposed = false;
  const chosen = new Set<string>();

  const root = el('section', 'jar-cleanup'); root.hidden = true; root.setAttribute('aria-label', 'Clean up JAR');
  const heading = el('h3', '', 'Clean up JAR');
  const intro = el('p', 'jar-help', 'Delete records saved in JAR. This only removes them from JAR: characters, chats and lorebooks you imported into Lumiverse stay exactly as they are.');
  const shortcuts = el('div', 'jar-actions jar-cleanup-shortcuts');
  const pickDuplicates = button('Select duplicate previews', () => { void findDuplicates(); }, 'jar-link');
  const pickAll = button('Select all', () => { for (const item of items) chosen.add(item.id); render(); }, 'jar-link');
  const pickNone = button('Select none', () => { chosen.clear(); render(); }, 'jar-link');
  shortcuts.append(pickDuplicates, pickAll, pickNone);
  const list = el('div', 'jar-cleanup-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'JAR records');
  const remove = button('', () => { if (chosen.size) { confirming = true; render(); confirmYes.focus?.({ preventScroll: true }); } }, 'jar-button jar-danger');
  const confirm = el('div', 'jar-cleanup-confirm'); confirm.setAttribute('role', 'group'); confirm.setAttribute('aria-label', 'Confirm deletion');
  const confirmText = el('ul', '');
  const confirmNo = button('Cancel', () => { confirming = false; render(); });
  const confirmYes = button('', () => { void run(); }, 'jar-button jar-danger');
  const confirmRow = el('div', 'jar-actions'); confirmRow.append(confirmNo, confirmYes);
  confirm.append(confirmText, confirmRow);
  const status = el('p', 'jar-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  root.append(heading, intro, shortcuts, list, remove, confirm, status);

  function message(text: string, tone = '') { status.textContent = text; status.dataset.tone = tone; status.hidden = !text; }

  function render() {
    if (disposed) return;
    const locked = busy || outerBusy;
    list.replaceChildren();
    if (!items.length) list.append(el('p', 'jar-help', 'JAR has no saved records.'));
    for (const item of items) {
      const row = el('label', 'jar-checkbox jar-cleanup-row');
      const input = el('input'); input.type = 'checkbox'; input.checked = chosen.has(item.id); input.disabled = locked;
      input.addEventListener('change', () => { if (input.checked) chosen.add(item.id); else chosen.delete(item.id); confirming = false; render(); });
      const when = item.ts ? new Date(item.ts).toLocaleString() : 'unknown date';
      row.append(input, el('span', '', `${item.name} · ${recordKind(item)} · ${when}`));
      list.append(row);
    }
    const picked = items.filter(item => chosen.has(item.id));
    remove.textContent = picked.length ? `Delete ${picked.length} from JAR…` : 'Delete from JAR…';
    remove.disabled = locked || !picked.length || confirming;
    for (const node of [pickDuplicates, pickAll, pickNone]) node.disabled = locked;
    confirm.hidden = !confirming;
    if (confirming) {
      const captures = picked.filter(item => item.source === 'generateAlpha').length;
      confirmText.replaceChildren(...[
        `${picked.length} record${picked.length === 1 ? '' : 's'} will be permanently deleted from JAR.`,
        'Nothing in Lumiverse is changed or deleted.',
        ...(captures ? [`${captures} of them ${captures === 1 ? 'is a capture' : 'are captures'}: the captured lorebook text and any recovered hidden card are lost, so a rebuild needs a new capture.`] : []),
        'JAR’s links to your JanitorAI conversations in these records are removed too. Your chats on JanitorAI are not affected.',
      ].map(text => el('li', '', text)));
      confirmYes.textContent = `Yes, delete ${picked.length}`;
    }
    confirmYes.disabled = locked; confirmNo.disabled = locked;
    root.setAttribute('aria-busy', String(busy));
  }

  async function findDuplicates() {
    if (disposed || busy || outerBusy) return;
    const candidates = duplicateCandidates(items).slice(0, 200);
    if (!candidates.length) { chosen.clear(); render(); message('No duplicate previews found.'); return; }
    busy = true; options.onBusy(true); render(); message('Checking which records are copies of the same character…');
    try {
      const reply = await options.client.request('record-details', options.getBaseUrl(), undefined, undefined, undefined, { recordIds: candidates }) as JarRecordDetails;
      if (disposed) return;
      chosen.clear(); for (const id of duplicatePreviews(items, reply.records)) chosen.add(id);
      message(chosen.size ? `Selected ${chosen.size} empty duplicate preview${chosen.size === 1 ? '' : 's'}. Captures and records linked to conversations are never selected.` : 'No duplicate previews found.');
    } catch (error) { if (!disposed && !isAbort(error)) message(error instanceof Error ? error.message : 'JAR could not check these records.', 'error'); }
    finally { if (!disposed) { busy = false; options.onBusy(false); render(); } }
  }

  async function run() {
    if (disposed || busy || outerBusy || !chosen.size) return;
    const ids = items.filter(item => chosen.has(item.id)).map(item => item.id);
    confirming = false; busy = true; options.onBusy(true); render(); message(`Deleting ${ids.length} from JAR…`);
    const deleted: string[] = [], failed: string[] = [];
    try {
      for (let start = 0; start < ids.length; start += BATCH) {
        const reply = await options.client.request('delete-records', options.getBaseUrl(), undefined, undefined, undefined, { recordIds: ids.slice(start, start + BATCH) }) as JarDeleteResult;
        if (disposed) return;
        deleted.push(...reply.deleted); failed.push(...reply.failed);
      }
    } catch (error) {
      if (!disposed && !isAbort(error)) failed.push(...ids.filter(id => !deleted.includes(id) && !failed.includes(id)));
      if (!disposed && !isAbort(error) && !deleted.length) message(error instanceof Error ? error.message : 'JAR could not delete these records.', 'error');
    } finally {
      if (!disposed) {
        for (const id of deleted) chosen.delete(id);
        items = items.filter(item => !deleted.includes(item.id));
        busy = false; options.onBusy(false);
        if (deleted.length) message(`Deleted ${deleted.length} from JAR.${failed.length ? ` ${failed.length} could not be deleted; refresh and try again.` : ''}`, failed.length ? 'warning' : 'success');
        render();
        if (deleted.length) options.onDeleted(deleted);
      }
    }
  }

  return {
    root,
    show(records: JarSummary[]) {
      if (disposed) return;
      items = [...records].sort((a, b) => a.name.localeCompare(b.name) || b.ts - a.ts);
      for (const id of [...chosen]) if (!items.some(item => item.id === id)) chosen.delete(id);
      root.hidden = false; render();
    },
    hide() { if (disposed || busy) return; root.hidden = true; confirming = false; chosen.clear(); message(''); },
    get open() { return !root.hidden; },
    setBusy(value: boolean) { outerBusy = value && !busy; render(); },
    destroy() { disposed = true; root.remove(); },
  };
}
