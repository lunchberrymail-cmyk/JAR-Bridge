import type { SpindleFrontendContext, SpindleModalHandle } from 'lumiverse-spindle-types';
import { requestPermissions } from './permissions';
import styles from './style.css' with { type: 'text' };
import type { JarCardResult, JarSummary } from './jar-adapter';
import { createJarClient } from './client';
import { createCardFile, CardFileError } from './card-file';
import { importNativeCard, ImportError, type ImportedCharacter } from './import-flow';
import { normalizeJarBase } from './transport';
import { createChatHistory, type HistoryStart } from './chats-ui';
import { createImportGuide } from './import-guide';
import { createLorebooks } from './lorebooks-ui';
import { parseJanitorLink } from './janitor-link';
import type { JarHistoryResult } from './conversation-adapter';

const importIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/></svg>';
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, click: () => void, cls = 'jar-button') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', click); return node; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isAbort(error: unknown) { return error instanceof Error && error.name === 'AbortError'; }

export function setup(ctx: SpindleFrontendContext) {
  let disposed = false, busy = false, generation = 0, connected = false, mode: 'archive' | 'file' | 'history' = 'archive';
  let captures: JarSummary[] = [], selected: JarCardResult | undefined, chosenFile: File | undefined;
  let imported: ImportedCharacter | undefined, uncertain = false;
  let guideVisible = false;
  let returnToHistory = false;
  const importedSources = new Map<string, ImportedCharacter>();
  const uncertainSources = new Set<string>();
  const recordAliases = new Map<string, string>();
  let pendingHistory: JarHistoryResult | undefined;
  const abort = new AbortController();
  const client = createJarClient(ctx);
  const removeStyle = ctx.dom.addStyle(styles);
  const tab = ctx.ui.registerDrawerTab({ id: 'import', title: 'JAR Import', shortName: 'Import', headerTitle: 'JAR Bridge', description: 'Bring JAR characters and chat histories into Lumiverse', keywords: ['jar_bridge', 'jar-bridge-import', 'jar-bridge-guided-import', 'characters', 'chats', 'import'], iconSvg: importIcon });
  tab.root.classList.add('jar-bridge');
  const root = el('div', 'jar-shell');
  let window: SpindleModalHandle | undefined;
  const expand = button('Open import assistant in a larger window', () => openWindow(), 'jar-button jar-expand'); tab.root.append(expand);
  function openWindow() {
    if (disposed || window) return;
    const current = ctx.ui.showModal({ title: 'Import assistant', width: 880, maxHeight: 880 }); window = current;
    current.root.classList.add('jar-bridge', 'jar-import-modal'); current.root.append(root);
    current.onDismiss(() => { if (window === current) window = undefined; if (!disposed) tab.root.append(root); });
  }
  const eyebrow = el('div', 'jar-eyebrow', 'FROM JANITORAI TO LUMIVERSE');
  const heading = el('h1', '', 'Import your old chats and cards.');
  const intro = el('p', 'jar-intro', 'Paste a link or choose a file, preview it, then import.');
  const backToGuide = button('Help and import guide', () => showGuide(), 'jar-link jar-back-guide');
  const closeGuide = button('Back to importer', () => hideGuide(), 'jar-button jar-close-guide');
  const tabs = el('div', 'jar-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Character source');
  const archiveTab = button('JanitorAI link', () => switchMode('archive'), 'jar-tab');
  const fileTab = button('Import card file', () => switchMode('file'), 'jar-tab');
  const historyTab = button('Chat history', () => switchMode('history'), 'jar-tab');
  const archivePanel = el('section', 'jar-panel'); archivePanel.id = 'jar-archive-panel';
  const filePanel = el('section', 'jar-panel'); filePanel.id = 'jar-file-panel';
  const historyPanel = el('section', 'jar-panel'); historyPanel.id = 'jar-history-panel';
  const sourceTabs = [[archiveTab, archivePanel, 'archive'], [fileTab, filePanel, 'file'], [historyTab, historyPanel, 'history']] as const;
  for (const [node, panel, key] of sourceTabs) { node.id = `jar-${key}-tab`; node.setAttribute('role', 'tab'); node.setAttribute('aria-controls', panel.id); panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', node.id); tabs.append(node); }
  tabs.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return; const current = sourceTabs.findIndex(([node]) => node === document.activeElement); if (current < 0) return; event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowLeft' ? 2 : 1)) % 3; const [next, , key] = sourceTabs[index]; switchMode(key); next.focus(); });

  const addressField = el('label', 'jar-field'); addressField.htmlFor = 'jar-address';
  const address = el('input', 'jar-input'); address.id = 'jar-address'; address.type = 'url'; address.value = 'http://127.0.0.1:4577'; address.autocomplete = 'off'; address.spellcheck = false;
  addressField.append(el('span', 'jar-label', 'Local JAR address'), address);
  const connect = button('Check JAR connection', () => { void checkConnection(); }, 'jar-button jar-primary');
  const openJar = el('a', 'jar-button', 'Open JAR'); openJar.target = '_blank'; openJar.rel = 'noopener noreferrer'; openJar.href = normalizeJarBase(address.value);
  openJar.addEventListener('click', event => { try { openJar.href = normalizeJarBase(address.value); } catch { event.preventDefault(); message('Enter JAR’s local address before opening it.', 'warning'); } });
  const connectionRow = el('div', 'jar-connect'); connectionRow.append(connect, openJar);
  const linkPanel = el('section', 'jar-link-panel'); linkPanel.setAttribute('aria-label', 'Import from a JanitorAI link');
  const sourceField = el('label', 'jar-field'); sourceField.htmlFor = 'jar-source-link';
  const sourceLink = el('input', 'jar-input'); sourceLink.id = 'jar-source-link'; sourceLink.type = 'url'; sourceLink.maxLength = 2048; sourceLink.autocomplete = 'off'; sourceLink.spellcheck = false; sourceLink.placeholder = 'https://janitorai.com/characters/… or /chats/…';
  sourceField.append(el('span', 'jar-label', 'JanitorAI character or chat link'), sourceLink);
  const loadLink = button('Preview link', () => { void previewLink(); }, 'jar-button jar-primary');
  sourceLink.addEventListener('input', updateControls); sourceLink.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void previewLink(); } });
  const sourceRow = el('div', 'jar-connect'); sourceRow.append(sourceField, loadLink);
  linkPanel.append(sourceRow, el('p', 'jar-help', 'JAR must be running and signed in on the computer hosting Lumiverse. Phone or tablet without JAR? Use a downloaded card file; the Help guide explains how.'));
  const advancedAddress = el('details', 'jar-address-details'); advancedAddress.append(el('summary', '', 'Change JAR address'), addressField);
  const connectionHint = el('p', 'jar-help', 'Load cards already stored by this copy of JAR. A fresh download may have no saved cards yet.');
  const openJarHint = el('p', 'jar-help', 'Using Lumiverse from another device? Connect still reads JAR on the server computer. Open JAR’s 127.0.0.1 link on that computer; the link opens the device you are currently using.');
  const connectedLabel = el('p', 'jar-connection-state', 'Connection not checked'); connectedLabel.setAttribute('role', 'status');
  const connectionHelp = el('details', 'jar-address-details jar-connection-help');
  connectionHelp.append(el('summary', '', 'JAR won’t connect?'),
    el('p', 'jar-help', 'On Windows, open start.bat in the fully extracted JAR folder containing package.json. On macOS or Linux, run npm start there. Keep the console open; closing it stops JAR even if its browser tab is still open.'),
    el('p', 'jar-help', 'Run JAR on the same computer as the Lumiverse server. If Lumiverse runs on another computer or in Docker, its local address does not reach JAR on your browsing device. Use a card or history file if you cannot run both together.'),
    el('p', 'jar-help', 'Use the port shown in JAR’s console. Once the connection check succeeds, use JAR’s Log in button before loading JanitorAI links. A newly extracted copy has its own login session and saved-card folder.'));
  const connectionPanel = el('section', 'jar-connection-panel'); connectionPanel.setAttribute('aria-label', 'Local JAR connection');
  connectionPanel.append(connectionRow, connectedLabel, el('p', 'jar-help', 'Checks whether JAR is running. No JanitorAI login or saved cards are needed for this check.'), advancedAddress, connectionHelp);
  const loadSaved = button('Load saved cards', () => { void load(true); });
  const continueHistory = button('Continue to chat history →', () => switchMode('history'), 'jar-button jar-primary'); continueHistory.hidden = true;
  const results = el('section', 'jar-results'); results.hidden = true;
  const listHeading = el('div', 'jar-list-heading');
  const count = el('h2', '', 'Saved characters');
  const refresh = button('Refresh', () => { void load(false); }, 'jar-link');
  listHeading.append(count, refresh);
  const search = el('input', 'jar-input'); search.type = 'search'; search.placeholder = 'Find a character…'; search.setAttribute('aria-label', 'Search saved characters');
  const list = el('div', 'jar-list'); list.setAttribute('aria-label', 'Saved JAR characters');
  search.addEventListener('input', renderList);
  results.append(listHeading, search, list);
  const savedArchive = el('details', 'jar-saved-details');
  savedArchive.append(el('summary', '', 'Cards already saved in JAR'), connectionHint, loadSaved, continueHistory, results);
  advancedAddress.append(openJarHint);
  archivePanel.append(linkPanel, savedArchive);

  const drop = el('div', 'jar-drop'); const dropIcon = el('div', 'jar-drop-icon', '↓');
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = '.png,.json,.charx'; fileInput.hidden = true;
  const choose = button('Choose card file', () => fileInput.click(), 'jar-button jar-primary');
  const fileName = el('p', 'jar-file-name', 'No file selected');
  drop.append(dropIcon, el('h2', '', 'Import your character card file'), el('p', 'jar-help', 'Choose the PNG or JSON card you exported. You do not need JAR running for a file import. After saving the card, you can add its conversation from a JAR JSON or SillyTavern JSONL history file.'), choose, fileInput, fileName);
  filePanel.append(drop, el('p', 'jar-help', 'PNG keeps the portrait. JSON carries the character text. A plain avatar image is not a character card. CHARX cards are also accepted.'));
  fileInput.addEventListener('change', () => { acceptFile(fileInput.files?.[0]); fileInput.value = ''; });
  for (const name of ['dragenter', 'dragover'] as const) drop.addEventListener(name, event => { event.preventDefault(); if (!busy) drop.classList.add('jar-dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('jar-dragging'));
  drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('jar-dragging'); if (!busy) acceptFile(event.dataTransfer?.files[0]); });

  const preview = el('section', 'jar-preview'); preview.hidden = true;
  const previewTop = el('div', 'jar-preview-top'); const portrait = el('div', 'jar-portrait');
  const previewInfo = el('div'); const previewName = el('h2'); previewName.tabIndex = -1; const previewMeta = el('p', 'jar-help'); previewInfo.append(previewName, previewMeta); previewTop.append(portrait, previewInfo);
  const warnings = el('p', 'jar-warning'); warnings.hidden = true;
  const useExisting = button('Use an existing character for this chat', () => {
    if (disposed || busy || !pendingHistory) return;
    const recordId = selected?.recordId;
    switchMode('history', { source: 'jar', recordId, preparedHistory: pendingHistory, character: recordId ? importedSources.get(recordKey(recordId)) : undefined });
  }); useExisting.hidden = true;
  const sections = el('div', 'jar-card-fields');
  const noAvatar = el('label', 'jar-checkbox'); noAvatar.hidden = true; const noAvatarInput = el('input'); noAvatarInput.type = 'checkbox'; noAvatar.append(noAvatarInput, el('span', '', 'Import without portrait'));
  noAvatarInput.addEventListener('change', updateControls);
  preview.append(previewTop, useExisting, warnings, sections, noAvatar);
  const status = el('p', 'jar-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const success = el('div', 'jar-success'); success.hidden = true;
  const successText = el('strong'); const nextHistory = button('Next: import chat history', () => {
    if (!imported || busy) return;
    const start: HistoryStart = { character: imported, source: mode === 'file' ? 'file' : 'jar', ...(mode === 'archive' && selected ? { recordId: selected.recordId } : {}), ...(pendingHistory ? { preparedHistory: pendingHistory } : {}) };
    switchMode('history', start);
  }, 'jar-button jar-primary'); success.append(successText, nextHistory);
  const actions = el('div', 'jar-actions');
  const library = button('Character library', () => { void navigate({ kind: 'drawer_tab', id: 'characters' }); }, 'jar-link');
  const retry = button('I checked my library — retry', () => { uncertainSources.delete(sourceKey()); uncertain = false; message('Ready to retry. Choose Import to continue.'); updateControls(); }, 'jar-link'); retry.hidden = true;
  const importButton = button('Import to Lumiverse', () => { void runImport(); }, 'jar-button jar-primary');
  actions.append(library, retry, importButton);
  const chatHistory = createChatHistory(ctx, {
    client, getCaptures: () => captures, getBaseUrl: () => address.value.trim(),
    getImportedCharacter: recordId => importedSources.get(recordKey(recordId)),
    openArchive: () => { switchMode('archive'); savedArchive.open = true; returnToHistory = true; updateControls(); },
    openCharacterLink: (url, history) => { if (disposed || busy) return; switchMode('archive'); sourceLink.value = url; void previewLink(history); },
    onBusy: value => { busy = value; updateControls(); renderList(); },
    onNavigate: () => window?.dismiss(),
  });
  const guide = createImportGuide({ start: next => switchMode(next) });
  const lorebooks = createLorebooks(ctx, { client, getBaseUrl: () => address.value.trim(), onBusy: value => { busy = value; updateControls(); renderList(); } });
  historyPanel.append(chatHistory.root);
  root.append(eyebrow, heading, intro, backToGuide, closeGuide, guide.root, tabs, connectionPanel, archivePanel, filePanel, historyPanel, preview, status, success, actions, lorebooks.root); tab.root.append(root);
  /** Lorebooks belong to the previewed JAR record; reading them never captures anything. */
  function syncLorebooks() { if (!disposed && !busy && mode === 'archive' && selected) { lorebooks.show(selected.recordId); lorebooks.setCharacter(imported); } }

  function message(text: string, tone = '') { if (disposed) return; status.textContent = text; status.dataset.tone = tone; status.hidden = guideVisible || mode === 'history' || !text; }
  async function navigate(target: { kind: 'drawer_tab' | 'route'; id: string }, params?: Record<string, string>) {
    try { if (!ctx.host.surfaces) throw new Error(); await ctx.host.surfaces.invoke(target, params); window?.dismiss(); }
    catch { message('Open your character library from Lumiverse’s sidebar.', 'warning'); }
  }
  function recordKey(recordId: string) { const key = `jar:${normalizeJarBase(address.value.trim())}:${recordId}`; return recordAliases.get(key) || key; }
  function aliasRecord(endpoint: string, recordId: string, alias: string) {
    const key = `jar:${endpoint}:${recordId}`, previous = recordAliases.get(key) || key;
    const saved = importedSources.get(previous); if (saved && !importedSources.has(alias)) importedSources.set(alias, saved);
    if (uncertainSources.has(previous)) uncertainSources.add(alias);
    recordAliases.set(key, alias);
  }
  function sourceKey() { return mode === 'archive' && selected ? recordKey(selected.recordId) : chosenFile ? `file:${chosenFile.name}:${chosenFile.size}:${chosenFile.lastModified}` : ''; }
  function restoreOutcome() { const key = sourceKey(); imported = importedSources.get(key); uncertain = uncertainSources.has(key); }
  function updateControls() {
    if (disposed) return;
    for (const node of [address, connect, loadSaved, refresh, search, choose, fileInput, archiveTab, fileTab, historyTab, noAvatarInput, sourceLink]) node.disabled = busy;
    loadLink.disabled = busy || !sourceLink.value.trim();
    useExisting.hidden = !pendingHistory; useExisting.disabled = busy;
    retry.hidden = !uncertain; retry.disabled = busy;
    importButton.disabled = busy || uncertain || !!imported || !(mode === 'archive' ? selected : chosenFile);
    importButton.textContent = busy ? 'Working…' : imported ? 'Imported' : 'Import to Lumiverse';
    success.hidden = guideVisible || mode === 'history' || !imported; successText.textContent = imported ? `${imported.name} is in your library.` : '';
    nextHistory.disabled = busy; backToGuide.disabled = busy; closeGuide.disabled = busy; guide.setBusy(busy);
    guide.root.hidden = !guideVisible; backToGuide.hidden = guideVisible; closeGuide.hidden = !guideVisible; tabs.hidden = guideVisible;
    connectionPanel.hidden = guideVisible || mode !== 'archive';
    eyebrow.hidden = guideVisible; heading.hidden = guideVisible; intro.hidden = guideVisible;
    archivePanel.hidden = guideVisible || mode !== 'archive'; filePanel.hidden = guideVisible || mode !== 'file'; historyPanel.hidden = guideVisible || mode !== 'history';
    actions.hidden = guideVisible || mode === 'history' || !(selected || chosenFile); status.hidden = guideVisible || mode === 'history' || !status.textContent;
    preview.hidden = guideVisible || mode === 'history' || !selected;
    lorebooks.setBusy(busy); lorebooks.root.hidden = guideVisible || mode !== 'archive' || !selected;
    continueHistory.hidden = !returnToHistory || !connected; continueHistory.disabled = busy;
    root.setAttribute('aria-busy', String(busy));
  }
  function resetSelection() { lorebooks.hide(); selected = undefined; chosenFile = undefined; imported = undefined; uncertain = false; pendingHistory = undefined; preview.hidden = true; noAvatar.hidden = true; noAvatarInput.checked = false; fileName.textContent = 'No file selected'; success.hidden = true; }
  function showGuide() {
    if (disposed || busy) return;
    generation++; client.cancel(); chatHistory.deactivate(); guideVisible = true; updateControls();
  }
  function hideGuide() {
    if (disposed || busy) return;
    guideVisible = false; if (mode === 'history') chatHistory.activate(); updateControls();
    backToGuide.focus({ preventScroll: true }); root.scrollIntoView?.({ block: 'start', behavior: 'auto' });
  }
  function switchMode(next: typeof mode, historyStart?: HistoryStart) {
    if (disposed || busy) return;
    generation++; client.cancel(); guideVisible = false; returnToHistory = false; mode = next; resetSelection();
    archivePanel.hidden = next !== 'archive'; filePanel.hidden = next !== 'file'; historyPanel.hidden = next !== 'history';
    for (const [node, , kind] of sourceTabs) { node.setAttribute('aria-selected', String(next === kind)); node.tabIndex = next === kind ? 0 : -1; }
    actions.hidden = true; status.hidden = next === 'history';
    if (next === 'history') chatHistory.activate(historyStart); else chatHistory.deactivate();
    message(''); renderList(); updateControls();
  }
  async function permission(permission: 'cors_proxy') {
    let granted = await ctx.permissions.getGranted();
    if (disposed) return false;
    if (!granted.includes(permission)) granted = await requestPermissions(ctx, [permission], 'Read saved content or load the JanitorAI link you choose through your local JAR service. This does not send chat messages or access JAR settings.');
    return !disposed && granted.includes(permission);
  }
  async function previewLink(carriedHistory?: JarHistoryResult) {
    if (disposed || busy || !sourceLink.value.trim()) return;
    let source: ReturnType<typeof parseJanitorLink>, endpoint: string;
    try { source = parseJanitorLink(sourceLink.value); endpoint = normalizeJarBase(address.value.trim()); }
    catch (error) { message(error instanceof Error ? error.message : 'Paste a JanitorAI character or chat link.', 'error'); return; }
    const token = ++generation;
    resetSelection(); busy = true; updateControls(); renderList(); message(source.kind === 'chat' ? 'JAR is loading this conversation and its character…' : 'JAR is loading this character card…');
    let historyStart: HistoryStart | undefined;
    try {
      if (!await permission('cors_proxy')) { message('Allow local JAR access to preview this link.', 'warning'); return; }
      if (disposed || token !== generation) return;
      const result = await client.requestLink(endpoint, source.sourceUrl);
      if (disposed || token !== generation) return;
      if (result.sourceUrl !== source.sourceUrl || result.kind !== source.kind) throw new Error('JAR returned a different link. Nothing was imported.');
      if (result.characterUrl) {
        const alias = `janitor-character:${endpoint}:${result.characterUrl}`;
        aliasRecord(endpoint, result.recordId, alias);
        if (result.card) aliasRecord(endpoint, result.card.recordId, alias);
      }
      if (!captures.some(item => item.id === result.recordId)) captures.unshift({ id: result.recordId, name: result.card?.name || result.history?.characterName || 'Character from link', source: 'JanitorAI link', ts: Date.now() });
      pendingHistory = result.history || carriedHistory;
      if (result.card) {
        selected = result.card; restoreOutcome(); renderPreview();
        message(uncertain ? 'An earlier import could not be confirmed. Check your character library before retrying.' : imported ? 'This character is already imported. You can continue to its history.' : pendingHistory ? 'Card and conversation loaded. Review and import the card, then choose Next: import chat history. No need to paste the link again.' : 'Review the card, then choose Import to Lumiverse.');
      } else if (result.history) {
        historyStart = { source: 'jar', recordId: result.recordId, preparedHistory: result.history, character: importedSources.get(recordKey(result.recordId)), notice: result.warning || 'The conversation loaded, but its character card is incomplete. Choose its existing Lumiverse character, or get a card first.', characterUrl: result.characterUrl };
      } else message(result.warning || 'This link did not provide a complete character card. Try a downloaded card file instead.', 'warning');
    } catch (error) { if (!isAbort(error) && !disposed && token === generation) message(error instanceof Error ? error.message : 'Could not preview this link. Check JAR and its JanitorAI sign-in.', 'error'); }
    finally { if (!disposed && token === generation) { busy = false; renderList(); updateControls(); } }
    if (!historyStart && token === generation) syncLorebooks();
    if (historyStart && !disposed && token === generation) switchMode('history', historyStart);
    else if (!disposed && token === generation) {
      if (selected) { previewName.focus({ preventScroll: true }); preview.scrollIntoView?.({ block: 'start', behavior: 'auto' }); }
      else status.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    }
  }
  async function checkConnection() {
    if (disposed || busy) return;
    const token = ++generation; busy = true; updateControls(); message('Checking your local JAR…');
    try {
      if (!await permission('cors_proxy')) { message('Allow local JAR access to check the connection.', 'warning'); return; }
      if (disposed || token !== generation) return;
      const result = object(await client.request('check', address.value.trim()));
      if (disposed || token !== generation) return;
      connectedLabel.textContent = `JAR ${result.version} is running · ${normalizeJarBase(address.value)}`;
      connectionHelp.open = false;
      message('JAR is reachable. To load JanitorAI links, sign in using JAR’s Log in button first.');
    } catch (error) {
      if (!disposed && token === generation && !isAbort(error)) {
        connected = false; connectedLabel.textContent = 'JAR connection could not be confirmed'; connectionHelp.open = true;
        message(error instanceof Error ? error.message : 'Could not reach JAR. Start it and keep its console open.', 'error');
      }
    } finally { if (!disposed && token === generation) { busy = false; updateControls(); } }
  }
  async function load(first: boolean) {
    if (disposed || busy) return;
    const token = ++generation; resetSelection(); busy = true; updateControls(); message('Connecting to your local JAR…');
    try {
      if (!await permission('cors_proxy')) { message('Allow local JAR access to connect.', 'warning'); return; }
      if (disposed || token !== generation) return;
      const result = object(await client.request(first || !connected ? 'connect' : 'list', address.value.trim()));
      if (disposed || token !== generation) return;
      if (!Array.isArray(result.captures)) throw new Error('JAR returned an unreadable character list.');
      captures = result.captures as JarSummary[]; connected = true;
      connectedLabel.textContent = typeof result.version === 'string' ? `Connected · JAR ${result.version}` : 'Connected to JAR';
      connectionHelp.open = false;
      results.hidden = false; renderList(); message(captures.length ? 'Choose a character to preview.' : 'JAR is running. This copy has no saved cards yet. Paste a JanitorAI link to load a character, or choose Import card file.');
    } catch (error) { if (!isAbort(error)) { connected = false; captures = []; results.hidden = true; connectedLabel.textContent = 'Could not load saved JAR cards'; connectionHelp.open = true; message(error instanceof Error ? error.message : 'Could not connect to JAR.', 'error'); } }
    finally { if (!disposed && token === generation) { busy = false; renderList(); updateControls(); } }
  }
  address.addEventListener('input', () => { if (busy) return; generation++; client.cancel(); connected = false; captures = []; results.hidden = true; connectedLabel.textContent = 'Not connected'; resetSelection(); message('Connect to the new local address to load its saved characters.'); updateControls(); });
  function renderList() {
    list.replaceChildren(); const query = search.value.trim().toLowerCase(); const rows = captures.filter(item => item.name.toLowerCase().includes(query));
    count.textContent = `Saved characters · ${captures.length}`;
    if (!rows.length) list.append(el('p', 'jar-help', query ? 'No characters match your search.' : 'No saved characters.'));
    for (const item of rows) {
      const row = button('', () => { void select(item); }, 'jar-character'); row.disabled = busy; row.setAttribute('aria-pressed', String(selected?.recordId === item.id));
      const monogram = el('span', 'jar-monogram', item.name.slice(0, 1).toUpperCase()); const text = el('span', 'jar-character-text'); text.append(el('strong', '', item.name), el('small', '', item.source || 'Saved in JAR')); row.append(monogram, text, el('span', 'jar-chevron', '›')); list.append(row);
    }
  }
  async function select(item: JarSummary) {
    if (busy || disposed) return;
    const token = ++generation; resetSelection(); busy = true; updateControls(); renderList(); message(`Loading ${item.name}…`);
    try {
      const result = await client.request('card', address.value.trim(), item.id) as JarCardResult;
      if (disposed || token !== generation) return;
      if (!result || result.recordId !== item.id || !result.card?.data) throw new Error('This card could not be previewed. Refresh the list.');
      selected = result; restoreOutcome(); renderPreview(); message(uncertain ? 'An earlier import could not be confirmed. Check your character library before retrying.' : imported ? 'This character has already been imported.' : 'Review the card, then choose Import to Lumiverse.');
    } catch (error) { if (!isAbort(error)) message(error instanceof Error ? error.message : 'Finish/export the character in JAR, then use Import card file.', 'error'); }
    finally { if (!disposed && token === generation) { busy = false; renderList(); updateControls(); } }
    if (token === generation) syncLorebooks();
  }
  function renderPreview() {
    if (!selected) return; const data = selected.card.data; preview.hidden = false; portrait.replaceChildren();
    if (selected.avatarDataUrl && /^data:image\/(png|jpeg|webp);base64,/i.test(selected.avatarDataUrl)) { const image = el('img'); image.src = selected.avatarDataUrl; image.alt = `${data.name} portrait`; image.addEventListener('error', () => { image.remove(); portrait.textContent = data.name.slice(0, 1); }); portrait.append(image); }
    else portrait.textContent = data.name.slice(0, 1);
    previewName.textContent = data.name; previewMeta.textContent = `${selected.avatarDataUrl ? 'Portrait included' : 'No saved portrait'} · ${data.alternate_greetings.length + (data.first_mes ? 1 : 0)} greeting(s)`;
    warnings.hidden = !selected.warnings?.length; warnings.textContent = selected.warnings?.join(' ') || '';
    sections.replaceChildren();
    const fields = [['Description', data.description], ['Personality', data.personality], ['Scenario', data.scenario], ['First message', data.first_mes], ['Example messages', data.mes_example], ['Creator notes', data.creator_notes], ['System prompt', data.system_prompt], ['After-chat instructions', data.post_history_instructions], ...data.alternate_greetings.map((text, i) => [`Alternate greeting ${i + 1}`, text])];
    for (const [label, text] of fields) { if (!text) continue; const details = el('details'); details.open = label === 'Description'; details.append(el('summary', '', label), el('p', '', text)); sections.append(details); }
    if (data.character_book) sections.append(el('p', 'jar-help', 'Embedded character lorebook included.'));
  }
  function acceptFile(file?: File) {
    if (!file || disposed || busy) return;
    if (!/\.(png|json|charx)$/i.test(file.name) || !file.size) { message('Choose a nonempty PNG, JSON, or CHARX card export.', 'error'); return; }
    resetSelection(); chosenFile = file; restoreOutcome(); fileName.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`; message(uncertain ? 'An earlier import could not be confirmed. Check your character library before retrying.' : imported ? 'This file has already been imported.' : 'Card selected. Choose Import to add it to your library.'); updateControls();
  }
  async function runImport() {
    if (disposed || busy || uncertain || imported || !(mode === 'archive' ? selected : chosenFile)) return;
    const token = generation, card = selected, file = chosenFile, key = sourceKey(), omit = noAvatarInput.checked;
    busy = true; updateControls(); renderList(); message('Preparing your character…');
    try {
      const result = await importNativeCard(ctx, () => card ? createCardFile(card.card, omit ? null : card.avatarDataUrl) : Promise.resolve(file!), () => !disposed && token === generation, abort.signal);
      importedSources.set(key, result); uncertainSources.delete(key);
      if (disposed || token !== generation) return;
      imported = result; lorebooks.setCharacter(result); message('Imported. You can use this character with your normal Lumiverse settings.', 'success');
      try { ctx.events.emit('jar_bridge:imported', { characterId: result.id }); } catch { /* A notification failure must never retry the imported card. */ }
    } catch (error) {
      if (disposed || token !== generation || isAbort(error)) return;
      if (error instanceof CardFileError && error.code !== 'invalid_card') { noAvatar.hidden = false; message(`${error.message} You can choose “Import without portrait” and try again.`, 'warning'); }
      else { uncertain = error instanceof ImportError && error.uncertain; if (uncertain) uncertainSources.add(key); message(error instanceof Error ? error.message : 'The card could not be imported.', 'error'); }
    } finally { if (!disposed && token === generation) { busy = false; renderList(); updateControls(); } }
  }
  switchMode('archive');
  const stopOpen = ctx.events.on('jar_bridge:open_import', openWindow);
  const stopActivation = tab.onActivate(openWindow);
  return () => { disposed = true; generation++; abort.abort(); stopOpen(); stopActivation(); window?.dismiss(); guide.destroy(); chatHistory.destroy(); lorebooks.destroy(); client.dispose(); tab.destroy(); removeStyle(); };
}
