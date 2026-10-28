import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CancelledError, createJarClient } from '../src/client';
import type { JarRequest } from '../src/jar-adapter';

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let timers: Map<number, { callback: () => void; delay: number }>;
let timerId: number;
let listeners: Set<(payload: unknown) => void>;
let sent: JarRequest[];
let unsubscribed: number;
let registered: number;
let send: ((payload: JarRequest) => void) | undefined;
let clients: ReturnType<typeof createJarClient>[];

function setup() {
  const client = createJarClient({
    sendToBackend(payload) { sent.push(structuredClone(payload) as JarRequest); send?.(payload as JarRequest); },
    onBackendMessage(handler) { registered++; listeners.add(handler); return () => { unsubscribed++; listeners.delete(handler); }; },
  });
  clients.push(client);
  return client;
}
function emit(payload: unknown) { for (const listener of listeners) listener(payload); }
function reply(request: JarRequest, result: unknown) { emit({ type: 'jar_bridge:response', id: request.id, command: request.command, result }); }
const rejected = (promise: Promise<unknown>) => promise.then(() => { throw new Error('Expected rejection.'); }, error => error as Error);

beforeEach(() => {
  timers = new Map(); timerId = 0; listeners = new Set(); sent = []; unsubscribed = registered = 0; send = undefined; clients = [];
  globalThis.setTimeout = ((callback: () => void, delay: number) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as typeof clearTimeout;
});
afterEach(() => {
  for (const client of clients) client.dispose();
  globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
});

describe('JAR frontend requests settle only their own active response', () => {
  test('registers once, ignores unknown/mismatched/malformed messages, and settles a matching reply once', async () => {
    const client = setup(); let settled = false;
    const promise = client.request('list', 'http://127.0.0.1:4577').then(value => { settled = true; return value; });
    const request = sent[0];
    expect(registered).toBe(1); expect(listeners.size).toBe(1);
    for (const payload of [null, [], { type: 'other', id: request.id, command: 'list', result: { captures: [] } },
      { type: 'jar_bridge:response', id: 'someone-else', command: 'list', result: { captures: [] } },
      { type: 'jar_bridge:response', id: request.id, command: 'connect', result: { captures: [] } },
      { type: 'jar_bridge:response', id: request.id, command: 'list', error: 13 },
      { type: 'jar_bridge:response', id: request.id, command: 'list', result: { captures: 'bad' } }]) emit(payload);
    await Promise.resolve(); expect(settled).toBe(false); expect(timers.size).toBe(1);
    reply(request, { captures: [] });
    expect(await promise).toEqual({ captures: [] }); expect(timers.size).toBe(0);
    emit({ type: 'jar_bridge:response', id: request.id, command: 'list', error: 'Too late' });
    expect(sent).toHaveLength(1);
  });

  test('replacing a request cancels the old ID and rejects it with a benign AbortError', async () => {
    const client = setup();
    const first = rejected(client.request('connect', 'http://127.0.0.1:4577'));
    const old = sent[0];
    const second = client.request('card', 'http://127.0.0.1:9999', 'saved-card');
    const next = sent[2];
    expect(sent[1]).toEqual({ type: 'jar_bridge:request', command: 'cancel', id: old.id });
    expect(next.id).not.toBe(old.id); expect(next.baseUrl).toBe('http://127.0.0.1:9999'); expect(next.recordId).toBe('saved-card');
    expect(await first).toBeInstanceOf(CancelledError); expect((await first).name).toBe('AbortError');
    reply(old, { version: '1.0', captures: [] });
    let settled = false; void second.then(() => { settled = true; });
    reply(next, { recordId: 'wrong-card', name: 'Wrong', card: { spec: 'chara_card_v2', spec_version: '2.0', data: {} } });
    await Promise.resolve(); expect(settled).toBe(false);
    const result = { recordId: 'saved-card', name: 'Laiyah', card: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Laiyah' } } };
    reply(next, result); expect(await second).toEqual(result); expect(timers.size).toBe(0);
  });

  test('cancel is repeatable and a later request remains usable with a new unique ID', async () => {
    const client = setup(); const first = rejected(client.request('list', 'local')); const old = sent[0];
    client.cancel(); client.cancel();
    expect((await first).name).toBe('AbortError'); expect(timers.size).toBe(0); expect(sent).toHaveLength(2);
    const next = client.request('connect', 'local'); const request = sent[2];
    expect(request.id).not.toBe(old.id); expect(registered).toBe(1);
    reply(request, { captures: [] });
    let settled = false; void next.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
    reply(request, { version: '2.0', captures: [] }); expect(await next).toEqual({ version: '2.0', captures: [] });
  });

  test('times out after 90 seconds, cancels that backend job, and ignores a late reply', async () => {
    const client = setup(); const error = rejected(client.request('list', 'local')); const request = sent[0];
    expect([...timers.values()].map(timer => timer.delay)).toEqual([90_000]);
    [...timers.values()][0].callback();
    expect((await error).message).toContain('JAR Bridge did not reply'); expect((await error).message).toContain('Reload the extension'); expect(timers.size).toBe(0);
    expect(sent[1]).toEqual({ type: 'jar_bridge:request', command: 'cancel', id: request.id });
    reply(request, { captures: [] }); expect(sent).toHaveLength(2);
  });

  test('disposal cancels, unregisters exactly once, and prevents further backend requests', async () => {
    const client = setup(); const error = rejected(client.request('list', 'local'));
    client.dispose(); client.dispose();
    expect((await error).name).toBe('AbortError'); expect(unsubscribed).toBe(1); expect(listeners.size).toBe(0); expect(timers.size).toBe(0);
    expect((await rejected(client.request('list', 'local'))).name).toBe('AbortError'); expect(sent).toHaveLength(2);
  });

  test('backend errors are control-free and bounded to 500 characters', async () => {
    const client = setup(); const error = rejected(client.request('list', 'local')); const request = sent[0];
    emit({ type: 'jar_bridge:response', id: request.id, command: 'list', error: `Fail\0\n\r${'x'.repeat(900)}` });
    const message = (await error).message;
    expect(message.length).toBeLessThanOrEqual(500); expect(message).toMatch(/^Fail {3}x/); expect(message).not.toMatch(/[\u0000-\u001f]/); expect(timers.size).toBe(0);
    const empty = rejected(client.request('list', 'local')); const next = sent.at(-1)!;
    emit({ type: 'jar_bridge:response', id: next.id, command: 'list', error: '\0 \n' });
    expect((await empty).message).toContain('could not complete');
  });

  test('transport send failures reject safely and cancellation still works when its send throws', async () => {
    const client = setup(); send = () => { throw new Error('Secret transport details'); };
    expect((await rejected(client.request('list', 'local'))).message).toBe('Could not send this request to the JAR bridge. Try again.'); expect(timers.size).toBe(0);
    send = undefined; const error = rejected(client.request('list', 'local'));
    send = () => { throw new Error('Unload'); }; expect(() => client.cancel()).not.toThrow();
    expect((await error).name).toBe('AbortError'); expect(timers.size).toBe(0);
  });

  test('a synchronous native reply settles correctly, and separate clients cannot collide', async () => {
    const first = setup(); const second = setup();
    send = request => { if (request.command === 'list') reply(request, { captures: [] }); };
    expect(await first.request('list', 'local')).toEqual({ captures: [] }); expect(await second.request('list', 'local')).toEqual({ captures: [] });
    expect(sent[0].id).not.toBe(sent[1].id); expect(timers.size).toBe(0); expect(registered).toBe(2);
  });

  test('linked conversation lists and selected history replies must match the selected record and chat', async () => {
    const client = setup(); let settled = false;
    const listed = client.request('conversations', 'local', 'record-1').then(result => { settled = true; return result; }); const listRequest = sent[0];
    reply(listRequest, { recordId: 'wrong', characterName: 'Name', conversations: [] }); await Promise.resolve(); expect(settled).toBe(false);
    const result = { recordId: 'record-1', characterName: 'Name', conversations: [] }; reply(listRequest, result); expect(await listed).toEqual(result);
    settled = false; const history = client.request('history', 'local', 'record-1', '31415').then(result => { settled = true; return result; }); const historyRequest = sent.at(-1)!;
    expect(historyRequest.chatId).toBe('31415'); expect(historyRequest.recordId).toBe('record-1');
    const good = { recordId: 'record-1', chatId: '31415', characterName: 'Name', userName: 'User', messageCount: 2, jsonl: 'selected history' };
    for (const value of [{ ...good, recordId: 'wrong' }, { ...good, chatId: '99999' }, { ...good, jsonl: {} }]) reply(historyRequest, value);
    await Promise.resolve(); expect(settled).toBe(false); reply(historyRequest, good); expect(await history).toEqual(good); expect(timers.size).toBe(0);
  });
});

const canonicalCharacter = 'https://janitorai.com/characters/12345678-1234-1234-1234-123456789abc';
const canonicalChat = 'https://janitorai.com/chats/31415';
const linkCard = { recordId: 'record-1', name: 'Character', card: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Character' } } };
const linkHistory = { recordId: 'record-1', chatId: '31415', characterName: 'Character', userName: 'User', messageCount: 2, jsonl: 'selected history' };

describe('explicit JanitorAI link client', () => {
  test('serializes a canonical URL only after an explicit requestLink call', async () => {
    const client = setup(); expect(sent).toHaveLength(0);
    const promise = client.requestLink('http://127.0.0.1:4577', `${canonicalCharacter}-some-slug?track=private#fragment`);
    const request = sent[0];
    expect(request.command).toBe('preview-link'); expect(request.sourceUrl).toBe(canonicalCharacter); expect(request).not.toHaveProperty('recordId'); expect(request).not.toHaveProperty('chatId');
    const result = { kind: 'character', sourceUrl: canonicalCharacter, recordId: 'record-1', characterUrl: canonicalCharacter, card: linkCard };
    reply(request, result); expect(await promise).toEqual(result); expect(timers.size).toBe(0);
  });
  test('invalid links are rejected locally without sending any backend or cancel message', async () => {
    const client = setup();
    for (const url of ['https://evil.example/chats/31415', 'https://user:PRIVATE@janitorai.com/chats/31415', 'https://janitorai.com/chats/31415%2fmessages%2f9']) {
      const error = await rejected(client.requestLink('local', url)); expect(error.message).toContain('JanitorAI'); expect(error.message).not.toContain('PRIVATE');
    }
    expect(sent).toHaveLength(0); expect(timers.size).toBe(0);
  });
  test('character-link results require the selected canonical identity, nested record identity, and card or guidance', async () => {
    const client = setup(); let settled = false;
    const promise = client.requestLink('local', canonicalCharacter).then(result => { settled = true; return result; }); const request = sent[0];
    const good = { kind: 'character', sourceUrl: canonicalCharacter, recordId: 'record-1', characterUrl: canonicalCharacter, card: linkCard };
    for (const result of [
      linkCard, { ...good, kind: 'chat' }, { ...good, sourceUrl: `${canonicalCharacter}?tracking=1` }, { ...good, recordId: '../settings' },
      { ...good, card: { ...linkCard, recordId: 'other' } }, { ...good, card: undefined }, { ...good, history: linkHistory },
      { ...good, characterUrl: 'https://evil.example/character' }, { ...good, characterUrl: 'https://janitorai.com/characters/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    ]) reply(request, result);
    await Promise.resolve(); expect(settled).toBe(false);
    const incomplete = { kind: 'character', sourceUrl: canonicalCharacter, recordId: 'record-1', warning: 'Use a downloaded card file.' };
    reply(request, incomplete); expect(await promise).toEqual(incomplete);
  });
  test('chat results require sanitized history for the exact pasted chat even when a card is absent', async () => {
    const client = setup(); let settled = false;
    const promise = client.requestLink('local', `${canonicalChat}/messages/999`).then(result => { settled = true; return result; }); const request = sent[0];
    expect(request.sourceUrl).toBe(canonicalChat);
    const good = { kind: 'chat', sourceUrl: canonicalChat, recordId: 'record-1', characterUrl: canonicalCharacter, history: linkHistory };
    for (const result of [
      { ...good, sourceUrl: 'https://janitorai.com/chats/99999' }, { ...good, history: undefined }, { ...good, history: { ...linkHistory, recordId: 'other' } },
      { ...good, history: { ...linkHistory, chatId: '99999' } }, { ...good, history: { ...linkHistory, messageCount: -1 } },
      { ...good, history: { ...linkHistory, jsonl: '' } }, { ...good, card: { ...linkCard, recordId: 'other' } },
    ]) reply(request, result);
    await Promise.resolve(); expect(settled).toBe(false);
    reply(request, good); expect(await promise).toEqual(good); expect(timers.size).toBe(0);
  });
  test('replacing or closing a pasted-link preview cancels it and ignores late source data', async () => {
    const client = setup(); const first = rejected(client.requestLink('local', canonicalCharacter)); const old = sent[0];
    const next = rejected(client.requestLink('local', canonicalChat)); const current = sent[2];
    expect((await first).name).toBe('AbortError'); expect(sent[1]).toEqual({ type: 'jar_bridge:request', command: 'cancel', id: old.id });
    reply(old, { kind: 'character', sourceUrl: canonicalCharacter, recordId: 'record-1', card: linkCard });
    client.dispose(); expect((await next).name).toBe('AbortError');
    reply(current, { kind: 'chat', sourceUrl: canonicalChat, recordId: 'record-1', history: linkHistory });
    expect(sent.at(-1)).toEqual({ type: 'jar_bridge:request', command: 'cancel', id: current.id });
    expect((await rejected(client.requestLink('local', canonicalChat))).name).toBe('AbortError'); expect(timers.size).toBe(0);
  });
});
