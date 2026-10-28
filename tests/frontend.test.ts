import { afterEach, beforeEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { setup } from '../src/frontend';
import { toCardV2 } from '../src/jar-adapter';

const originalDocument = globalThis.document;
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
let dom: JSDOM, destroy: () => void;
let received: (payload: unknown) => void, requests: any[], granted: string[];
let revision: string, connectionError: string;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://192.168.1.2:11113' });
  globalThis.document = dom.window.document;
  granted = ['cors_proxy']; requests = []; revision = 'First version'; connectionError = '';
  const root = document.createElement('section'); document.body.append(root);
  destroy = setup({
    dom: { addStyle: () => () => {} },
    ui: { registerDrawerTab: () => ({ root, onActivate: () => () => {}, destroy() { root.remove(); } }) },
    events: { on: () => () => {} },
    permissions: { getGranted: async () => [...granted], request: async () => { throw new Error('Permission request denied by user'); } },
    onBackendMessage(callback: typeof received) { received = callback; return () => {}; },
    sendToBackend(request: any) {
      requests.push(request);
      if (request.command === 'check' || request.command === 'connect') {
        received({ type: 'jar_bridge:response', id: request.id, command: request.command,
          ...(connectionError ? { error: connectionError } : { result: { version: '0.4.0', ...(request.command === 'connect' ? { captures: [] } : {}) } }) });
        return;
      }
      if (request.command !== 'preview-link') return;
      const card = toCardV2({ id: 'record-1', character: { name: 'Character', description: revision } });
      received({ type: 'jar_bridge:response', id: request.id, command: request.command,
        result: { kind: 'character', sourceUrl: request.sourceUrl, recordId: card.recordId, card } });
    },
  } as any);
});
afterEach(() => { destroy(); dom.window.close(); globalThis.document = originalDocument; });

function preview() {
  const input = document.querySelector<HTMLInputElement>('#jar-source-link')!;
  input.value = 'https://janitorai.com/characters/11111111-2222-3333-4444-555555555555';
  input.dispatchEvent(new dom.window.Event('input'));
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Preview link')!.click();
}

test('explicitly previewing the same link again reads its current content', async () => {
  preview(); await settle();
  expect(document.querySelector('.jar-preview')?.textContent).toContain('First version');
  revision = 'Updated version'; preview(); await settle();
  expect(requests.filter(request => request.command === 'preview-link')).toHaveLength(2);
  expect(document.querySelector('.jar-preview')?.textContent).toContain('Updated version');
  expect(document.querySelector('.jar-preview')?.textContent).not.toContain('First version');
});

test('denying preview access explains how to continue without starting a backend request', async () => {
  granted = []; preview(); await settle();
  expect(document.body.textContent).toContain('Allow local JAR access to preview this link.');
  expect(requests).toHaveLength(0);
  expect(document.querySelector<HTMLButtonElement>('#jar-source-link')!.disabled).toBe(false);
});

test('a fresh installation exposes its connection check without requiring an archive or sign-in', async () => {
  const panel = document.querySelector<HTMLElement>('.jar-connection-panel')!;
  expect(panel.hidden).toBe(false); expect(panel.closest('details')).toBeNull(); expect(requests).toHaveLength(0);
  [...panel.querySelectorAll('button')].find(button => button.textContent === 'Check JAR connection')!.click(); await settle();
  expect(requests.map(request => request.command)).toEqual(['check']);
  expect(panel.querySelector('.jar-connection-state')?.textContent).toContain('JAR 0.4.0 is running');
  expect(document.body.textContent).toContain('To load JanitorAI links, sign in');
});

test('connection failure opens recovery guidance and permits an explicit retry', async () => {
  connectionError = 'JAR is not accepting connections at this local address. Start start.bat and keep its console open.';
  const button = [...document.querySelectorAll('button')].find(button => button.textContent === 'Check JAR connection')!;
  button.click(); await settle();
  const recovery = document.querySelector<HTMLDetailsElement>('.jar-connection-help')!;
  expect(recovery.open).toBe(true); expect(document.querySelector('.jar-shell > .jar-status')?.textContent).toContain('not accepting connections');
  expect(recovery.textContent).toContain('closing it stops JAR'); expect(button.disabled).toBe(false);
  connectionError = ''; button.click(); await settle();
  expect(recovery.open).toBe(false); expect(document.querySelector('.jar-connection-state')?.textContent).toContain('JAR 0.4.0 is running');
});

test('an empty fresh archive is shown as a successful connection with link and file options', async () => {
  [...document.querySelectorAll('button')].find(button => button.textContent === 'Load saved cards')!.click(); await settle();
  expect(document.querySelector('.jar-connection-state')?.textContent).toBe('Connected · JAR 0.4.0');
  expect(document.querySelector('.jar-shell > .jar-status')?.textContent).toContain('This copy has no saved cards yet');
  expect(document.querySelector('.jar-shell > .jar-status')?.textContent).toContain('Paste a JanitorAI link');
});
