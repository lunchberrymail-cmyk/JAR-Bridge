import { afterEach, describe, expect, test } from 'bun:test';
import { createOwnerBinding } from '../src/owner-binding';
import { createJarClient } from '../src/client';
import { setupJarBackend } from '../src/backend';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const installationId = 'a5ae62cd-418c-45da-9607-f552beef3c6c';
const pin = (ownerUserId = 'alice', id = installationId) => JSON.stringify({ schemaVersion: 1, ownerUserId, installationId: id });

function harness(options: { stored?: string; personal?: boolean; proofTtlMs?: number } = {}) {
  const storage = new Map<string, string>(); if (options.stored !== undefined) storage.set('installation.json', options.stored);
  const sent: { payload: any; userId?: string; options?: { frontendSessionId?: string } }[] = [];
  const writes: string[] = [], roleArguments: unknown[][] = [];
  const api: any = {
    host: { extensionInstallationId: installationId, capabilities: { 'frontend-session-routing-v1': 1 } },
    storage: {
      read: async (path: string) => { if (!storage.has(path)) throw new Error('Missing'); return storage.get(path)!; },
      exists: async (path: string) => storage.has(path),
      write: async (path: string, value: string) => { writes.push(value); storage.set(path, value); },
    },
    users: { getRole: async (...args: unknown[]) => { roleArguments.push(args); if (options.personal === false) throw new Error('userId is required for operator-scoped extensions'); return 'user'; } },
    sendToFrontend: (payload: unknown, userId?: string, delivery?: { frontendSessionId?: string }) => sent.push({ payload, userId, options: delivery }),
  };
  const binding = createOwnerBinding(api, { proofTtlMs: options.proofTtlMs ?? 100 }); cleanups.push(() => binding.dispose());
  const request = (patch: Record<string, unknown> = {}) => ({ userId: 'alice', sessionId: 'document-a', id: 'request-a', command: 'connect', current: () => true, ...patch });
  const acknowledge = (challenge = sent[sent.length - 1]?.payload, userId = 'alice', sessionId = 'document-a', patch: Record<string, unknown> = {}) => binding.accept({ ...challenge, type: 'jar_bridge:owner-proof', ...patch }, userId, sessionId);
  return { api, binding, storage, sent, writes, roleArguments, request, acknowledge };
}

describe('personal installation ownership bootstrap', () => {
  test('preserves an exact existing installation/account pin without a challenge or write', async () => {
    const h = harness({ stored: pin() });
    expect(await h.binding.ensure(h.request())).toBe(true);
    expect(h.roleArguments).toEqual([]); expect(h.sent).toEqual([]); expect(h.writes).toEqual([]);
    expect(await h.binding.ensure(h.request({ userId: 'another-admin' }))).toBe(false);
    expect(h.writes).toEqual([]);
  });

  test('never replaces mismatched, malformed, oversized or unreadable existing pins', async () => {
    for (const stored of [pin('another-user'), pin('alice', 'different-installation'), '{}', 'bad-json', 'x'.repeat(4097)]) {
      const h = harness({ stored });
      expect(await h.binding.ensure(h.request())).toBe(false);
      expect(h.sent).toEqual([]); expect(h.writes).toEqual([]); expect(h.roleArguments).toEqual([]);
      expect(h.storage.get('installation.json')).toBe(stored);
    }
    const unreadable = harness({ stored: pin() }); unreadable.api.storage.read = async () => { throw new Error('Access failed'); };
    expect(await unreadable.binding.ensure(unreadable.request())).toBe(false);
    expect(unreadable.writes).toEqual([]);
  });

  test('writes a fresh pin only after an exact account/document/request/command/random-nonce proof', async () => {
    const h = harness(); const result = h.binding.ensure(h.request()); await tick();
    expect(h.sent).toHaveLength(1); expect(h.writes).toEqual([]); expect(h.roleArguments).toEqual([[]]);
    const { payload, userId, options } = h.sent[0];
    expect(payload).toEqual({ type: 'jar_bridge:owner-challenge', id: 'request-a', command: 'connect', nonce: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(userId).toBe('alice'); expect(options).toEqual({ frontendSessionId: 'document-a' });
    h.acknowledge(payload, 'another-user'); h.acknowledge(payload, 'alice', 'another-document');
    h.acknowledge(payload, 'alice', 'document-a', { id: 'another-request' });
    h.acknowledge(payload, 'alice', 'document-a', { command: 'history' });
    h.acknowledge(payload, 'alice', 'document-a', { nonce: '0'.repeat(64) });
    await tick(); expect(h.writes).toEqual([]);
    h.acknowledge(payload); expect(await result).toBe(true);
    expect(h.writes).toEqual([pin()]);
    h.acknowledge(payload); await tick(); expect(h.writes).toHaveLength(1);
    expect(await h.binding.ensure(h.request({ id: 'next-request' }))).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  test('operator installations fail the native scope proof, without supplying a caller-controlled user ID', async () => {
    const h = harness({ personal: false });
    expect(await h.binding.ensure(h.request())).toBe(false);
    expect(h.roleArguments).toEqual([[]]); expect(h.sent).toEqual([]); expect(h.writes).toEqual([]);
  });

  test('missing scope, storage or targeted-delivery APIs fail closed', async () => {
    for (const remove of [
      (api: any) => { delete api.users; },
      (api: any) => { delete api.users.getRole; },
      (api: any) => { delete api.storage.exists; },
      (api: any) => { delete api.storage.write; },
      (api: any) => { delete api.sendToFrontend; },
      (api: any) => { api.host.capabilities = {}; },
      (api: any) => { api.host.extensionInstallationId = ''; },
    ]) {
      const h = harness(); remove(h.api);
      expect(await h.binding.ensure(h.request())).toBe(false);
      expect(h.sent).toEqual([]); expect(h.writes).toEqual([]);
    }
  });

  test('expires a proof and rejects replay or unsolicited acknowledgements', async () => {
    const h = harness({ proofTtlMs: 10 });
    h.acknowledge({ id: 'request-a', command: 'connect', nonce: 'f'.repeat(64) }); expect(h.writes).toEqual([]);
    const first = h.binding.ensure(h.request()); await tick(); const old = h.sent[0].payload;
    expect(await first).toBe(false);
    h.acknowledge(old); expect(h.writes).toEqual([]);
    const second = h.binding.ensure(h.request({ id: 'next-request' })); await tick();
    expect(h.sent[1].payload.nonce).not.toBe(old.nonce);
    h.acknowledge(old); await tick(); expect(h.writes).toEqual([]);
    h.acknowledge(h.sent[1].payload); expect(await second).toBe(true);
  });

  test('cancellation, replacement, stale epochs and disposal prevent a pending proof from binding', async () => {
    for (const action of ['cancel', 'stale', 'dispose'] as const) {
      const h = harness({ proofTtlMs: 10 }); let current = true;
      const result = h.binding.ensure(h.request({ current: () => current })); await tick(); const challenge = h.sent[0].payload;
      if (action === 'cancel') h.binding.cancel('alice', 'document-a', 'request-a');
      if (action === 'stale') current = false;
      if (action === 'dispose') h.binding.dispose();
      h.acknowledge(challenge); expect(await result).toBe(false); expect(h.writes).toEqual([]);
    }
    const h = harness();
    const old = h.binding.ensure(h.request()); await tick(); const oldChallenge = h.sent[0].payload;
    const next = h.binding.ensure(h.request({ id: 'next-request' })); await tick();
    expect(await old).toBe(false); h.acknowledge(oldChallenge); expect(h.writes).toEqual([]);
    h.acknowledge(h.sent[1].payload); expect(await next).toBe(true);
  });

  test('an existing binding appearing after proof cannot be overwritten', async () => {
    const h = harness(); const result = h.binding.ensure(h.request()); await tick();
    h.storage.set('installation.json', pin('someone-else')); h.acknowledge();
    expect(await result).toBe(false); expect(h.writes).toEqual([]); expect(h.storage.get('installation.json')).toBe(pin('someone-else'));
  });
});

describe('owner proof delivery through the normal request client', () => {
  test('client acknowledges only one matching challenge for its active request', async () => {
    let receive!: (payload: unknown) => void; const sent: any[] = [];
    const client = createJarClient({ onBackendMessage: callback => { receive = callback; return () => {}; }, sendToBackend: payload => { sent.push(payload); } } as any);
    cleanups.push(() => client.dispose());
    receive({ type: 'jar_bridge:owner-challenge', id: 'unknown', command: 'connect', nonce: 'a'.repeat(64) }); expect(sent).toEqual([]);
    const result = client.request('connect', 'http://127.0.0.1:4577'); const request = sent[0];
    const challenge = { type: 'jar_bridge:owner-challenge', id: request.id, command: request.command, nonce: 'a'.repeat(64) };
    receive({ ...challenge, id: 'other-request' }); receive({ ...challenge, command: 'history' }); receive({ ...challenge, nonce: 'not-a-nonce' });
    expect(sent).toHaveLength(1);
    receive(challenge); receive(challenge);
    expect(sent).toHaveLength(2); expect(sent[1]).toEqual({ ...challenge, type: 'jar_bridge:owner-proof' });
    receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result: { version: '0.4', captures: [] } });
    expect(await result).toEqual({ version: '0.4', captures: [] }); receive(challenge); expect(sent).toHaveLength(2);
  });

  test('cancelled/replaced request challenges never produce an acknowledgement', async () => {
    let receive!: (payload: unknown) => void; const sent: any[] = [];
    const client = createJarClient({ onBackendMessage: callback => { receive = callback; return () => {}; }, sendToBackend: payload => { sent.push(payload); } } as any);
    cleanups.push(() => client.dispose());
    const result = client.request('connect', 'http://127.0.0.1:4577'); const request = sent[0];
    client.cancel(); await expect(result).rejects.toHaveProperty('name', 'AbortError');
    receive({ type: 'jar_bridge:owner-challenge', id: request.id, command: request.command, nonce: 'a'.repeat(64) });
    expect(sent.map(row => row.type)).toEqual(['jar_bridge:request', 'jar_bridge:request']);
  });

  test('fresh personal install connects through host-retargeted proof and never exposes another administrator', async () => {
    const h = harness(); const frontend = new Map<string, (payload: unknown) => void>(); let backend!: (payload: unknown, userId?: string, sessionId?: string) => void;
    const network: string[] = [], deliveries: { user: string; session: string; type: string }[] = [];
    h.api.onFrontendMessage = (callback: typeof backend) => { backend = callback; return () => {}; };
    h.api.permissions = { getGranted: async () => ['cors_proxy'] };
    h.api.cors = async (url: string) => { network.push(url); return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(url.endsWith('/api/version') ? { version: '0.4' } : []) }; };
    h.api.sendToFrontend = (payload: any, _requestedUser: string, options: { frontendSessionId: string }) => {
      // Lumiverse forces user-scoped messages to the installation owner. The
      // same session ID registered by another user is a different destination.
      deliveries.push({ user: 'alice', session: options.frontendSessionId, type: payload.type });
      frontend.get(`alice\0${options.frontendSessionId}`)?.(payload);
    };
    cleanups.push(setupJarBackend(h.api));
    function createClient(user: string, session: string) {
      const client = createJarClient({ onBackendMessage: callback => { frontend.set(`${user}\0${session}`, callback); return () => { frontend.delete(`${user}\0${session}`); }; }, sendToBackend: payload => backend(payload, user, session) } as any);
      cleanups.push(() => client.dispose()); return client;
    }
    const owner = createClient('alice', 'shared-document'); const otherAdmin = createClient('another-admin', 'shared-document');
    const denied = otherAdmin.request('connect', 'http://127.0.0.1:4577'); await tick(); await tick();
    expect(network).toEqual([]); expect(h.writes).toEqual([]); expect(deliveries[0].user).toBe('alice');
    otherAdmin.cancel(); await expect(denied).rejects.toHaveProperty('name', 'AbortError');
    expect(await owner.request('connect', 'http://127.0.0.1:4577')).toEqual({ version: '0.4', captures: [] });
    expect(h.storage.get('installation.json')).toBe(pin());
    expect(network.map(url => new URL(url).pathname)).toEqual(['/api/version', '/api/captures']);
  });
});
