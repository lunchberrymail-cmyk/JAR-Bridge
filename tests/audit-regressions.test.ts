import { afterEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createLorebooks } from '../src/lorebooks-ui';
import { createJarClient } from '../src/client';
import { setup } from '../src/frontend';
import { parseChatHistory } from '../src/chat-file';

// Reproductions from the 29 October 2026 staging audit, asserting the fixed behavior.
const cleanups: (() => void)[] = [];
const original = { document: globalThis.document, fetch: globalThis.fetch };
afterEach(() => { while (cleanups.length) cleanups.pop()!(); Object.assign(globalThis, original); });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); };

test('a lorebook imported before its character is attached, not imported twice, once the card is imported', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
  const requests: any[] = [], posts: any[] = [];
  let receive: (payload: unknown) => void = () => {};
  const books = { recordId: 'record-1', characterName: 'Arthur', allowProxy: true, captured: false, capturedAt: 0, rebuiltAt: 0, closedTitles: [], books: [{ key: 'public:book-1', kind: 'public', title: 'World', description: '', entries: [{ key: ['World'], content: 'Lore' }] }] };
  const ctx: any = {
    permissions: { getGranted: async () => ['cors_proxy', 'characters', 'world_books'] },
    onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
    sendToBackend: (request: any) => { requests.push(request); if (request.command === 'cancel') return;
      const result = request.command === 'lorebooks' ? books : { characterId: request.characterId, worldBookIds: [request.worldBookId] };
      setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result }), 0); },
  };
  globalThis.fetch = (async (url: string, init: any) => {
    if (url.startsWith('/api/v1/characters/summary')) return Response.json({ data: [] });
    posts.push(JSON.parse(init.body).name); return Response.json({ world_book: { id: 'native-book-1', name: 'World' }, entry_count: 1 }, { status: 201 });
  }) as any;
  const client = createJarClient(ctx);
  const ui = createLorebooks(ctx, { client, getBaseUrl: () => 'http://localhost:4577', onBusy() {} });
  document.body.append(ui.banner, ui.root); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
  ui.show('record-1'); await settle();
  ui.root.querySelector<HTMLButtonElement>('.jar-lorebook button.jar-primary')!.click(); await settle();
  expect(posts).toEqual(['World']);
  ui.setCharacter({ id: 'native-char-1', name: 'Arthur' }); for (let i = 0; i < 5; i++) await settle();
  expect(posts).toEqual(['World']);
  expect(requests.filter(r => r.command === 'attach-lorebook')).toEqual([expect.objectContaining({ characterId: 'native-char-1', worldBookId: 'native-book-1' })]);
  expect(ui.banner.textContent).toContain('Attached to Arthur');
});

test('a book imported on its own gets an attach-only button once a character is chosen', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
  const requests: any[] = [], posts: string[] = [];
  let receive: (payload: unknown) => void = () => {};
  const books = { recordId: 'record-1', characterName: 'Arthur', allowProxy: true, captured: true, capturedAt: 1, rebuiltAt: 2, closedTitles: ['Closed'], books: [{ key: 'rebuilt', kind: 'rebuilt', title: 'Closed (rebuilt)', description: '', entries: [{ key: ['C'], content: 'Lore' }] }] };
  const ctx: any = {
    permissions: { getGranted: async () => ['cors_proxy', 'characters', 'world_books'] },
    onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
    sendToBackend: (request: any) => { requests.push(request); if (request.command === 'cancel') return;
      const result = request.command === 'lorebooks' ? books : { characterId: request.characterId, worldBookIds: [request.worldBookId] };
      setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result }), 0); },
  };
  globalThis.fetch = (async (url: string, init: any) => {
    if (url.startsWith('/api/v1/characters/summary')) return Response.json({ data: [] });
    posts.push(JSON.parse(init.body).name); return Response.json({ world_book: { id: 'native-book-9', name: 'Closed (rebuilt)' }, entry_count: 1 }, { status: 201 });
  }) as any;
  const client = createJarClient(ctx);
  const ui = createLorebooks(ctx, { client, getBaseUrl: () => 'http://localhost:4577', onBusy() {} });
  document.body.append(ui.root); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
  const button = (text: string) => [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text);
  ui.show('record-1'); await settle();
  button('Import rebuilt lorebook')!.click(); await settle();
  expect(posts).toEqual(['Closed (rebuilt)']);
  ui.setCharacter({ id: 'native-char-2', name: 'Arthur' }); await settle();
  // Rebuilt books are never attached automatically; the prompt offers to attach the existing book.
  expect(requests.some(r => r.command === 'attach-lorebook')).toBe(false);
  expect(ui.root.textContent).toContain('is in your World Info but not attached to Arthur');
  button('Attach to Arthur')!.click(); for (let i = 0; i < 3; i++) await settle();
  expect(posts).toEqual(['Closed (rebuilt)']);
  expect(requests.find(r => r.command === 'attach-lorebook')).toMatchObject({ characterId: 'native-char-2', worldBookId: 'native-book-9' });
  expect(ui.root.querySelector<HTMLElement>('.jar-lorebook-callout')!.hidden).toBe(true);
});

test('two different card files sharing a name, size and date are imported separately', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
  const imported: string[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const form = init.body as FormData; const file = form.get('file') as File;
    const name = JSON.parse(await file.text()).name ?? JSON.parse(await file.text()).data?.name;
    imported.push(name); return Response.json({ character: { id: `native-${name}`, name } }, { status: 201 });
  }) as any;
  const root = document.createElement('section'); document.body.append(root);
  const destroy = setup({
    dom: { addStyle: () => () => {} },
    ui: { registerDrawerTab: () => ({ root, onActivate: () => () => {}, destroy() { root.remove(); } }) },
    events: { on: () => () => {}, emit() {} },
    permissions: { getGranted: async () => ['cors_proxy', 'characters', 'world_books'] },
    onBackendMessage: () => () => {}, sendToBackend() {},
  } as any);
  cleanups.push(() => { destroy(); dom.window.close(); });
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Import card file')!.click();
  const input = document.querySelector<HTMLInputElement>('.jar-drop input[type=file]')!;
  const choose = (file: File) => { Object.defineProperty(input, 'files', { configurable: true, value: [file] }); input.dispatchEvent(new dom.window.Event('change')); };
  const go = () => document.querySelector<HTMLButtonElement>('.jar-main-actions .jar-primary')!;
  const a = new File([JSON.stringify({ name: 'Alice', description: 'AAA' })], 'card.json', { lastModified: 1700000000000 });
  const b = new File([JSON.stringify({ name: 'Bruce', description: 'BBB' })], 'card.json', { lastModified: 1700000000000 });
  expect(a.size).toBe(b.size);
  choose(a); await settle(); go().click(); await settle();
  expect(imported).toHaveLength(1);
  choose(b); await settle();
  expect(go().textContent).toBe('Import to Lumiverse'); expect(go().disabled).toBe(false);
  go().click(); await settle();
  expect(imported).toHaveLength(2);
  choose(a); await settle();
  expect(go().textContent).toBe('Imported');
});

test('SillyTavern history files with humanized dates and alternate greetings import', () => {
  const header = { user_name: 'User', character_name: 'Character', create_date: '2025-01-01@10h00m00s000ms', chat_metadata: {} };
  const greeting = { name: 'Character', is_user: false, is_system: false, send_date: 'October 29, 2026 6:07pm', mes: 'Greeting', extra: {}, swipe_id: 0, swipes: ['Greeting', 'Alternative'], swipe_info: [] };
  const result = parseChatHistory([header, greeting].map(value => JSON.stringify(value)).join('\n'), 'example.jsonl');
  expect(result.created_at).toBe(Math.floor(new Date(2025, 0, 1, 10, 0, 0).getTime() / 1000));
  expect(result.messages[0].swipes).toEqual(['Greeting', 'Alternative']);
  expect(result.messages[0].send_date).toBe(Math.floor(new Date(2026, 9, 29, 18, 7).getTime() / 1000));
  expect(result.messages[0].swipe_dates).toEqual([result.messages[0].send_date, result.messages[0].send_date]);
  // Older unpadded files with spaces also parse; impossible dates and extra details still fail.
  expect(parseChatHistory([{ ...header, create_date: '2023-5-1 @14h 5m 3s 12ms' }, greeting].map(value => JSON.stringify(value)).join('\n'), 'x.jsonl').created_at)
    .toBe(Math.floor(new Date(2023, 4, 1, 14, 5, 3, 12).getTime() / 1000));
  expect(() => parseChatHistory([{ ...header, create_date: '2025-13-40@10h00m00s000ms' }, greeting].map(value => JSON.stringify(value)).join('\n'), 'x.jsonl')).toThrow('timestamp is invalid');
  expect(() => parseChatHistory([header, { ...greeting, swipe_info: [{}, {}, {}] }].map(value => JSON.stringify(value)).join('\n'), 'x.jsonl')).toThrow('alternate reply details');
});
