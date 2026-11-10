import { expect, test } from 'bun:test';
import { requestHostUuid } from '../src/uuid-client';
import { registerUuidHost } from '../src/uuid-host';

const id = '12345678-1234-4234-8234-123456789abc';
test('frontend requests a host UUID without browser crypto, including plain HTTP clients', async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  let handler: (payload: unknown) => void = () => {};
  let off = 0, sent: any;
  try {
    const promise = requestHostUuid({
      onBackendMessage(fn) { handler = fn; return () => { off++; }; },
      sendToBackend(payload) { sent = payload; },
    });
    expect(sent.type).toBe('jar_bridge:uuid');
    handler({ type: 'jar_bridge:uuid:result', requestId: 'wrong', uuid: id });
    expect(off).toBe(0);
    handler({ type: 'jar_bridge:uuid:result', requestId: sent.requestId, uuid: id });
    expect(await promise).toBe(id); expect(off).toBe(1);
  } finally { Object.defineProperty(globalThis, 'crypto', saved); }
});

test('backend delegates to spindle.uuid.v4 and targets the originating account and document', async () => {
  let receive: any, calls = 0;
  const replies: any[] = [];
  const stop = registerUuidHost({
    host: { capabilities: { 'uuid-v1': 1, 'frontend-session-routing-v1': 1 } },
    uuid: { v4: async () => { calls++; return id; } },
    onFrontendMessage(fn: any) { receive = fn; return () => {}; },
    sendToFrontend(...args: any[]) { replies.push(args); },
  } as any);
  receive({ type: 'jar_bridge:uuid', requestId: '1', userId: 'forged' }, 'real-user', 'real-document');
  await Promise.resolve(); await Promise.resolve();
  expect(calls).toBe(1);
  expect(replies).toEqual([[{ type: 'jar_bridge:uuid:result', requestId: '1', uuid: id }, 'real-user', { frontendSessionId: 'real-document' }]]);
  stop();
});

test('missing capabilities, failures, cancellation and teardown never fall back to local generation', async () => {
  let receive: any, calls = 0;
  const replies: any[] = [];
  const stop = registerUuidHost({
    host: { capabilities: { 'frontend-session-routing-v1': 1 } },
    uuid: { v4: async () => { calls++; return id; } },
    onFrontendMessage(fn: any) { receive = fn; return () => {}; },
    sendToFrontend(...args: any[]) { replies.push(args); },
  } as any);
  receive({ type: 'jar_bridge:uuid', requestId: '1' }, 'user', 'document');
  await Promise.resolve(); expect(calls).toBe(0); expect(replies[0][0].code).toBe('unsupported');
  receive({ type: 'jar_bridge:uuid', requestId: '2' }, 'user', undefined);
  stop(); receive({ type: 'jar_bridge:uuid', requestId: '3' }, 'user', 'document');
  expect(replies).toHaveLength(1);
  const abort = new AbortController(); let off = 0;
  const promise = requestHostUuid({ onBackendMessage: () => () => { off++; }, sendToBackend() {} }, abort.signal);
  abort.abort(); await expect(promise).rejects.toThrow('Cancelled'); expect(off).toBe(1);
  await expect(requestHostUuid({ onBackendMessage: () => () => {}, sendToBackend() { throw Error('offline'); } })).rejects.toThrow('could not contact');
});

test('invalid host output, frontend teardown and timeout clean up without local fallback', async () => {
  let receive: any, sent: any, teardown: (() => void) | undefined, off = 0, offTeardown = 0;
  const ctx = {
    onBackendMessage(fn: any) { receive = fn; return () => { off++; }; },
    onTeardown(fn: () => void) { teardown = fn; return () => { offTeardown++; }; },
    sendToBackend(payload: any) { sent = payload; },
  };
  const invalid = requestHostUuid(ctx);
  receive({ type: 'jar_bridge:uuid:result', requestId: sent.requestId, uuid: 'not-a-uuid' });
  await expect(invalid).rejects.toThrow('invalid host UUID reply');
  const unloading = requestHostUuid(ctx); teardown!();
  await expect(unloading).rejects.toHaveProperty('name', 'AbortError');
  expect(off).toBe(2); expect(offTeardown).toBe(2);
  const saved = globalThis.setTimeout; let expire!: () => void;
  try {
    globalThis.setTimeout = ((fn: () => void) => { expire = fn; return 0; }) as any;
    const timeout = requestHostUuid(ctx); expire();
    await expect(timeout).rejects.toThrow('did not receive a host UUID reply'); expect(off).toBe(3); expect(offTeardown).toBe(3);
  } finally { globalThis.setTimeout = saved; }
});

test('backend drops delayed output after cleanup and reports rejected UUID calls', async () => {
  let receive: any, complete!: (value: string) => void, calls = 0;
  const replies: any[] = [];
  const api: any = {
    host: { capabilities: { 'uuid-v1': 1, 'frontend-session-routing-v1': 1 } },
    uuid: { v4: () => { calls++; return new Promise<string>(resolve => { complete = resolve; }); } },
    onFrontendMessage(fn: any) { receive = fn; return () => {}; },
    sendToFrontend(...args: any[]) { replies.push(args); },
  };
  const stop = registerUuidHost(api);
  receive({ type: 'jar_bridge:uuid', requestId: '1' }, undefined, 'document');
  expect(calls).toBe(0);
  receive({ type: 'jar_bridge:uuid', requestId: '1' }, 'user', 'document');
  stop(); complete(id); await Promise.resolve(); expect(replies).toEqual([]);
  api.uuid.v4 = async () => { throw new Error('private host error'); };
  const stopAgain = registerUuidHost(api);
  receive({ type: 'jar_bridge:uuid', requestId: '2' }, 'user', 'document');
  await Promise.resolve(); await Promise.resolve();
  expect(replies[0][0]).toEqual({ type: 'jar_bridge:uuid:result', requestId: '2', error: 'Host UUID generation failed.', code: 'failed' });
  stopAgain();
});

test('only an explicit unsupported host reply tells users to update Lumiverse', async () => {
  let receive: any, sent: any;
  const ctx = {
    onBackendMessage(fn: any) { receive = fn; return () => {}; },
    sendToBackend(payload: any) { sent = payload; },
  };
  const unsupported = requestHostUuid(ctx);
  receive({ type: 'jar_bridge:uuid:result', requestId: sent.requestId, code: 'unsupported', error: 'Unavailable' });
  await expect(unsupported).rejects.toThrow('uuid-v1');
  for (const code of ['failed', undefined]) {
    const failed = requestHostUuid(ctx);
    receive({ type: 'jar_bridge:uuid:result', requestId: sent.requestId, code, error: 'Private host details' });
    await expect(failed).rejects.toThrow('could not generate a host UUID');
  }
});

test('UUID generation uses the host backend and the obsolete local helper is absent', async () => {
  expect(await Bun.file(import.meta.dir + '/../src/uuid.ts').exists()).toBe(false);
  for (const entry of [...new Bun.Glob('src/**/*.ts').scanSync({ cwd: import.meta.dir + '/..' }), ...new Bun.Glob('dist/*.js').scanSync({ cwd: import.meta.dir + '/..' })]) {
    const source = await Bun.file(import.meta.dir + '/../' + entry).text();
    expect(source).not.toMatch(/\brandomUUID\s*\(/);
    expect(source).not.toMatch(/from ['"]\.\/uuid['"]/);
  }
  expect(await Bun.file(import.meta.dir + '/../dist/backend.js').text()).toContain('.uuid.v4(');
});
