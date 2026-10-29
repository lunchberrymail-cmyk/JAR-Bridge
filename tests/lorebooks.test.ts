import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { setupJarBackend } from '../src/backend';
import { nativeLorebook, toLorebooks, worldInfoEntries } from '../src/lorebook-adapter';
import { createJarTransport, JarStillRunningError } from '../src/transport';
import { createJarClient } from '../src/client';
import { createLorebooks } from '../src/lorebooks-ui';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 5)); };
const entry = (content: string, extra: Record<string, unknown> = {}) => ({ uid: 0, key: ['Eclipse', 7, ''], keysecondary: [], comment: 'The Eclipse', content, constant: false, order: 100, ...extra });
const record = (extra: Record<string, unknown> = {}) => ({
  id: '123-abc', characterName: 'Arthur', meta: { allow_proxy: true }, payload: { systemPrompt: 'PRIVATE_CAPTURED_PROMPT' }, probePayload: 'PRIVATE_PROBE', capturedAt: 100,
  publicLorebooks: [
    { id: 'pub-1', title: 'MENAGERIE', description: '<p>Omegaverse &amp; world</p>', accessible: true, worldInfo: { entries: { 0: entry('Public lore'), 1: entry('   '), 2: { content: 'Second', apiKey: 'PRIVATE_KEY' } } } },
    { id: 'closed-1', title: '2028 | ECLIPSE', accessible: false, status: 404 },
  ],
  privateLorebookReconstruction: { worldInfo: { entries: { 0: entry('Rebuilt lore') } }, reconstructedAt: 200, reconstructedModel: 'deepseek-v4-flash', sourceHash: 'PRIVATE_HASH' },
  ...extra,
});
function response(body: unknown, status = 200) { return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }

describe('JAR lorebook adapter', () => {
  test('lists public and rebuilt books, names the closed book, and never returns captured prompts', () => {
    const result = toLorebooks(record());
    expect(result).toMatchObject({ recordId: '123-abc', allowProxy: true, captured: true, capturedAt: 100, rebuiltAt: 200, closedTitles: ['2028 | ECLIPSE'] });
    expect(result.books.map(book => [book.kind, book.title, book.entries.length])).toEqual([['public', 'MENAGERIE', 2], ['rebuilt', '2028 | ECLIPSE (rebuilt)', 1]]);
    expect(result.books[0].description).toBe('Omegaverse & world');
    expect(result.books[1].model).toBe('deepseek-v4-flash');
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  test('drops empty entries and non-string keywords, and accepts array entries', () => {
    const rows = worldInfoEntries({ entries: [entry('Kept'), entry(''), { content: 3 }] });
    expect(rows).toHaveLength(1); expect(rows[0].key).toEqual(['Eclipse']);
  });
  test('reports proxy refusal and an uncaptured record without inventing books', () => {
    const result = toLorebooks({ id: '123-abc', meta: { allow_proxy: false }, payload: null, publicLorebooks: [{ title: 'Closed', accessible: false }] });
    expect(result).toMatchObject({ allowProxy: false, captured: false, capturedAt: 0, rebuiltAt: 0, closedTitles: ['Closed'], books: [] });
  });
  test('native payload carries only name, description and entries', () => {
    expect(Object.keys(nativeLorebook(toLorebooks(record()).books[0]))).toEqual(['name', 'description', 'entries']);
  });
});

function fixture(options: { cors?: (url: string, request: any) => Promise<unknown>; granted?: string[]; character?: any; book?: any } = {}) {
  let handler: (payload: unknown, userId: string, sessionId?: string) => void = () => {};
  const calls: { url: string; options: any }[] = [], replies: any[] = [], updates: any[] = [];
  const api: any = {
    host: { extensionInstallationId: 'installed-one', capabilities: { 'frontend-session-routing-v1': 1 } },
    storage: { read: async () => JSON.stringify({ schemaVersion: 1, ownerUserId: 'owner', installationId: 'installed-one' }) },
    permissions: { getGranted: async () => options.granted ?? ['cors_proxy', 'characters', 'world_books'] },
    cors: async (url: string, request: any) => { calls.push({ url, options: request }); return options.cors ? options.cors(url, request) : response(record()); },
    world_books: { get: async (id: string) => options.book === undefined ? { id } : options.book },
    characters: {
      get: async (id: string) => options.character === undefined ? { id, world_book_ids: ['existing'] } : options.character,
      update: async (id: string, input: any) => { updates.push({ id, input }); return { id, world_book_ids: input.world_book_ids }; },
    },
    onFrontendMessage: (fn: typeof handler) => { handler = fn; return () => {}; },
    sendToFrontend: (payload: unknown) => { replies.push(payload); },
  };
  cleanups.push(setupJarBackend(api));
  return { calls, replies, updates, send: (payload: any) => handler({ type: 'jar_bridge:request', ...payload }, 'owner', 'tab-one') };
}

describe('JAR lorebook transport', () => {
  test('capture and rebuild use fixed POST routes with only the record ID', async () => {
    const f = fixture(); const get = createJarTransport({ permissions: { getGranted: async () => ['cors_proxy'] }, cors: async (url: string, request: any) => { f.calls.push({ url, options: request }); return response({}); } } as any, 'http://localhost', { current: () => true });
    await get({ kind: 'capture', recordId: '123-abc', force: false }); await get({ kind: 'capture', recordId: '123-abc', force: true }); await get({ kind: 'rebuild', recordId: '123-abc' });
    expect(f.calls.map(call => [call.url, call.options.method, call.options.body])).toEqual([
      ['http://127.0.0.1:4577/api/capture', 'POST', '{"id":"123-abc"}'], ['http://127.0.0.1:4577/api/capture', 'POST', '{"id":"123-abc","force":true}'], ['http://127.0.0.1:4577/api/extract', 'POST', '{"id":"123-abc"}']]);
    await expect(get({ kind: 'rebuild', recordId: '../settings' })).rejects.toThrow('Invalid');
  });
  test('a proxy timeout on capture or rebuild means JAR is still running; other routes keep the error', async () => {
    const api: any = { permissions: { getGranted: async () => ['cors_proxy'] }, cors: async () => { throw new Error('Request timed out after 30000ms PRIVATE'); } };
    const get = createJarTransport(api, 'http://localhost', { current: () => true });
    await expect(get({ kind: 'capture', recordId: '123-abc', force: false })).rejects.toBeInstanceOf(JarStillRunningError);
    await expect(get({ kind: 'rebuild', recordId: '123-abc' })).rejects.toBeInstanceOf(JarStillRunningError);
    await expect(get({ kind: 'card', recordId: '123-abc' })).rejects.toThrow('connection time limit');
  });
  test('maps proxy refusal and LLM failures to fixed guidance without echoing JAR’s text', async () => {
    const cases: [any, string, string][] = [
      [{ kind: 'capture', recordId: '123-abc', force: false }, 'This character forbids proxy generation PRIVATE', 'does not allow proxies'],
      [{ kind: 'rebuild', recordId: '123-abc' }, 'Extraction LLM is not configured (set EXTRACT_BASE_URL) PRIVATE', 'no extraction LLM set up'],
      [{ kind: 'rebuild', recordId: '123-abc' }, 'Extraction LLM HTTP 401: PRIVATE', 'rejected its API key'],
      [{ kind: 'rebuild', recordId: '123-abc' }, 'Could not parse JSON from the model. Raw response: PRIVATE', 'did not return a usable lorebook'],
    ];
    for (const [route, error, expected] of cases) {
      const get = createJarTransport({ permissions: { getGranted: async () => ['cors_proxy'] }, cors: async () => response({ error }, 500) } as any, 'http://localhost', { current: () => true });
      try { await get(route); throw new Error('Unexpected success'); }
      catch (e) { expect(String(e)).toContain(expected); expect(String(e)).not.toContain('PRIVATE'); }
    }
  });
});

describe('JAR lorebook backend commands', () => {
  test('lorebooks reads only the selected record and returns no capture data', async () => {
    const f = fixture(); f.send({ id: 'l1', command: 'lorebooks', recordId: '123-abc' }); await wait();
    expect(f.calls.map(call => call.url)).toEqual(['http://127.0.0.1:4577/api/captures/123-abc']);
    expect(f.replies[0].result.books).toHaveLength(2); expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
  });
  test('a capture that outlasts the proxy reports running with the latest record', async () => {
    const f = fixture({ cors: async url => url.endsWith('/api/capture') ? Promise.reject(new Error('Request timed out after 30000ms')) : response(record()) });
    f.send({ id: 'c1', command: 'capture-lorebook', recordId: '123-abc', force: true }); await wait(); await wait();
    expect(f.calls.map(call => call.url.replace('http://127.0.0.1:4577', ''))).toEqual(['/api/captures/123-abc', '/api/capture', '/api/captures/123-abc']);
    expect(f.calls[1].options.body).toBe('{"id":"123-abc","force":true}');
    expect(f.replies[0].result.state).toBe('running');
  });
  test('capture passes checked trigger choices to JAR and drops unknown fields', async () => {
    const f = fixture({ cors: async url => url.endsWith('/api/capture') ? response({}) : response(record()) });
    f.send({ id: 't1', command: 'capture-lorebook', recordId: '123-abc', trigger: { customText: `  Thornwood ${'x'.repeat(30_000)}`, scenario: false, card: 'no', evil: true } }); await wait(); await wait();
    const sent = JSON.parse(f.calls.find(call => call.url.endsWith('/api/capture'))!.options.body);
    expect(Object.keys(sent.trigger).sort()).toEqual(['card', 'custom', 'customText', 'greetings', 'lorebookNames', 'savedDefault', 'scenario', 'siteDescription']);
    expect(sent.trigger).toMatchObject({ custom: true, card: true, scenario: false, siteDescription: true });
    expect(sent.trigger.customText.startsWith('Thornwood x')).toBe(true); expect(sent.trigger.customText).toHaveLength(20_000);
  });
  test('capture with no trigger source and no words is refused before calling JAR', async () => {
    const f = fixture({ cors: async url => url.endsWith('/api/capture') ? response({}) : response(record()) });
    const off = { card: false, siteDescription: false, scenario: false, greetings: false, lorebookNames: false, savedDefault: false, customText: '   ' };
    f.send({ id: 't2', command: 'capture-lorebook', recordId: '123-abc', trigger: off }); await wait(); await wait();
    expect(f.calls.some(call => call.url.endsWith('/api/capture'))).toBe(false); expect(f.replies[0].error).toContain('at least one trigger source');
  });
  test('capture is refused before calling JAR when the creator forbids proxies', async () => {
    const f = fixture({ cors: async () => response(record({ meta: { allow_proxy: false } })) });
    f.send({ id: 'c2', command: 'capture-lorebook', recordId: '123-abc' }); await wait();
    expect(f.calls.map(call => call.url)).toEqual(['http://127.0.0.1:4577/api/captures/123-abc']); expect(f.replies[0].error).toContain('does not allow proxies');
  });
  test('rebuild requires a capture first and never calls the LLM route otherwise', async () => {
    const f = fixture({ cors: async () => response(record({ payload: null })) });
    f.send({ id: 'r1', command: 'rebuild-lorebook', recordId: '123-abc' }); await wait();
    expect(f.calls).toHaveLength(1); expect(f.replies[0].error).toContain('Capture the closed lorebook');
  });
  test('a fresh preview record reuses the capture of an earlier record for the same JanitorAI character', async () => {
    const uuid = '511770f6-1ed1-4ba2-b7f7-279bf506d7af';
    const records: Record<string, any> = {
      'new-1': record({ id: 'new-1', characterId: uuid, payload: null, capturedAt: undefined, privateLorebookReconstruction: undefined }),
      'other-1': record({ id: 'other-1', characterId: '00000000-0000-4000-8000-000000000001' }),
      'old-1': record({ id: 'old-1', characterId: uuid }),
    };
    const list = [{ id: 'new-1', characterName: 'Arthur', ts: 30 }, { id: 'other-1', characterName: 'Arthur', ts: 20 }, { id: 'old-1', characterName: 'Arthur', ts: 10 }, { id: 'unrelated', characterName: 'Someone', ts: 40 }];
    const f = fixture({ cors: async url => url.endsWith('/api/captures') ? response(list) : url.endsWith('/api/capture') ? response({}) : response(records[url.split('/').pop()!]) });
    f.send({ id: 'l2', command: 'lorebooks', recordId: 'new-1' }); await wait(); await wait();
    expect(f.replies[0].result).toMatchObject({ recordId: 'new-1', captured: true, earlierRecordAt: 100, earlierRecordId: 'old-1' });
    expect(f.replies[0].result.books.map((book: any) => book.kind)).toEqual(['public', 'rebuilt']);
    expect(f.calls.some(call => call.url.endsWith('/unrelated'))).toBe(false);
    f.send({ id: 'c3', command: 'capture-lorebook', recordId: 'new-1', force: true }); await wait(); await wait();
    expect(f.calls.find(call => call.url.endsWith('/api/capture'))!.options.body).toBe('{"id":"old-1","force":true}');
  });
  test('attach merges with existing lorebooks and needs no JAR request', async () => {
    const f = fixture(); f.send({ id: 'a1', command: 'attach-lorebook', characterId: 'char-1', worldBookId: 'book-1' }); await wait();
    expect(f.calls).toHaveLength(0); expect(f.updates).toEqual([{ id: 'char-1', input: { world_book_ids: ['existing', 'book-1'] } }]);
    expect(f.replies[0].result).toEqual({ characterId: 'char-1', worldBookIds: ['existing', 'book-1'] });
  });
  test('attach refuses missing permissions, unknown books and malformed IDs without updating', async () => {
    for (const [options, payload, expected] of [
      [{ granted: ['cors_proxy', 'characters'] }, { characterId: 'char-1', worldBookId: 'book-1' }, 'Allow Characters and World Books'],
      [{ book: null }, { characterId: 'char-1', worldBookId: 'book-1' }, 'no longer in your library'],
      [{}, { characterId: '../x', worldBookId: 'book-1' }, 'Choose the imported character'],
    ] as const) {
      const f = fixture(options as any); f.send({ id: 'a2', command: 'attach-lorebook', ...payload }); await wait();
      expect(f.updates).toHaveLength(0); expect(f.replies[0].error).toContain(expected);
    }
  });
});

describe('lorebook panel', () => {
  const original = { document: globalThis.document, fetch: globalThis.fetch };
  afterEach(() => { globalThis.document = original.document; globalThis.fetch = original.fetch; });
  function panel(reply: (request: any) => any, grants = ['cors_proxy', 'characters', 'world_books'], onHiddenCardCaptured?: (id: string) => void, extra: Record<string, unknown> = {}) {
    const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
    const requests: any[] = []; let receive: (payload: unknown) => void = () => {};
    const ctx: any = {
      permissions: { getGranted: async () => grants, request: async () => { throw new Error('denied'); } },
      onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
      sendToBackend: (request: any) => { requests.push(request); if (request.command === 'cancel') return; const result = reply(request); if (result !== undefined) setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, ...result }), 0); },
    };
    const client = createJarClient(ctx);
    const ui = createLorebooks(ctx, { client, getBaseUrl: () => 'http://localhost:4577', onBusy() {}, pollMs: 1, onHiddenCardCaptured, ...extra });
    document.body.append(ui.root); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
    const button = (text: string) => [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text);
    return { ui, requests, button };
  }

  test('capture runs only after confirmation and waits for JAR to record a newer capture', async () => {
    let reads = 0;
    const p = panel(request => {
      if (request.command === 'lorebooks') { reads++; return { result: toLorebooks(record(reads > 2 ? { capturedAt: 300 } : { capturedAt: 100 })) }; }
      if (request.command === 'capture-lorebook') return { result: { state: 'running', lorebooks: toLorebooks(record()) } };
    });
    p.ui.show('123-abc'); await settle();
    expect(p.requests.map(r => r.command)).toEqual(['lorebooks']);
    p.button('Capture again…')!.click(); await settle();
    expect(p.requests.some(r => r.command === 'capture-lorebook')).toBe(false);
    expect(p.ui.root.textContent).toContain('create a temporary chat');
    p.button('Yes, capture')!.click(); for (let i = 0; i < 10; i++) await settle();
    const sent = p.requests.find(r => r.command === 'capture-lorebook');
    expect(sent).toMatchObject({ recordId: '123-abc', force: true });
    expect(p.ui.root.textContent).toContain('Captured. Rebuild it');
  });

  test('importing the character card imports and attaches its public books, not the rebuilt one', async () => {
    const posted: any[] = [];
    globalThis.fetch = (async (url: string, init: any) => { posted.push({ url, body: JSON.parse(init.body) }); return Response.json({ world_book: { id: 'book-9', name: 'MENAGERIE' }, entry_count: 2 }, { status: 201 }); }) as any;
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record()) }
      : request.command === 'attach-lorebook' ? { result: { characterId: request.characterId, worldBookIds: [request.worldBookId] } } : undefined);
    p.ui.show('123-abc'); await settle();
    expect(posted).toHaveLength(0);
    p.ui.setCharacter({ id: 'char-1', name: 'Arthur' }); for (let i = 0; i < 5; i++) await settle();
    expect(posted).toHaveLength(1); expect(posted[0].url).toBe('/api/v1/world-books/import');
    expect(posted[0].body.name).toBe('MENAGERIE'); expect(posted[0].body.entries).toHaveLength(2);
    expect(p.requests.filter(r => r.command === 'attach-lorebook')).toEqual([expect.objectContaining({ characterId: 'char-1', worldBookId: 'book-9' })]);
    expect(p.ui.root.textContent).toContain('attached them to Arthur');
    const buttons = p.ui.root.querySelectorAll<HTMLButtonElement>('.jar-lorebook button.jar-primary');
    expect(buttons[0].textContent).toBe('Imported'); expect(buttons[1].textContent).toBe('Import lorebook');
    p.ui.setCharacter({ id: 'char-1', name: 'Arthur' }); await settle();
    expect(posted).toHaveLength(1);
  });

  test('a rebuilt book is offered in its own prompt and attached to the character on request', async () => {
    const posted: any[] = [];
    globalThis.fetch = (async (url: string, init: any) => { const body = JSON.parse(init.body); posted.push(body); return Response.json({ world_book: { id: `book-${posted.length}`, name: body.name }, entry_count: body.entries.length }, { status: 201 }); }) as any;
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record()) }
      : request.command === 'attach-lorebook' ? { result: { characterId: request.characterId, worldBookIds: [request.worldBookId] } } : undefined);
    p.ui.show('123-abc'); await settle();
    const callout = p.ui.root.querySelector<HTMLElement>('.jar-lorebook-callout')!;
    expect(callout.hidden).toBe(false); expect(callout.textContent).toContain('Import the character card, or choose the character you already have above');
    p.ui.setCharacter({ id: 'char-1', name: 'Arthur' }); for (let i = 0; i < 5; i++) await settle();
    expect(posted.map(book => book.name)).toEqual(['MENAGERIE']);
    p.button('Import and attach to Arthur')!.click(); for (let i = 0; i < 5; i++) await settle();
    expect(posted.map(book => book.name)).toEqual(['MENAGERIE', '2028 | ECLIPSE (rebuilt)']);
    expect(p.requests.filter(r => r.command === 'attach-lorebook').map(r => r.worldBookId)).toEqual(['book-1', 'book-2']);
    expect(callout.hidden).toBe(true);
  });

  test('a hidden card offers one capture for the definition and lorebooks, then asks for the card again', async () => {
    const recovered: string[] = [];
    const uncaptured = record({ capturedAt: undefined, payload: null, privateLorebookReconstruction: undefined });
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(uncaptured) }
      : request.command === 'capture-lorebook' ? { result: { state: 'done', lorebooks: toLorebooks(record({ capturedAt: 300, privateLorebookReconstruction: undefined })) } } : undefined,
      undefined, id => { recovered.push(id); });
    p.ui.show('123-abc', true); await settle();
    expect(p.ui.root.textContent).toContain('Hidden character definition');
    expect(p.ui.root.textContent).toContain('collects its closed lorebooks (2028 | ECLIPSE)');
    expect(p.button('Rebuild with JAR’s LLM…')?.hidden ?? true).toBe(true);
    p.button('Capture hidden card with JAR…')!.click(); await settle();
    expect(p.ui.root.textContent).toContain('also recovers the hidden character definition');
    p.button('Yes, capture')!.click(); for (let i = 0; i < 5; i++) await settle();
    expect(p.requests.find(r => r.command === 'capture-lorebook')).toMatchObject({ recordId: '123-abc' });
    expect(recovered).toEqual(['123-abc']); expect(p.ui.root.textContent).toContain('Loading the recovered card');
  });

  test('a capture without a rebuild warns that nothing closed can be imported yet', async () => {
    const twoClosed = { publicLorebooks: [{ id: 'closed-1', title: 'ONE', accessible: false }, { id: 'closed-2', title: 'TWO', accessible: false }] };
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record({ ...twoClosed, privateLorebookReconstruction: undefined })) } : undefined);
    p.ui.show('123-abc'); p.ui.setCharacter({ id: 'char-1', name: 'Arthur' }); await settle();
    const notice = p.ui.root.querySelector<HTMLElement>('.jar-lorebook-notice')!;
    expect(notice.hidden).toBe(false); expect(notice.dataset.tone).toBe('warning');
    expect(notice.textContent).toContain('Captured, not rebuilt yet');
    expect(notice.textContent).toContain('combines all 2 closed lorebooks (ONE, TWO)');
    expect(notice.textContent).toContain('Arthur was imported without the closed lorebook');
    [...notice.querySelectorAll('button')].find(b => b.textContent === 'Rebuild with JAR’s LLM…')!.click(); await settle();
    expect(p.button('Yes, rebuild')).toBeDefined();
  });

  test('a rebuilt lorebook keeps a note about missing entries and guessed keywords; no note before capture', async () => {
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record()) } : undefined);
    p.ui.show('123-abc'); await settle();
    const notice = p.ui.root.querySelector<HTMLElement>('.jar-lorebook-notice')!;
    expect(notice.hidden).toBe(false); expect(notice.dataset.tone).toBe('info');
    expect(notice.textContent).toContain('some entries can be missing');
    expect([...notice.querySelectorAll('button')].every(b => b.hidden)).toBe(true);
    const fresh = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record({ capturedAt: undefined, payload: null, privateLorebookReconstruction: undefined })) } : undefined);
    fresh.ui.show('123-abc'); await settle();
    expect(fresh.ui.root.querySelector<HTMLElement>('.jar-lorebook-notice')!.hidden).toBe(true);
  });

  test('a hidden card whose creator forbids proxies offers no capture', async () => {
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record({ meta: { allow_proxy: false }, capturedAt: undefined, payload: null, privateLorebookReconstruction: undefined })) } : undefined);
    p.ui.show('123-abc', true); await settle();
    expect(p.ui.root.textContent).toContain('cannot recover it');
    expect(p.button('Capture hidden card with JAR…')!.hidden).toBe(true);
  });

  test('books can be attached to a character already in the library, found by name', async () => {
    const posted: any[] = [], searched: string[] = [];
    globalThis.fetch = (async (url: string, init: any) => {
      if (url.startsWith('/api/v1/characters/summary')) { const search = new URL(url, 'http://x').searchParams.get('search')!; searched.push(search);
        return Response.json({ data: search === 'Arthur' ? [{ id: 'char-7', name: 'Arthur' }, { id: 'char-8', name: 'Arthur Two' }] : [{ id: 'char-9', name: 'Morgan' }] }); }
      const body = JSON.parse(init.body); posted.push(body); return Response.json({ world_book: { id: `book-${posted.length}`, name: body.name }, entry_count: body.entries.length }, { status: 201 });
    }) as any;
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record()) }
      : request.command === 'attach-lorebook' ? { result: { characterId: request.characterId, worldBookIds: [request.worldBookId] } } : undefined);
    p.ui.show('123-abc'); for (let i = 0; i < 3; i++) await settle();
    expect(searched).toEqual(['Arthur']);
    const select = p.ui.root.querySelector<HTMLSelectElement>('.jar-lorebook-picker select')!;
    expect(select.value).toBe('char-7');
    expect(posted).toHaveLength(0);
    p.button('Import and attach to Arthur')!.click(); for (let i = 0; i < 5; i++) await settle();
    expect(posted.map(book => book.name)).toEqual(['2028 | ECLIPSE (rebuilt)']);
    expect(p.requests.find(r => r.command === 'attach-lorebook')).toMatchObject({ characterId: 'char-7', worldBookId: 'book-1' });
    const search = p.ui.root.querySelector<HTMLInputElement>('.jar-lorebook-picker input')!; search.value = 'Morgan';
    p.button('Find')!.click(); for (let i = 0; i < 3; i++) await settle();
    expect([...select.options].map(o => o.textContent)).toEqual(['Do not attach (World Info only)', 'Arthur', 'Morgan']);
    select.value = ''; select.dispatchEvent(new select.ownerDocument.defaultView!.Event('change'));
    expect(p.ui.root.querySelectorAll<HTMLButtonElement>('.jar-lorebook button.jar-primary')[0].textContent).toBe('Import lorebook');
    p.ui.setCharacter({ id: 'char-1', name: 'Arthur' }); await settle();
    expect(p.ui.root.querySelector<HTMLElement>('.jar-lorebook-picker')!.hidden).toBe(true);
  });

  test('Import card and attach imports the card, then the public books and the rebuilt one, attached', async () => {
    const posted: any[] = []; let cardImports = 0;
    globalThis.fetch = (async (url: string, init: any) => {
      if (url.startsWith('/api/v1/characters/summary')) return Response.json({ data: [] });
      const body = JSON.parse(init.body); posted.push(body.name); return Response.json({ world_book: { id: `book-${posted.length}`, name: body.name }, entry_count: body.entries.length }, { status: 201 });
    }) as any;
    let ui: any;
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record()) }
      : request.command === 'attach-lorebook' ? { result: { characterId: request.characterId, worldBookIds: [request.worldBookId] } } : undefined,
      undefined, undefined, { canImportCard: () => cardImports === 0, importCard: () => { cardImports++; setTimeout(() => ui.setCharacter({ id: 'char-3', name: 'Kai' }), 0); return true; } });
    ui = p.ui; p.ui.show('123-abc'); for (let i = 0; i < 3; i++) await settle();
    expect(posted).toHaveLength(0);
    p.button('Import card and attach')!.click(); for (let i = 0; i < 10; i++) await settle();
    expect(cardImports).toBe(1);
    expect(posted).toEqual(['MENAGERIE', '2028 | ECLIPSE (rebuilt)']);
    expect(p.requests.filter(r => r.command === 'attach-lorebook').map(r => r.characterId)).toEqual(['char-3', 'char-3']);
    expect(p.ui.root.querySelector<HTMLElement>('.jar-lorebook-callout')!.hidden).toBe(true);
  });

  test('a public book can still be imported on its own before the card', async () => {
    const posted: any[] = [];
    globalThis.fetch = (async (url: string, init: any) => { posted.push({ url, body: JSON.parse(init.body) }); return Response.json({ world_book: { id: 'book-9', name: 'MENAGERIE' }, entry_count: 2 }, { status: 201 }); }) as any;
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record()) } : undefined);
    p.ui.show('123-abc'); await settle();
    p.ui.root.querySelectorAll<HTMLButtonElement>('.jar-lorebook button.jar-primary')[0].click(); for (let i = 0; i < 5; i++) await settle();
    expect(posted).toHaveLength(1); expect(p.requests.some(r => r.command === 'attach-lorebook')).toBe(false);
    expect(p.ui.root.textContent).toContain('Imported 2 entries into World Info');
  });

  test('capture sends the user’s words and chosen sources, and needs at least one', async () => {
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record({ capturedAt: undefined, payload: null, privateLorebookReconstruction: undefined })) }
      : request.command === 'capture-lorebook' ? { result: { state: 'done', lorebooks: toLorebooks(record({ capturedAt: 300 })) } } : undefined);
    p.ui.show('123-abc'); await settle();
    p.button('Capture closed lorebook…')!.click(); await settle();
    const words = p.ui.root.querySelector<HTMLTextAreaElement>('.jar-lorebook-trigger textarea')!;
    const boxes = [...p.ui.root.querySelectorAll<HTMLInputElement>('.jar-lorebook-sources input')];
    expect(boxes).toHaveLength(6); expect(boxes.every(box => box.checked)).toBe(true);
    for (const box of boxes) { box.checked = false; box.dispatchEvent(new p.ui.root.ownerDocument.defaultView!.Event('change')); }
    expect(p.button('Yes, capture')!.disabled).toBe(true);
    words.value = '  Eclipse, Thornwood  '; words.dispatchEvent(new p.ui.root.ownerDocument.defaultView!.Event('input'));
    boxes[0].checked = true; boxes[0].dispatchEvent(new p.ui.root.ownerDocument.defaultView!.Event('change'));
    expect(p.button('Yes, capture')!.disabled).toBe(false);
    p.button('Yes, capture')!.click(); for (let i = 0; i < 5; i++) await settle();
    const sent = p.requests.find(r => r.command === 'capture-lorebook');
    expect(sent.force).toBeUndefined();
    expect(sent.trigger).toEqual({ card: true, siteDescription: false, scenario: false, greetings: false, lorebookNames: false, savedDefault: false, customText: 'Eclipse, Thornwood' });
  });

  test('without World Books permission nothing is posted', async () => {
    let fetched = false; globalThis.fetch = (async (url: string) => { if (url.startsWith('/api/v1/characters/summary')) return Response.json({ data: [] }); fetched = true; return Response.json({}); }) as any;
    const p = panel(request => request.command === 'lorebooks' ? { result: toLorebooks(record()) } : undefined, ['cors_proxy']);
    p.ui.show('123-abc'); await settle();
    p.ui.root.querySelectorAll<HTMLButtonElement>('.jar-lorebook button.jar-primary')[0].click(); await settle();
    expect(fetched).toBe(false); expect(p.ui.root.textContent).toContain('Allow World Books');
  });
});

describe('closed lorebook banner', () => {
  function banner(result: any) {
    const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
    let receive: (payload: unknown) => void = () => {};
    const ctx: any = { permissions: { getGranted: async () => [] }, onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
      sendToBackend: (request: any) => { if (request.command === 'lorebooks') setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result }), 0); } };
    globalThis.fetch = (async () => Response.json({ data: [] })) as any;
    const client = createJarClient(ctx);
    const ui = createLorebooks(ctx, { client, getBaseUrl: () => 'http://localhost:4577', onBusy() {} });
    document.body.append(ui.banner, ui.root); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
    return ui;
  }
  test('the banner names the closed books and follows their state', async () => {
    const states: [any, string, string][] = [
      [record({ capturedAt: undefined, payload: null, privateLorebookReconstruction: undefined }), 'missing', 'Not captured'],
      [record({ privateLorebookReconstruction: undefined }), 'missing', 'Captured, not rebuilt'],
      [record(), 'ready', 'Rebuilt, ready to import'],
      [record({ meta: { allow_proxy: false }, capturedAt: undefined, payload: null, privateLorebookReconstruction: undefined }), 'blocked', 'Cannot be captured'],
    ];
    for (const [input, tone, state] of states) {
      const ui = banner(toLorebooks(input)); ui.show('123-abc'); await settle();
      expect(ui.banner.hidden).toBe(false); expect(ui.banner.dataset.tone).toBe(tone);
      expect(ui.banner.textContent).toContain('Closed lorebook: 2028 | ECLIPSE'); expect(ui.banner.textContent).toContain(state);
      ui.hide(); expect(ui.banner.hidden).toBe(true);
    }
  });
  test('no banner without closed lorebooks or for an uncaptured hidden card', async () => {
    const open = banner(toLorebooks(record({ publicLorebooks: [{ id: 'pub-1', title: 'OPEN', accessible: true, worldInfo: { entries: { 0: entry('Lore') } } }] })));
    open.show('123-abc'); await settle(); expect(open.banner.hidden).toBe(true);
    const hidden = banner(toLorebooks(record({ capturedAt: undefined, payload: null, privateLorebookReconstruction: undefined })));
    hidden.show('123-abc', true); await settle(); expect(hidden.banner.hidden).toBe(true);
  });
});
