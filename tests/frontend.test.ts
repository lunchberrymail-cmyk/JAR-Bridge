import { afterEach, beforeEach, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { setup } from '../src/frontend';
import { toCardV2 } from '../src/jar-adapter';

const originalDocument = globalThis.document;
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
let dom: JSDOM, destroy: () => void;
let received: (payload: unknown) => void, requests: any[], granted: string[];
let revision: string;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { url: 'http://192.168.1.2:11113' });
  globalThis.document = dom.window.document;
  granted = ['cors_proxy']; requests = []; revision = 'First version';
  const root = document.createElement('section'); document.body.append(root);
  destroy = setup({
    dom: { addStyle: () => () => {} },
    ui: { registerDrawerTab: () => ({ root, onActivate: () => () => {}, destroy() { root.remove(); } }) },
    events: { on: () => () => {} },
    permissions: { getGranted: async () => [...granted], request: async () => { throw new Error('Permission request denied by user'); } },
    onBackendMessage(callback: typeof received) { received = callback; return () => {}; },
    sendToBackend(request: any) {
      requests.push(request);
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
