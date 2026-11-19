import { withHostUuid } from './host-uuid-fixture';
import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { parseRebuiltEntries, promptMessages, replyText, withSavedRebuild, type SavedRebuild } from '../src/lumiverse-rebuild';
import { toLorebooks } from '../src/lorebook-adapter';
import { setupJarBackend } from '../src/backend';
import { createLorebooks } from '../src/lorebooks-ui';
import { createJarClient } from '../src/client';

const original = { document: globalThis.document, fetch: globalThis.fetch };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); Object.assign(globalThis, original); });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); };

const MODEL_REPLY = 'Here you go:\n```json\n{ "entries": [ { "comment": "Venderholm", "key": ["Venderholm", "the capital"], "content": "Venderholm is a rainy kingdom.", "order": 50 }, { "comment": "Empty", "key": ["x"], "content": "  " }, { "title": "Lillitch", "keys": "Lillitch, Devil", "text": "The forbidden goddess." } ] }\n```\nDone.';

describe('reading the AI reply like JAR does', () => {
  test('takes JSON out of fences and chatter, drops empty entries, accepts JAR’s loose shapes', () => {
    const entries = parseRebuiltEntries(MODEL_REPLY);
    expect(entries.map(e => [e.comment, e.key, e.content, e.order])).toEqual([
      ['Venderholm', ['Venderholm', 'the capital'], 'Venderholm is a rainy kingdom.', 50],
      ['Lillitch', ['Lillitch', 'Devil'], 'The forbidden goddess.', 100],
    ]);
    expect(entries[0]).toMatchObject({ uid: 0, selective: true, constant: false, probability: 100, keysecondary: [] });
    expect(parseRebuiltEntries('[{"key":"a","content":"b"}]')).toHaveLength(1);
    expect(parseRebuiltEntries('{"entries":{"0":{"key":["a"],"content":"b"}}}')).toHaveLength(1);
  });
  test('says clearly when the reply is unusable', () => {
    expect(() => parseRebuiltEntries('Sorry, I cannot help with that.')).toThrow('did not return a usable lorebook');
    expect(() => parseRebuiltEntries('{"entries": []}')).toThrow('returned no lorebook entries');
    expect(() => replyText({ content: '   ' })).toThrow('empty reply');
    expect(replyText({ content: 'x', model: 'deepseek' })).toEqual({ text: 'x', model: 'deepseek' });
  });
  test('only passes a well-formed prompt from JAR to the connection', () => {
    expect(promptMessages({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] })).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
    expect(() => promptMessages({ messages: [{ role: 'tool', content: 'x' }] })).toThrow('unexpected rebuild prompt');
    expect(() => promptMessages({})).toThrow('unexpected rebuild prompt');
    expect(() => promptMessages({ messages: [{ role: 'system', content: 'S' }] })).toThrow('no closed-lorebook text');
    expect(() => promptMessages({ messages: [{ role: 'user', content: 'x'.repeat(2_000_001) }] })).toThrow('too large');
  });
});

describe('showing a saved Lumiverse rebuild', () => {
  const record = (capturedAt: number, rebuilt?: number) => ({
    id: '123-abc', characterName: 'Orthea', capturedAt, payload: { messages: ['captured'] }, meta: {},
    publicLorebooks: [{ id: 'sex', title: 'Sex Module', accessible: false }],
    ...(rebuilt ? { privateLorebookReconstruction: { reconstructedAt: rebuilt, worldInfo: { entries: { 0: { key: ['old'], content: 'JAR rebuild' } } } } } : {}),
  });
  const saved = (rebuiltAt: number, capturedAt: number): SavedRebuild => ({ schemaVersion: 1, recordId: '123-abc', rebuiltAt, capturedAt, model: 'deepseek', entries: parseRebuiltEntries(MODEL_REPLY) });
  test('replaces an older JAR rebuild and is labelled as Lumiverse', () => {
    const view = withSavedRebuild(toLorebooks(record(100, 200)), saved(300, 100));
    const rebuilt = view.books.filter(book => book.kind === 'rebuilt');
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({ title: 'Sex Module (rebuilt)', model: 'Lumiverse · deepseek', rebuiltAt: 300 });
    expect(view.rebuiltAt).toBe(300);
  });
  test('is ignored once JAR has a newer capture or a newer rebuild', () => {
    expect(withSavedRebuild(toLorebooks(record(500)), saved(300, 100)).books.some(book => book.kind === 'rebuilt')).toBe(false);
    expect(withSavedRebuild(toLorebooks(record(100, 400)), saved(300, 100)).books.find(book => book.kind === 'rebuilt')!.entries[0].content).toBe('JAR rebuild');
  });
});

describe('rebuilding through the backend', () => {
  function backend(options: { granted?: string[]; reply?: unknown; preview?: (url: string) => unknown } = {}) {
    const files = new Map<string, string>();
    let handler: (payload: unknown, userId: string, sessionId?: string) => void = () => {};
    const replies: any[] = [], calls: string[] = [], generations: any[] = [];
    const record = { id: '123-abc', characterName: 'Orthea', capturedAt: 100, payload: { messages: ['captured'] }, meta: {}, publicLorebooks: [{ id: 'sex', title: 'Sex Module', accessible: false }] };
    const json = (body: unknown, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const api: any = {
      host: { extensionInstallationId: 'installed-one', capabilities: { 'frontend-session-routing-v1': 1 } },
      storage: {
        read: async (path: string) => { if (path === 'installation.json') return JSON.stringify({ schemaVersion: 1, ownerUserId: 'owner', installationId: 'installed-one' }); if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        write: async (path: string, data: string) => { files.set(path, data); }, delete: async (path: string) => { files.delete(path); },
      },
      users: { getRole: async () => 'user' },
      permissions: { getGranted: async () => options.granted ?? ['cors_proxy', 'generation'] },
      cors: async (url: string, request: any) => { calls.push(`${request.method} ${url}`); return url.endsWith('/api/extract-preview') ? (options.preview?.(url) ?? json({ messages: [{ role: 'system', content: 'Rebuild rules' }, { role: 'user', content: 'CLOSED LORE TEXT' }] })) : json(record); },
      generate: { quiet: async (input: any) => { generations.push(input); return options.reply ?? { content: MODEL_REPLY, model: 'deepseek-v4-flash' }; } },
      onFrontendMessage: (fn: typeof handler) => { handler = fn; return () => {}; },
      sendToFrontend: (payload: unknown) => { replies.push(payload); },
    };
    cleanups.push(setupJarBackend(api));
    const send = (payload: any) => handler({ type: 'jar_bridge:request', ...payload }, 'owner', 'tab-one');
    const result = async (id: string) => { for (let i = 0; i < 50 && !replies.some(r => r.id === id); i++) await settle(); return replies.find(r => r.id === id); };
    return { files, calls, generations, send, result };
  }

  test('sends JAR’s own rebuild prompt to the user’s connection and keeps the result', async () => {
    const f = backend();
    f.send({ id: 'r1', command: 'rebuild-lumiverse', recordId: '123-abc' });
    const reply = await f.result('r1');
    expect(reply.error).toBeUndefined();
    expect(f.calls).toContain('POST http://127.0.0.1:4577/api/extract-preview');
    expect(f.calls.some(call => call.endsWith('/api/extract'))).toBe(false);
    expect(f.generations).toHaveLength(1);
    expect(f.generations[0]).toMatchObject({ type: 'quiet', messages: [{ role: 'system', content: 'Rebuild rules' }, { role: 'user', content: 'CLOSED LORE TEXT' }], parameters: { temperature: 0.2 }, userId: 'owner' });
    expect(f.generations[0].signal).toBeInstanceOf(AbortSignal);
    const book = reply.result.lorebooks.books.find((b: any) => b.kind === 'rebuilt');
    expect(book).toMatchObject({ title: 'Sex Module (rebuilt)', model: 'Lumiverse · deepseek-v4-flash' });
    expect(book.entries.map((e: any) => e.comment)).toEqual(['Venderholm', 'Lillitch']);
    expect(f.files.has('rebuilt-123-abc.json')).toBe(true);
    // A later read shows it again without another AI call.
    f.send({ id: 'r2', command: 'lorebooks', recordId: '123-abc' });
    expect((await f.result('r2')).result.books.some((b: any) => b.kind === 'rebuilt')).toBe(true);
    expect(f.generations).toHaveLength(1);
  });

  test('needs the Generation permission and sends nothing without it', async () => {
    const f = backend({ granted: ['cors_proxy'] });
    f.send({ id: 'p1', command: 'rebuild-lumiverse', recordId: '123-abc' });
    expect((await f.result('p1')).error).toContain('Allow Generation');
    expect(f.generations).toEqual([]);
    expect(f.calls.some(call => call.endsWith('/api/extract-preview'))).toBe(false);
  });

  test('explains an unusable reply and an older JAR without the prompt endpoint', async () => {
    const bad = backend({ reply: { content: 'I cannot do that.' } });
    bad.send({ id: 'b1', command: 'rebuild-lumiverse', recordId: '123-abc' });
    expect((await bad.result('b1')).error).toContain('did not return a usable lorebook');
    expect(bad.files.has('rebuilt-123-abc.json')).toBe(false);
    const old = backend({ preview: () => ({ status: 404, headers: { 'content-type': 'text/html' }, body: 'Cannot POST /api/extract-preview' }) });
    old.send({ id: 'o1', command: 'rebuild-lumiverse', recordId: '123-abc' });
    expect((await old.result('o1')).error).toContain('Make sure JAR is up to date');
    expect(old.generations).toEqual([]);
  });
});

test('the panel offers Rebuild with Lumiverse’s AI, asks for Generation, then sends the rebuild', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
  let receive: (payload: unknown) => void = () => {};
  const requests: any[] = [], asked: string[][] = [];
  let granted = ['cors_proxy', 'characters', 'world_books'];
  const books = { recordId: 'record-1', characterName: 'Orthea', allowProxy: true, captured: true, capturedAt: 10, rebuiltAt: 0, closedTitles: ['Sex Module'], books: [] as any[] };
  const rebuilt = { ...books, rebuiltAt: 20, books: [{ key: 'rebuilt:lumiverse:20', kind: 'rebuilt', title: 'Sex Module (rebuilt)', description: '', entries: [{ key: ['V'], content: 'Lore' }], model: 'Lumiverse', rebuiltAt: 20 }] };
  const ctx: any = {
    permissions: { getGranted: async () => granted, request: async (list: string[]) => { asked.push(list); granted = [...granted, ...list]; return granted; } },
    onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
    sendToBackend: (request: any) => { requests.push(request); if (request.command === 'cancel') return;
      const result = request.command === 'rebuild-lumiverse' ? { state: 'done', lorebooks: rebuilt } : books;
      setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result }), 0); },
  };
  globalThis.fetch = (async () => Response.json({ data: [] })) as any;
  const client = createJarClient(withHostUuid(ctx));
  const ui = createLorebooks(ctx, { client, getBaseUrl: () => 'http://localhost:4577', onBusy() {} });
  document.body.append(ui.root); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
  const button = (text: string) => [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text && !node.hidden);
  ui.show('record-1'); await settle();
  expect(ui.root.textContent).toContain('with your Lumiverse AI or JAR’s LLM');
  button('Rebuild with Lumiverse’s AI…')!.click(); await settle();
  expect(ui.root.textContent).toContain('the AI connection you chat with in Lumiverse');
  expect(requests.some(r => r.command === 'rebuild-lumiverse')).toBe(false);
  button('Yes, rebuild')!.click(); for (let i = 0; i < 3; i++) await settle();
  expect(asked).toEqual([['generation']]);
  expect(requests.filter(r => r.command === 'rebuild-lumiverse')).toEqual([expect.objectContaining({ recordId: 'record-1' })]);
  expect(ui.root.textContent).toContain('Rebuilt. Review the entries');
  expect(ui.root.textContent).toContain('Sex Module (rebuilt)');
});
