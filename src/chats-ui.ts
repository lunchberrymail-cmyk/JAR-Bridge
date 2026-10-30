import type { SpindleFrontendContext } from 'lumiverse-spindle-types';
import { requestPermissions } from './permissions';
import { contentHash } from './content-hash';
import type { JarSummary } from './jar-adapter';
import type { createJarClient } from './client';
import { normalizeJarBase } from './transport';
import { parseChatFile, parseChatHistory, type PreparedChat } from './chat-file';
import { importNativeChat, ChatImportError, type ImportedChat } from './chat-import';
import type { JarHistoryResult } from './conversation-adapter';
import { parseJanitorLink } from './janitor-link';

type Conversation = { chatId: string; title: string; messageCount: number; updatedAt?: string | number; createdAt?: string | number };
type Options = {
  client: ReturnType<typeof createJarClient>;
  getCaptures(): JarSummary[];
  getBaseUrl(): string;
  getImportedCharacter(recordId: string): { id: string; name: string } | undefined;
  openArchive(): void;
  onBusy(busy: boolean): void;
  onNavigate?(): void;
  openCharacterLink?(url: string, history: JarHistoryResult): void;
};
type Character = { id: string; name: string };
export type HistoryStart = { recordId?: string; character?: Character; source?: 'jar' | 'file'; preparedHistory?: JarHistoryResult; notice?: string; characterUrl?: string };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, click: () => void, cls = 'jar-button') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', click); return node; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function aborted(error: unknown) { return error instanceof Error && error.name === 'AbortError'; }

/** Chat history is previewed separately from character-card imports. */
export function createChatHistory(ctx: SpindleFrontendContext, options: Options) {
  let disposed = false, busy = false, active = false, epoch = 0, source: 'jar' | 'file' = 'jar';
  let prepared: PreparedChat | undefined, sourceId = '', conversations: Conversation[] = [];
  let saved: ImportedChat | undefined, characters: Character[] = [], characterOffset = 0, characterTotal = 0;
  let selectedRecord = '', base = '';
  let preferredCharacter: Character | undefined;
  let linkedHistory: JarHistoryResult | undefined, sourceCharacterUrl = '';
  let activated = false, charactersLoaded = false;
  const completed = new Map<string, ImportedChat>(), unconfirmed = new Set<string>();
  const abort = new AbortController();
  const root = el('section', 'jar-history');
  root.append(el('h2', 'jar-history-heading', 'Pick up where you left off.'), el('p', 'jar-help', 'Preview a conversation, choose its character, and continue it as a normal Lumiverse chat.'));
  const sources = el('div', 'jar-history-sources');
  const fromJar = button('From JAR', () => changeSource('jar'), 'jar-link'); const fromFile = button('History file', () => changeSource('file'), 'jar-link');
  sources.append(fromJar, fromFile);
  const jarPanel = el('div', 'jar-history-jar');
  const directField = el('label', 'jar-field'); directField.htmlFor = 'jar-chat-link';
  const directLink = el('input', 'jar-input'); directLink.id = 'jar-chat-link'; directLink.type = 'url'; directLink.maxLength = 4096; directLink.autocomplete = 'off'; directLink.spellcheck = false; directLink.placeholder = 'https://janitorai.com/chats/…';
  directField.append(el('span', 'jar-label', 'JanitorAI conversation link'), directLink);
  const directLoad = button('Load chat', () => { void loadChatLink(); }, 'jar-button jar-primary');
  const directRow = el('div', 'jar-connect'); directRow.append(directField, directLoad);
  directLink.addEventListener('input', controls); directLink.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void loadChatLink(); } });
  const savedLinks = el('details', 'jar-saved-details jar-history-saved'); savedLinks.append(el('summary', '', 'Saved conversations in JAR'));
  const archiveHint = el('p', 'jar-help');
  const connect = button('Browse saved JAR cards', options.openArchive, 'jar-link');
  const recordField = el('label', 'jar-field'); recordField.htmlFor = 'jar-history-character';
  const recordSelect = el('select', 'jar-input'); recordSelect.id = 'jar-history-character';
  recordField.append(el('span', 'jar-label', 'Character saved in JAR'), recordSelect);
  const loadLinked = button('Load linked conversations', () => { void loadConversations(); });
  const recordRow = el('div', 'jar-connect'); recordRow.append(recordField, loadLinked);
  const linksHint = el('p', 'jar-help', 'Choose a saved character to browse its linked conversations. You can use the conversation link above without preparing it in JAR’s window.');
  const linkedList = el('div', 'jar-conversations'); linkedList.setAttribute('aria-label', 'Linked JAR conversations');
  const fetchHint = el('p', 'jar-help jar-fetch-note', 'Load history asks JAR to retrieve only that conversation through its signed-in JanitorAI browser. It does not send a chat message.');
  fetchHint.hidden = true;
  savedLinks.append(archiveHint, connect, recordRow, linksHint, linkedList, fetchHint);
  const directPanel = el('section', 'jar-history-link');
  directPanel.append(directRow, el('p', 'jar-help', 'JAR must be running and signed in on the Lumiverse server computer. Load your conversation, then review it and choose its character before importing.'));
  jarPanel.append(directPanel, savedLinks);
  const filePanel = el('div', 'jar-history-file'); filePanel.hidden = true;
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = '.jsonl,.json'; fileInput.hidden = true;
  const choose = button('Choose chat history file', () => fileInput.click(), 'jar-button jar-primary');
  const fileLabel = el('p', 'jar-file-name', 'No history file selected');
  const drop = el('div', 'jar-drop'); drop.append(el('div', 'jar-drop-icon', '↓'), el('strong', '', 'Chat history file'), el('p', 'jar-help', 'Choose a JAR JSON export or SillyTavern JSONL file.'), choose, fileInput, fileLabel);
  filePanel.append(drop);
  fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; fileInput.value = ''; if (file) void loadFile(file); });
  for (const eventName of ['dragenter', 'dragover'] as const) drop.addEventListener(eventName, event => { event.preventDefault(); if (!busy) drop.classList.add('jar-dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('jar-dragging'));
  drop.addEventListener('drop', event => { event.preventDefault(); drop.classList.remove('jar-dragging'); if (!busy && event.dataTransfer?.files[0]) void loadFile(event.dataTransfer.files[0]); });
  const review = el('section', 'jar-chat-review'); review.hidden = true;
  const cardNotice = el('div', 'jar-chat-card-notice'); cardNotice.hidden = true;
  const cardNoticeText = el('p', 'jar-warning');
  const getCard = button('Get this character’s card', () => { if (!disposed && !busy && linkedHistory && sourceCharacterUrl) options.openCharacterLink?.(sourceCharacterUrl, linkedHistory); });
  cardNotice.append(cardNoticeText, getCard);
  const titleField = el('label', 'jar-field'); titleField.htmlFor = 'jar-chat-title'; const title = el('input', 'jar-input'); title.id = 'jar-chat-title'; title.maxLength = 200;
  titleField.append(el('span', 'jar-label', 'Chat title'), title);
  const stats = el('p', 'jar-help'); const excerpts = el('div', 'jar-chat-excerpts');
  review.append(cardNotice, titleField, stats, excerpts);
  const destination = el('section', 'jar-destination');
  destination.append(el('h3', '', 'Save this chat with…'));
  const targetField = el('label', 'jar-field'); targetField.htmlFor = 'jar-chat-target';
  const target = el('select', 'jar-input'); target.id = 'jar-chat-target'; targetField.append(el('span', 'jar-label', 'Lumiverse character'), target);
  const targetSearch = el('input', 'jar-input'); targetSearch.type = 'search'; targetSearch.placeholder = 'Search your character library…'; targetSearch.setAttribute('aria-label', 'Find destination character');
  const find = button('Find', () => { characterOffset = 0; void loadCharacters(); });
  const findRow = el('div', 'jar-connect'); findRow.append(targetSearch, find);
  const characterPage = el('div', 'jar-character-page');
  const previous = button('Previous', () => { characterOffset = Math.max(0, characterOffset - 100); void loadCharacters(); }, 'jar-link');
  const pageLabel = el('span', 'jar-help');
  const next = button('Next', () => { characterOffset += 100; void loadCharacters(); }, 'jar-link'); characterPage.append(previous, pageLabel, next);
  destination.append(targetField, findRow, characterPage, el('p', 'jar-help', 'This creates a new Lumiverse conversation for the character you choose. Import its card first if it is not in your library.'));
  const status = el('p', 'jar-status jar-chat-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const done = el('div', 'jar-success'); done.hidden = true; const doneLabel = el('strong');
  const open = button('Continue chat', () => { if (saved) void navigate({ kind: 'route', id: '/chat/:chatId' }, { chatId: saved.id }); }); done.append(doneLabel, open);
  const actions = el('div', 'jar-actions');
  const library = button('My chats', () => { void navigate({ kind: 'route', id: '/' }); }, 'jar-link');
  const retry = button('I checked my chats — retry', () => { unconfirmed.delete(sourceId); message('Ready to retry. Choose Import chat to continue.'); controls(); }, 'jar-link'); retry.hidden = true;
  const save = button('Import chat', () => { void runImport(); }, 'jar-button jar-primary'); actions.append(library, retry, save);
  // A one-time tip after a chat comes through JAR; dismissing it hides it in this browser.
  const TIP_KEY = 'jar_bridge:account_tip_dismissed';
  let tipClosed = false;
  const tipDismissed = () => { try { return globalThis.localStorage?.getItem(TIP_KEY) === '1'; } catch { return false; } };
  const switchAccount = el('p', 'jar-help jar-account-reminder'); switchAccount.hidden = true;
  switchAccount.append('Tip: once your chats are recovered, switch JAR to a throwaway JanitorAI account to keep your main one safe. ',
    button('Got it', () => { tipClosed = true; try { globalThis.localStorage?.setItem(TIP_KEY, '1'); } catch { /* still hidden for this page */ } switchAccount.hidden = true; }, 'jar-link'));
  root.append(sources, jarPanel, filePanel, review, destination, status, done, switchAccount, actions);

  function message(text: string, tone = '') { if (!disposed) { status.textContent = text; status.dataset.tone = tone; } }
  function valid(token: number) { return !disposed && active && token === epoch; }
  function setBusy(value: boolean) { busy = value; if (!disposed) { options.onBusy(value); controls(); renderConversations(); } }
  async function navigate(ref: {kind: 'route';id: string}, params?: Record<string,string>) { try { if (!ctx.host.surfaces) throw new Error(); await ctx.host.surfaces.invoke(ref, params); options.onNavigate?.(); } catch { message('Open this conversation from your normal chat list.', 'warning'); } }
  function controls() {
    const missing = !options.getCaptures().length;
    for (const node of [fromJar, fromFile, choose, fileInput, recordSelect, title, target, targetSearch, find, directLink]) node.disabled = busy;
    directLoad.disabled = busy || !directLink.value.trim();
    getCard.disabled = busy; getCard.hidden = !sourceCharacterUrl || !options.openCharacterLink;
    loadLinked.disabled = busy || missing || !recordSelect.value;
    connect.disabled = busy;
    previous.disabled = busy || characterOffset === 0; next.disabled = busy || characterOffset + 100 >= characterTotal;
    save.disabled = busy || !prepared || !target.value || !!saved || unconfirmed.has(sourceId);
    save.textContent = busy ? 'Working…' : saved ? 'Imported' : 'Import chat';
    retry.hidden = !unconfirmed.has(sourceId); retry.disabled = busy;
    done.hidden = !saved; switchAccount.hidden = !saved || source !== 'jar' || tipClosed || tipDismissed(); doneLabel.textContent = saved ? `${saved.name} · ${saved.messageCount} messages imported` : '';
    destination.hidden = !prepared; actions.hidden = !prepared;
    fromJar.setAttribute('aria-pressed', String(source === 'jar')); fromFile.setAttribute('aria-pressed', String(source === 'file'));
    root.setAttribute('aria-busy', String(busy));
  }
  function clearPreview() { prepared = undefined; sourceId = ''; saved = undefined; linkedHistory = undefined; sourceCharacterUrl = ''; cardNotice.hidden = true; review.hidden = true; controls(); }
  function changeSource(nextSource: typeof source) {
    if (busy || disposed) return; epoch++; options.client.cancel(); source = nextSource; preferredCharacter = undefined; target.value = ''; clearPreview();
    jarPanel.hidden = source !== 'jar'; filePanel.hidden = source !== 'file'; message(''); controls();
  }
  function renderRecords(preferredRecord?: string) {
    const old = recordSelect.value; recordSelect.replaceChildren();
    const records = options.getCaptures();
    if (!records.length) recordSelect.append(el('option', '', 'Connect to JAR first'));
    for (const record of records) { const option = el('option', '', record.name); option.value = record.id; recordSelect.append(option); }
    if (preferredRecord && records.some(record => record.id === preferredRecord)) recordSelect.value = preferredRecord;
    else if (records.some(record => record.id === old)) recordSelect.value = old;
    let endpoint = '';
    try { endpoint = normalizeJarBase(options.getBaseUrl()); } catch { /* Connect in Saved in JAR validates the address before loading its catalog. */ }
    if ((base && base !== endpoint) || (selectedRecord && selectedRecord !== recordSelect.value && !linkedHistory)) {
      conversations = []; selectedRecord = ''; base = '';
      if (source === 'jar') { target.value = ''; clearPreview(); }
      renderConversations();
    }
    archiveHint.textContent = records.length ? 'Choose the character whose conversations you want to bring over.' : 'Browse saved JAR cards to connect to its catalog, or paste your conversation link above.';
    connect.hidden = !!records.length; recordRow.hidden = !records.length; linksHint.hidden = !records.length;
    controls();
  }
  recordSelect.addEventListener('change', () => { if (busy) return; epoch++; preferredCharacter = undefined; conversations = []; selectedRecord = ''; target.value = ''; clearPreview(); renderConversations(); message('Load the linked conversations for this character.'); suggestCharacter(); });
  target.addEventListener('change', controls);
  title.addEventListener('input', controls);
  targetSearch.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); characterOffset = 0; void loadCharacters(); } });
  async function allowJar() {
    let grants = await ctx.permissions.getGranted(); if (disposed || !active) return false;
    if (!grants.includes('cors_proxy')) grants = await requestPermissions(ctx, ['cors_proxy'], 'Read the linked conversations you choose from JAR. Loading selected history uses JAR’s signed-in JanitorAI browser.');
    return !disposed && active && grants.includes('cors_proxy');
  }
  async function loadChatLink() {
    if (busy || disposed || !active || !directLink.value.trim()) return;
    let sourceLink: ReturnType<typeof parseJanitorLink>, endpoint: string;
    try {
      sourceLink = parseJanitorLink(directLink.value);
      if (sourceLink.kind !== 'chat') throw new Error('Use your JanitorAI conversation link containing /chats/… here. Import a character page from the JanitorAI link tab.');
      endpoint = normalizeJarBase(options.getBaseUrl());
    } catch (error) { message(error instanceof Error ? error.message : 'Paste a JanitorAI conversation link.', 'error'); return; }
    const token = ++epoch; preferredCharacter = undefined; target.value = '';
    conversations = []; selectedRecord = ''; base = '';
    clearPreview(); setBusy(true); message('JAR is loading your conversation…');
    try {
      if (!await allowJar()) { if (valid(token)) message('Allow local JAR access to load this conversation.', 'warning'); return; }
      if (!valid(token)) return;
      const result = await options.client.requestLink(endpoint, sourceLink.sourceUrl);
      if (!valid(token)) return;
      if (result.kind !== 'chat' || result.sourceUrl !== sourceLink.sourceUrl || !result.history || result.history.chatId !== sourceLink.chatId || result.history.recordId !== result.recordId) throw new Error('JAR returned a different conversation. Nothing was imported.');
      const history = result.history;
      const chat = parseChatHistory(history.jsonl, `${history.characterName || 'JanitorAI conversation'}.jsonl`);
      base = endpoint; selectedRecord = result.recordId; preferredCharacter = options.getImportedCharacter(result.recordId);
      if ([...recordSelect.options].some(option => option.value === result.recordId)) recordSelect.value = result.recordId;
      showPreview(chat, `janitor-chat:${history.chatId}`);
      linkedHistory = history; sourceCharacterUrl = result.characterUrl || '';
      cardNoticeText.textContent = result.warning || 'Choose this conversation’s character from your Lumiverse library. If it is not here yet, get its card first.';
      cardNotice.hidden = !!preferredCharacter && !result.warning;
      suggestCharacter(); controls();
      review.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    } catch (error) { if (!aborted(error) && valid(token)) message(error instanceof Error ? error.message : 'Could not load this conversation. Check JAR’s JanitorAI sign-in and try again.', 'error'); }
    finally { if (valid(token)) setBusy(false); }
  }
  async function loadConversations() {
    if (busy || disposed || !recordSelect.value) return;
    const token = ++epoch, recordId = recordSelect.value; clearPreview(); conversations = []; selectedRecord = recordId; setBusy(true); message('Reading linked conversations from JAR…');
    try {
      base = normalizeJarBase(options.getBaseUrl());
      if (!await allowJar()) { message('Allow local JAR access to list conversations.', 'warning'); return; }
      if (!valid(token)) return;
      const result = object(await options.client.request('conversations', base, recordId));
      if (!valid(token)) return;
      if (result.recordId !== recordId || !Array.isArray(result.conversations)) throw new Error('JAR returned an unreadable conversation list.');
      conversations = result.conversations as Conversation[];
      message(conversations.length ? 'Choose Load history for the conversation you want to preview.' : 'No conversations are linked yet. Find or link them in JAR, then reload this list.'); suggestCharacter();
    } catch (error) { if (!aborted(error) && valid(token)) message(error instanceof Error ? error.message : 'Could not read linked conversations.', 'error'); }
    finally { if (valid(token)) setBusy(false); }
  }
  function renderConversations() {
    linkedList.replaceChildren(); fetchHint.hidden = !conversations.length;
    for (const conversation of conversations) {
      const row = el('div', 'jar-conversation'); const text = el('div');
      text.append(el('strong', '', conversation.title || `Conversation ${conversation.chatId}`), el('small', 'jar-help', `${conversation.messageCount} source messages`));
      const load = button('Load history', () => { void loadHistory(conversation); }); load.disabled = busy; row.append(text, load); linkedList.append(row);
    }
  }
  async function loadHistory(conversation: Conversation) {
    if (busy || disposed || !selectedRecord || !conversations.includes(conversation)) return;
    const token = ++epoch, recordId = selectedRecord, endpoint = base; clearPreview(); setBusy(true); message('JAR is retrieving this conversation from JanitorAI…');
    try {
      if (!await allowJar()) { message('Allow local JAR access to load selected history.', 'warning'); return; }
      if (!valid(token)) return;
      const result = object(await options.client.request('history', endpoint, recordId, conversation.chatId));
      if (!valid(token)) return;
      if (result.recordId !== recordId || result.chatId !== conversation.chatId || typeof result.jsonl !== 'string') throw new Error('JAR returned a different conversation. Reload the linked list.');
      const chat = parseChatHistory(result.jsonl, `${conversation.title || String(result.characterName || 'JAR conversation')}.jsonl`);
      showPreview(chat, `janitor-chat:${conversation.chatId}`); suggestCharacter();
    } catch (error) { if (!aborted(error) && valid(token)) message(error instanceof Error ? error.message : 'Could not load this conversation. You can export JSONL from JAR and select the file instead.', 'error'); }
    finally { if (valid(token)) setBusy(false); }
  }
  async function loadFile(file: File) {
    if (busy || disposed) return;
    const token = ++epoch; target.value = ''; clearPreview(); setBusy(true); message('Reading chat history locally…');
    try {
      const chat = await parseChatFile(file); if (!valid(token)) return;
      const key = await contentHash(JSON.stringify(chat.messages)); if (!valid(token)) return;
      const chatId = chat.metadata?.janitor_chat_id;
      const identity = chat.metadata?.imported_from === 'janitorai' && /^(?:[1-9]\d{0,31})$/.test(String(chatId)) ? `janitor-chat:${chatId}` : `chat-file:${key}`;
      fileLabel.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB`; showPreview(chat, identity); suggestCharacter();
    } catch (error) { if (!aborted(error) && valid(token)) message(error instanceof Error ? error.message : 'Choose a JAR JSON export or SillyTavern JSONL file.', 'error'); }
    finally { if (valid(token)) setBusy(false); }
  }
  function showPreview(chat: PreparedChat, key: string) {
    prepared = chat; sourceId = key; saved = completed.get(key); review.hidden = false; title.value = chat.name;
    const alternateCount = chat.messages.reduce((sum, item) => sum + Math.max(0, (item.swipes?.length || 1) - 1), 0);
    const names = [...new Set(chat.messages.map(item => item.name).filter(Boolean))].join(' · ');
    stats.textContent = `${chat.messages.length} messages · ${alternateCount} alternate replies${names ? ` · ${names}` : ''}`;
    excerpts.replaceChildren();
    for (const item of chat.messages.slice(-3)) { const excerpt = el('article', item.is_user ? 'jar-chat-line jar-chat-user' : 'jar-chat-line'); excerpt.append(el('strong', '', item.name || (item.is_user ? 'You' : 'Character')), el('p', '', item.content.length > 1200 ? item.content.slice(0, 1200) + '…' : item.content)); excerpts.append(excerpt); }
    message(saved ? 'This conversation has already been imported.' : unconfirmed.has(key) ? 'An earlier import could not be confirmed. Check My chats before retrying.' : 'Review the messages and destination character, then choose Import chat.'); controls();
  }
  function suggestCharacter() {
    const suggestion = preferredCharacter || (source === 'jar' ? options.getImportedCharacter(selectedRecord || recordSelect.value) : undefined);
    if (!suggestion) return;
    if (!characters.some(item => item.id === suggestion.id)) {
      characters.push(suggestion); const option = el('option', '', `${suggestion.name} · just imported`); option.value = suggestion.id; target.append(option);
    }
    target.value = suggestion.id; controls();
  }
  async function loadCharacters() {
    if (busy || disposed || !active) return;
    const token = ++epoch, oldTarget = target.value, oldCharacter = characters.find(item => item.id === target.value); setBusy(true);
    try {
      const query = new URLSearchParams({ limit: '100', offset: String(characterOffset), search: targetSearch.value.trim(), sort: 'name', direction: 'asc' });
      const response = await fetch(`/api/v1/characters/summary?${query}`, { credentials: 'same-origin', signal: abort.signal });
      if (!response.ok) throw new Error('Could not load your character library. Use Find to try again.');
      const result = object(await response.json()); if (!valid(token)) return;
      if (!Array.isArray(result.data)) throw new Error('Your character library returned an unreadable list.');
      characters = result.data.map(object).filter(item => typeof item.id === 'string' && typeof item.name === 'string').map(item => ({ id: String(item.id), name: String(item.name) }));
      characterTotal = typeof result.total === 'number' ? result.total : characters.length;
      charactersLoaded = true;
      target.replaceChildren(); const empty = el('option', '', 'Choose a character…'); empty.value = ''; target.append(empty);
      if (oldCharacter && !characters.some(item => item.id === oldTarget)) characters.push(oldCharacter);
      for (const character of characters) { const option = el('option', '', character.name); option.value = character.id; target.append(option); }
      if (characters.some(item => item.id === oldTarget)) target.value = oldTarget; else suggestCharacter();
      characterPage.hidden = characterTotal <= 100; pageLabel.textContent = characterTotal ? `${characterOffset + 1}–${Math.min(characterOffset + 100, characterTotal)} of ${characterTotal}` : 'No characters found';
    } catch (error) { if (!aborted(error) && valid(token)) message(error instanceof Error ? error.message : 'Could not read your character library.', 'error'); }
    finally { if (valid(token)) setBusy(false); }
  }
  async function runImport() {
    if (busy || disposed || !prepared || !target.value || saved || unconfirmed.has(sourceId)) return;
    const token = ++epoch, key = sourceId, characterId = target.value, chat = { ...prepared, name: title.value.trim() || prepared.name };
    setBusy(true); message('Importing your conversation into Lumiverse…');
    try {
      const result = await importNativeChat(ctx, chat, characterId, () => valid(token), abort.signal);
      completed.set(key, result); unconfirmed.delete(key); if (!valid(token)) return;
      saved = result; message('Imported. Continue this conversation with your normal Lumiverse settings.', 'success');
      try { ctx.events.emit('jar_bridge:chat_imported', { chatId: result.id, characterId }); } catch { /* Completion must survive another extension's notification error. */ }
    } catch (error) {
      if (!valid(token) || aborted(error)) return;
      if (error instanceof ChatImportError && error.uncertain) unconfirmed.add(key);
      message(error instanceof Error ? error.message : 'The conversation could not be imported.', 'error');
    } finally { if (valid(token)) setBusy(false); }
  }
  controls();
  return {
    root,
    activate(start?: HistoryStart) {
      if (disposed) return; active = true;
      const resuming = activated && !start; activated = true;
      if (start?.source) changeSource(start.source);
      if (start) preferredCharacter = start.character;
      if (start) target.value = '';
      renderRecords(start?.recordId);
      if (start?.preparedHistory) {
        try {
          const history = start.preparedHistory;
          const chat = parseChatHistory(history.jsonl, `${history.characterName || 'JanitorAI conversation'}.jsonl`);
          showPreview(chat, `janitor-chat:${history.chatId}`);
          linkedHistory = history; sourceCharacterUrl = start.characterUrl || '';
          cardNoticeText.textContent = start.notice || ''; cardNotice.hidden = !start.notice;
          suggestCharacter(); controls();
        } catch (error) { clearPreview(); message(error instanceof Error ? error.message : 'Could not preview this conversation.', 'error'); }
      }
      if (!resuming || !charactersLoaded) void loadCharacters(); else controls();
    },
    deactivate() { if (disposed) return; active = false; epoch++; options.client.cancel(); if (busy) { busy = false; options.onBusy(false); } },
    destroy() { disposed = true; active = false; epoch++; abort.abort(); root.remove(); },
  };
}
