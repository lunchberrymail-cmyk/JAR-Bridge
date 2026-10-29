import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { setupJarBackend } from '../src/backend';
import { createJarTransport } from '../src/transport';
import { createJarClient } from '../src/client';
import { createCleanup, duplicatePreviews } from '../src/cleanup-ui';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 5)); };
function response(body: unknown, status = 200) { return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }; }
const row = (id: string, name: string, source: string, ts: number) => ({ id, name, source, ts });

function fixture(cors: (url: string, request: any) => Promise<unknown>) {
  let handler: (payload: unknown, userId: string, sessionId?: string) => void = () => {};
  const calls: { url: string; options: any }[] = [], replies: any[] = [], touched: string[] = [];
  const untouchable = new Proxy({}, { get: (_, key) => () => { touched.push(String(key)); throw new Error('Lumiverse data must not be touched'); } });
  const api: any = {
    host: { extensionInstallationId: 'installed-one', capabilities: { 'frontend-session-routing-v1': 1 } },
    storage: { read: async () => JSON.stringify({ schemaVersion: 1, ownerUserId: 'owner', installationId: 'installed-one' }) },
    permissions: { getGranted: async () => ['cors_proxy'] },
    cors: async (url: string, request: any) => { calls.push({ url, options: request }); return cors(url, request); },
    characters: untouchable, chats: untouchable, world_books: untouchable,
    onFrontendMessage: (fn: typeof handler) => { handler = fn; return () => {}; },
    sendToFrontend: (payload: unknown) => { replies.push(payload); },
  };
  cleanups.push(setupJarBackend(api));
  return { calls, replies, touched, send: (payload: any) => handler({ type: 'jar_bridge:request', ...payload }, 'owner', 'tab-one') };
}

describe('JAR cleanup', () => {
  test('duplicate previews keep every capture, and the newest preview when a character has no capture', () => {
    expect(duplicatePreviews([
      row('n1', 'NOVA', 'inspect', 1), row('n2', 'NOVA', 'generateAlpha', 2), row('n3', 'NOVA', 'inspect', 3),
      row('k1', 'Kai', 'inspect', 1), row('k2', 'Kai', 'inspect', 5), row('k3', 'Kai', 'inspect', 3),
      row('y1', 'Yuki', 'inspect', 1), row('w1', 'Weston', 'generateAlpha', 1),
    ]).sort()).toEqual(['k1', 'k3', 'n1', 'n3']);
  });

  test('a delete uses JAR’s DELETE route for one validated record only', async () => {
    const calls: any[] = [];
    const get = createJarTransport({ permissions: { getGranted: async () => ['cors_proxy'] }, cors: async (url: string, request: any) => { calls.push([url, request.method, request.body]); return response({ ok: true }); } } as any, 'http://localhost', { current: () => true });
    await get({ kind: 'delete', recordId: '123-abc' });
    expect(calls).toEqual([['http://127.0.0.1:4577/api/captures/123-abc', 'DELETE', undefined]]);
    await expect(get({ kind: 'delete', recordId: '../settings' })).rejects.toThrow('Invalid');
  });

  test('the backend deletes each record from JAR, reports failures, and never touches Lumiverse', async () => {
    const f = fixture(async url => response({ ok: !url.endsWith('/gone-1') }));
    f.send({ id: 'd1', command: 'delete-records', recordIds: ['a-1', 'gone-1', 'b-2'] }); for (let i = 0; i < 4; i++) await wait();
    expect(f.calls.map(call => [new URL(call.url).pathname, call.options.method])).toEqual([['/api/captures/a-1', 'DELETE'], ['/api/captures/gone-1', 'DELETE'], ['/api/captures/b-2', 'DELETE']]);
    expect(f.replies[0].result).toEqual({ deleted: ['a-1', 'b-2'], failed: ['gone-1'] });
    expect(f.touched).toEqual([]);
  });

  test('the backend refuses bad or repeated record lists before calling JAR', async () => {
    const f = fixture(async () => response({ ok: true }));
    for (const recordIds of [undefined, [], ['../x'], ['a-1', 'a-1'], 'a-1']) { f.send({ id: 'bad', command: 'delete-records', recordIds }); await wait(); }
    expect(f.calls).toHaveLength(0); expect(f.replies.every(reply => reply.error)).toBe(true);
  });

  test('the panel deletes only after confirmation, warns about captures, and reports what was deleted', async () => {
    const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
    const requests: any[] = []; let receive: (payload: unknown) => void = () => {};
    const ctx: any = {
      onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
      sendToBackend: (request: any) => { requests.push(request); if (request.command === 'cancel') return; setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result: { deleted: request.recordIds, failed: [] } }), 0); },
    };
    const client = createJarClient(ctx); const deletedLists: string[][] = [];
    const ui = createCleanup({ client, getBaseUrl: () => 'http://localhost:4577', onBusy() {}, onDeleted: ids => deletedLists.push(ids) });
    document.body.append(ui.root); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
    const button = (text: string) => [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
    ui.show([row('n1', 'NOVA', 'inspect', 1), row('n2', 'NOVA', 'generateAlpha', 2), row('n3', 'NOVA', 'inspect', 3)]);
    expect(ui.root.textContent).toContain('stay exactly as they are');
    button('Select duplicate previews').click();
    expect([...ui.root.querySelectorAll<HTMLInputElement>('.jar-cleanup-row input')].map(input => input.checked)).toEqual([true, false, true]);
    button('Delete 2 from JAR…').click(); await settle();
    expect(requests).toHaveLength(0);
    expect(ui.root.textContent).toContain('Nothing in Lumiverse is changed');
    expect(ui.root.textContent).not.toContain('are captures');
    button('Select all').click(); button('Delete 3 from JAR…').click();
    expect(ui.root.textContent).toContain('1 of them is a capture');
    button('Yes, delete 3').click(); for (let i = 0; i < 5; i++) await settle();
    expect(requests.find(r => r.command === 'delete-records')).toMatchObject({ recordIds: ['n3', 'n2', 'n1'] });
    expect(deletedLists).toEqual([['n3', 'n2', 'n1']]);
    expect(ui.root.textContent).toContain('Deleted 3 from JAR.');
    expect(ui.root.textContent).toContain('JAR has no saved records.');
  });
});
