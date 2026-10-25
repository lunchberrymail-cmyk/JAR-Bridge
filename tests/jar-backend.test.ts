import { afterEach, describe, expect, test } from 'bun:test';
import { setupJarBackend } from '../src/backend';
import { normalizeSummaries, toCardV2 } from '../src/jar-adapter';
import { createJarTransport, MAX_JAR_RESPONSE_BYTES, normalizeJarBase } from '../src/transport';
import { assertLinkedConversation, toConversations, toHistory } from '../src/conversation-adapter';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const record = (id = '123-abc') => ({
  id, characterName: 'Stored name', payload: { token: 'PRIVATE_CAPTURE' }, probePayload: 'PRIVATE_PROBE', conversations: ['PRIVATE_CHAT'], settings: { apiKey: 'PRIVATE_KEY' },
  character: { name: 'A <b>character</b>', description: '  Exact {{char}} definition\n\n', personality: 'Careful', scenario: 'A place', firstMessage: 'Hello {{user}}', alternateGreetings: ['Alternative one', '', '  Alternative two  '], exampleMessages: '<START>\n{{char}}: Example', creatorNotes: 'Creator note', tags: ['tag one', 'tag two'], avatarBase64: 'data:image/png;base64,iVBORw0KGgo=', definitionSource: 'public' },
});
function response(body: unknown, status = 200) { return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) }; }
function fixture(options: { pin?: unknown; granted?: () => Promise<string[]>; cors?: (url: string, options: unknown) => Promise<unknown>; capabilities?: Record<string, number> } = {}) {
  let handler: (payload: unknown, userId: string, frontendSessionId?: string) => void = () => {};
  let unsubscribed = false;
  const calls: { url: string; options: any }[] = [];
  const replies: { payload: any; userId: string; options: any }[] = [];
  const api: any = {
    host: { extensionInstallationId: 'installed-one', capabilities: options.capabilities ?? { 'frontend-session-routing-v1': 1 } },
    storage: { read: async (path: string) => { expect(path).toBe('installation.json'); return JSON.stringify(options.pin === undefined ? { schemaVersion: 1, ownerUserId: 'owner', installationId: 'installed-one' } : options.pin); } },
    permissions: { getGranted: options.granted ?? (async () => ['cors_proxy']) },
    cors: async (url: string, request: unknown) => { calls.push({ url, options: request }); return options.cors ? options.cors(url, request) : response(url.endsWith('/api/version') ? { version: '0.4.0' } : url.endsWith('/api/captures') ? [{ id: '123-abc', characterName: 'Test', source: 'inspect', ts: 10, preview: 'PRIVATE_PROMPT' }] : record()); },
    onFrontendMessage: (fn: typeof handler) => { handler = fn; return () => { unsubscribed = true; }; },
    sendToFrontend: (payload: unknown, userId: string, options: unknown) => { replies.push({ payload, userId, options }); },
  };
  const destroy = setupJarBackend(api); cleanups.push(destroy);
  return { api, calls, replies, destroy, get unsubscribed() { return unsubscribed; }, send: (payload: any, userId = 'owner', sessionId: string | undefined = 'tab-one') => handler({ type: 'jar_bridge:request', ...payload }, userId, sessionId), sendWithoutSession: (payload: any) => handler({ type: 'jar_bridge:request', ...payload }, 'owner') };
}

describe('JAR loopback transport', () => {
  test('normalizes only literal IPv4/IPv6 loopback or localhost with a valid port', () => {
    expect(normalizeJarBase()).toBe('http://127.0.0.1:4577');
    expect(normalizeJarBase('http://localhost')).toBe('http://127.0.0.1:4577');
    expect(normalizeJarBase(' http://LOCALHOST:4580/ ')).toBe('http://127.0.0.1:4580');
    expect(normalizeJarBase('http://[::1]:4578')).toBe('http://[::1]:4578');
    for (const url of ['https://127.0.0.1:4577', 'file:///capture', 'http://127.1:4577', 'http://2130706433:4577', 'http://0177.0.0.1:4577', 'http://127.0.0.2:4577', 'http://localhost.example:4577', 'http://user:pass@127.0.0.1:4577', 'http://localhost:4577/api/settings', 'http://localhost:4577?key=secret', 'http://localhost:4577#anything', 'http://localhost:0', 'http://localhost:65536', 'http://localhost:80@evil.example', 'http://localhost:4577\\api\\settings']) expect(() => normalizeJarBase(url)).toThrow();
  });
  test('uses only the fixed GET routes and rejects forged route objects', async () => {
    const f = fixture(); const get = createJarTransport(f.api, 'http://localhost:4577', { current: () => true });
    await get({ kind: 'version' }); await get({ kind: 'captures' }); await get({ kind: 'card', recordId: '123-abc' });
    await expect(get({ kind: 'card', recordId: '../settings' })).rejects.toThrow('Invalid');
    await expect(get({ kind: 'settings' } as any)).rejects.toThrow('Invalid');
    expect(f.calls.map(c => c.url)).toEqual(['http://127.0.0.1:4577/api/version', 'http://127.0.0.1:4577/api/captures', 'http://127.0.0.1:4577/api/captures/123-abc']);
    expect(f.calls.every(c => c.options.method === 'GET' && c.options.body === undefined && c.options.headers.Authorization === undefined)).toBe(true);
  });
  test('does not expose remote error bodies or transport exception details', async () => {
    for (const cors of [async () => response({ error: 'PRIVATE_TOKEN' }, 500), async () => { throw new Error('PRIVATE_TOKEN'); }]) {
      const f = fixture({ cors }); const get = createJarTransport(f.api, undefined as any, { current: () => true });
      try { await get({ kind: 'captures' }); throw new Error('Unexpected success'); }
      catch (e) { expect(String(e)).not.toContain('PRIVATE_TOKEN'); }
    }
  });
  test('rejects non-JSON and invalid proxy response shapes', async () => {
    for (const result of [{ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>JAR?</html>' }, { status: 200, body: '{broken' }, { status: 200, body: {}, headers: {} }, { status: 200, body: 'e30=', encoding: 'base64' }]) {
      const f = fixture({ cors: async () => result });
      await expect(createJarTransport(f.api, undefined as any, { current: () => true })({ kind: 'captures' })).rejects.toThrow();
    }
  });
  test('enforces the native 25MiB byte limit including multibyte JSON', async () => {
    const body = '"' + 'é'.repeat(Math.floor(MAX_JAR_RESPONSE_BYTES / 2)) + '"';
    const f = fixture({ cors: async () => ({ status: 200, headers: {}, body }) });
    await expect(createJarTransport(f.api, undefined as any, { current: () => true })({ kind: 'captures' })).rejects.toThrow('too large');
  });
});

describe('safe actionable JAR connection errors', () => {
  async function failedMessage(value: unknown, route: Parameters<ReturnType<typeof createJarTransport>>[0] = { kind: 'history', chatId: '31415' }) {
    const f = fixture({ cors: async () => value });
    try { await createJarTransport(f.api, 'http://localhost', { current: () => true })(route); throw new Error('Unexpected success'); }
    catch (error) { return String(error); }
  }
  test('native timeout and interrupted requests get fixed guidance without exposing exception details', async () => {
    for (const failure of [new Error('Request timed out after 30000ms PRIVATE_TOKEN'), new Error('TimeoutError: PRIVATE_COOKIE')]) {
      const f = fixture({ cors: async () => { throw failure; } });
      await expect(createJarTransport(f.api, 'http://localhost', { current: () => true })({ kind: 'history', chatId: '31415' })).rejects.toThrow('connection time limit');
      try { await createJarTransport(f.api, 'http://localhost', { current: () => true })({ kind: 'history', chatId: '31415' }); }
      catch (error) { expect(String(error)).not.toContain('PRIVATE'); expect(String(error)).toContain('SillyTavern JSONL'); }
    }
    const interrupted = fixture({ cors: async () => { throw Object.assign(new Error('PRIVATE_COOKIE'), { name: 'AbortError' }); } });
    await expect(createJarTransport(interrupted.api, 'http://localhost', { current: () => true })({ kind: 'captures' })).rejects.toThrow('interrupted');
    const network = fixture({ cors: async () => { throw new Error('ECONNREFUSED PRIVATE_ADDRESS'); } });
    try { await createJarTransport(network.api, 'http://localhost', { current: () => true })({ kind: 'captures' }); }
    catch (error) { expect(String(error)).toContain('Lumiverse server computer'); expect(String(error)).not.toContain('PRIVATE'); }
  });
  test('classifies signed-out and expired-session JSON errors without returning their raw text', async () => {
    for (const detail of ['Not logged into JanitorAI — open the JanitorAI session panel and Log in first.', 'Sign in required', 'Session expired', 'fetch chat failed: HTTP 401']) {
      const message = await failedMessage(response({ error: `${detail} PRIVATE_TOKEN http://user:secret@private.invalid` }, 500));
      expect(message).toContain('not signed into JanitorAI'); expect(message).toContain('Log in button'); expect(message).not.toContain('PRIVATE'); expect(message).not.toContain('secret');
    }
  });
  test('classifies JAR browser contention separately from missing service and missing access', async () => {
    for (const detail of ['the capture browser is busy (a login or extraction is already running)', 'operation is already running']) {
      const message = await failedMessage(response({ error: `${detail} PRIVATE_SESSION` }, 500));
      expect(message).toContain('already handling another operation'); expect(message).not.toContain('PRIVATE'); expect(message).not.toContain('Could not reach');
    }
    for (const detail of ['fetch chat failed: HTTP 403', 'fetch chat failed: HTTP 404', 'conversation unavailable', 'conversation not found']) {
      const message = await failedMessage(response({ error: `${detail} PRIVATE_ARCHIVE` }, 500));
      expect(message).toContain('account that owns it'); expect(message).toContain('SillyTavern JSONL'); expect(message).not.toContain('PRIVATE');
    }
    const character = await failedMessage(response({ error: 'Character unavailable PRIVATE' }, 404), { kind: 'inspect', sourceUrl: characterLink });
    expect(character).toContain('cannot access this character'); expect(character).toContain('downloaded card file'); expect(character).not.toContain('PRIVATE');
    const missingRecord = await failedMessage(response({ error: 'PRIVATE' }, 404), { kind: 'card', recordId: 'missing-record' });
    expect(missingRecord).toContain('no longer in JAR'); expect(missingRecord).not.toContain('PRIVATE');
    expect(await failedMessage(response({ error: 'this conversation has no messages' }, 404))).toContain('no messages to import');
  });
  test('only bounded JSON error replies can select a known error category', async () => {
    const unknown = [
      { status: 500, headers: { 'content-type': 'text/html' }, body: '{"error":"Not logged into JanitorAI PRIVATE"}' },
      { status: 500, headers: {}, body: '{"error":"Not logged into JanitorAI PRIVATE"}' },
      { status: 500, headers: { 'content-type': 'application/json' }, body: '{broken Not logged into JanitorAI PRIVATE' },
      { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'Not logged into JanitorAI PRIVATE' } }) },
      { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Not logged into JanitorAI ' + 'PRIVATE'.repeat(400) }) },
      { status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'Not logged into JanitorAI', padding: 'é'.repeat(4200) }) },
      { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"Not logged into JanitorAI PRIVATE"}', encoding: 'base64' },
      { status: '500', headers: { 'content-type': 'application/json' }, body: '{"error":"Not logged into JanitorAI PRIVATE"}' },
      { status: 302, headers: { 'content-type': 'application/json' }, body: '{"error":"Not logged into JanitorAI PRIVATE"}' },
      response({ error: 'Unrecognized error PRIVATE_TOKEN' }, 500),
    ];
    for (const value of unknown) {
      const message = await failedMessage(value); expect(message).toContain('could not load this conversation');
      expect(message).toContain('JSON or SillyTavern JSONL'); expect(message).toContain('Chat history → History file');
      expect(message).not.toContain('not signed into'); expect(message).not.toContain('PRIVATE');
    }
    const okay = fixture({ cors: async () => response({ error: 'Not logged into JanitorAI' }, 200) });
    expect(await createJarTransport(okay.api, 'http://localhost', { current: () => true })({ kind: 'captures' })).toEqual({ error: 'Not logged into JanitorAI' });
  });
  test('unrecognized linked-chat errors explain the same file fallback without revealing JAR details', async () => {
    const message = await failedMessage(response({ error: 'PRIVATE unfamiliar failure' }, 500), { kind: 'link-chat', sourceUrl: 'https://janitorai.com/chats/9876543210' });
    expect(message).toContain('could not load this link'); expect(message).toContain('JSON or SillyTavern JSONL');
    expect(message).toContain('Chat history → History file'); expect(message).not.toContain('PRIVATE');
    const generic = await failedMessage(response({ error: 'PRIVATE' }, 500), { kind: 'captures' });
    expect(generic).toContain('could not complete this request'); expect(generic).not.toContain('PRIVATE');
  });
  test('cancellation remains silent at backend level when a native connection fails late', async () => {
    let current = true;
    const f = fixture({ cors: async () => { current = false; throw new Error('Timeout PRIVATE'); } });
    await expect(createJarTransport(f.api, 'http://localhost', { current: () => current })({ kind: 'history', chatId: '31415' })).rejects.toThrow('cancelled');
  });
});

describe('JAR character adapter', () => {
  test('preserves only the public numeric SoundCloud attachment from JAR metadata', () => {
    const input = { ...record(), meta: { soundcloud_track_id: '1099971685', session_token: 'PRIVATE', scripts: 'PRIVATE', description: 'PRIVATE' } };
    expect(toCardV2(input).card.data.extensions.jar_bridge).toEqual({ soundcloud_track_id: '1099971685' });
    expect(JSON.stringify(toCardV2(input))).not.toContain('PRIVATE');
    expect(toCardV2({ ...record(), meta: { soundcloud_track_id: 1099971685 } }).card.data.extensions.jar_bridge).toEqual({ soundcloud_track_id: '1099971685' });
    for (const track of [0, -2, 1.2, Number.MAX_SAFE_INTEGER + 1, '', '0', '../settings', 'https://evil.example/track', '1&auto_play=true']) {
      expect(toCardV2({ ...record(), meta: { soundcloud_track_id: track } }).card.data.extensions.jar_bridge).toBeUndefined();
    }
  });
  test('maps all JAR behavior fields exactly and excludes archive metadata', () => {
    const input = record(); const result = toCardV2(input);
    expect(result.recordId).toBe(input.id); expect(result.id).toBe(input.id);
    expect(result.card).toEqual({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: input.character.name, description: input.character.description, personality: 'Careful', scenario: 'A place', first_mes: 'Hello {{user}}', alternate_greetings: ['Alternative one', '', '  Alternative two  '], mes_example: '<START>\n{{char}}: Example', creator_notes: 'Creator note', tags: ['tag one', 'tag two'], system_prompt: '', post_history_instructions: '', creator: '', character_version: '', extensions: {} } });
    expect(result.avatarDataUrl).toBe(input.character.avatarBase64);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(input.character.description).toBe('  Exact {{char}} definition\n\n');
  });
  test('preserves explicit CCv2 instructions, extension behavior and character-book data', () => {
    const source = { id: 'test', character: { spec: 'chara_card_v2', data: { name: 'Name', description: 'Definition', first_mes: '', firstMessage: 'stale greeting', system_prompt: 'System', post_history_instructions: 'Last', character_version: '2.1', creator: 'Author', extensions: { depth_prompt: { prompt: 'Go slowly', depth: 3 }, nested: { api_key: 'PRIVATE', 'refresh-token': 'PRIVATE', session_token: 'PRIVATE', client_secret: 'PRIVATE', harmless: 'Retain me' } }, character_book: { name: 'Book', entries: [{ keys: ['garden'], content: 'Flowers', enabled: true }] } } } };
    const result = toCardV2(source);
    expect(result.card.data.first_mes).toBe(''); expect(result.card.data.system_prompt).toBe('System'); expect(result.card.data.post_history_instructions).toBe('Last');
    expect(result.card.data.creator).toBe('Author'); expect(result.card.data.character_version).toBe('2.1');
    expect(result.card.data.extensions).toEqual({ depth_prompt: { prompt: 'Go slowly', depth: 3 }, nested: { harmless: 'Retain me' } });
    expect(result.card.data.character_book).toEqual(source.character.data.character_book);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  test('rejects pending and name-only cards rather than inventing a definition', () => {
    for (const character of [{ name: 'Only name' }, { name: 'Pending', description: 'A placeholder', definitionSource: 'pending' }, { name: 'Notes only', creatorNotes: 'Creator introduction', tags: ['tag'] }]) expect(() => toCardV2({ id: 'test', character })).toThrow('Finish card in JAR');
    expect(() => toCardV2({ id: '../settings', character: record().character })).toThrow('invalid character ID');
    expect(() => toCardV2({ id: 'test', character: { name: 'Name', description: 'Definition', alternateGreetings: ['valid', {}] } })).toThrow('invalid greetings');
  });
  test('does not parse raw prompts, and only accepts explicit computed character data', () => {
    expect(() => toCardV2({ id: 'test', payload: { messages: [{ role: 'system', content: 'PRIVATE prompt' }] } }, { systemContent: 'PRIVATE prompt', lorebookText: 'PRIVATE lore' })).toThrow('Finish card in JAR');
    expect(toCardV2({ id: 'test', character: { definitionSource: 'pending' } }, { character: { name: 'Computed', description: 'Saved definition' } }).name).toBe('Computed');
  });
  test('returns stored avatar data only and warns if an unusable saved avatar was omitted', () => {
    const input: any = record(); delete input.character.avatarBase64; input.avatarBase64 = 'data:image/webp;base64,UklGRg==';
    expect(toCardV2(input).avatarDataUrl).toBe(input.avatarBase64);
    input.avatarBase64 = 'https://private-avatar.example/image?token=PRIVATE';
    const result = toCardV2(input); expect(result.avatarDataUrl).toBeUndefined(); expect(result.warnings?.[0]).toContain('avatar'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  test('summaries contain only character identity, source and latest timestamp', () => {
    expect(normalizeSummaries([{ id: '1-test', characterName: 'Name', source: 'inspect', ts: 5, refreshedAt: 9, capturedAt: 7, preview: 'PRIVATE', model: 'PRIVATE', url: 'PRIVATE', messageCount: 9 }])).toEqual([{ id: '1-test', name: 'Name', source: 'inspect', ts: 9 }]);
  });
});

describe('JAR backend account, permission and session boundaries', () => {
  test('connect returns normalized summaries solely to the trusted originating document', async () => {
    const f = fixture(); f.send({ id: 'connect-1', command: 'connect', baseUrl: 'http://localhost:4577', userId: 'forged', frontendSessionId: 'forged' }); await wait();
    expect(f.calls).toHaveLength(2); expect(f.replies).toEqual([{ payload: { type: 'jar_bridge:response', id: 'connect-1', command: 'connect', result: { version: '0.4.0', captures: [{ id: '123-abc', name: 'Test', source: 'inspect', ts: 10 }] } }, userId: 'owner', options: { frontendSessionId: 'tab-one' } }]);
    expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
  });
  test('card reads only the selected record and returns a clean CCv2, never calls separation/import/browser/provider routes', async () => {
    const f = fixture(); f.send({ id: 'card-1', command: 'card', recordId: '123-abc' }); await wait();
    expect(f.calls.map(c => c.url)).toEqual(['http://127.0.0.1:4577/api/captures/123-abc']);
    expect(f.replies[0].payload.result.recordId).toBe('123-abc'); expect(f.replies[0].payload.result.card.data.first_mes).toBe('Hello {{user}}'); expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
  });
  test('no trusted session or missing host session-routing capability means no request or broadcast', async () => {
    const f = fixture(); f.sendWithoutSession({ id: 'a', command: 'connect' }); f.send({ id: 'b', command: 'connect' }, '');
    const oldHost = fixture({ capabilities: {} }); oldHost.send({ id: 'c', command: 'connect' }); await wait();
    expect(f.calls).toHaveLength(0); expect(f.replies).toHaveLength(0); expect(oldHost.calls).toHaveLength(0); expect(oldHost.replies).toHaveLength(0);
  });
  test('missing/mismatched installer pin or another admin account cannot read the local archive', async () => {
    for (const pin of [null, {}, { schemaVersion: 1, ownerUserId: 'owner', installationId: 'other-installation' }, { schemaVersion: 2, ownerUserId: 'owner', installationId: 'installed-one' }]) {
      const f = fixture({ pin }); f.send({ id: 'pin', command: 'connect' }); await wait(); expect(f.calls).toHaveLength(0); expect(f.replies[0].payload.error).toContain('account');
    }
    const other = fixture(); other.send({ id: 'admin', command: 'connect' }, 'another-admin'); await wait(); expect(other.calls).toHaveLength(0); expect(other.replies[0].userId).toBe('another-admin'); expect(other.replies[0].options.frontendSessionId).toBe('tab-one');
  });
  test('missing cors permission means no request; backend never requests permission itself', async () => {
    const f = fixture({ granted: async () => [] }); f.send({ id: 'permission', command: 'connect' }); await wait();
    expect(f.calls).toHaveLength(0); expect(f.replies[0].payload.error).toContain('permissions');
  });
  test('rechecks cors permission before each GET in the connect sequence', async () => {
    let grants = 0; const f = fixture({ granted: async () => ++grants <= 2 ? ['cors_proxy'] : [] });
    f.send({ id: 'late-permission', command: 'connect' }); await wait();
    expect(f.calls.map(c => c.url)).toEqual(['http://127.0.0.1:4577/api/version']); expect(f.replies[0].payload.result).toBeUndefined();
  });
  test('permission revoked while a card read is in flight prevents exposing the response', async () => {
    let allowed = true; const f = fixture({ granted: async () => allowed ? ['cors_proxy'] : [], cors: async () => { allowed = false; return response(record()); } });
    f.send({ id: 'revoked', command: 'card', recordId: '123-abc' }); await wait();
    expect(f.calls).toHaveLength(1); expect(f.replies[0].payload.result).toBeUndefined(); expect(f.replies[0].payload.error).toContain('removed');
  });
  test('invalid base URLs and IDs do not reach JAR', async () => {
    const f = fixture(); f.send({ id: 'bad-url', command: 'connect', baseUrl: 'http://evil.example' }); await wait();
    f.send({ id: 'bad-id', command: 'card', recordId: '../settings' }); await wait(); expect(f.calls).toHaveLength(0); expect(f.replies).toHaveLength(2);
  });
  test('a mismatched record or unfinished definition never becomes an importable card', async () => {
    for (const value of [record('different'), { id: '123-abc', character: { name: 'Pending', definitionSource: 'pending' } }]) {
      const f = fixture({ cors: async () => response(value) }); f.send({ id: 'bad-card', command: 'card', recordId: '123-abc' }); await wait(); expect(f.replies[0].payload.result).toBeUndefined(); expect(f.replies[0].payload.error).toBeTruthy();
    }
  });
  test('cancel suppresses an in-flight response and prevents the next GET', async () => {
    const pending = deferred<unknown>(); const f = fixture({ cors: async () => pending.promise });
    f.send({ id: 'cancelled', command: 'connect' }); await wait(); f.send({ id: 'cancelled', command: 'cancel' }); pending.resolve(response({ version: '0.4.0' })); await wait();
    expect(f.calls).toHaveLength(1); expect(f.replies).toHaveLength(0);
  });
  test('replacing a document request suppresses old results without cancelling another document', async () => {
    const pending = deferred<unknown>(); const f = fixture({ cors: async url => url.endsWith('/api/version') ? pending.promise : response(record()) });
    f.send({ id: 'old', command: 'connect' }); await wait(); f.send({ id: 'new', command: 'card', recordId: '123-abc' }); f.send({ id: 'other-tab', command: 'card', recordId: '123-abc' }, 'owner', 'tab-two'); await wait();
    pending.resolve(response({ version: '0.4.0' })); await wait();
    expect(f.replies.map(r => r.payload.id).sort()).toEqual(['new', 'other-tab']); expect(f.replies.find(r => r.payload.id === 'other-tab')?.options.frontendSessionId).toBe('tab-two'); expect(f.calls).toHaveLength(3);
  });
  test('cancel is scoped to the originating document and matching job ID', async () => {
    const pending = deferred<unknown>(); const f = fixture({ cors: async () => pending.promise }); f.send({ id: 'card', command: 'card', recordId: '123-abc' }); await wait();
    f.send({ id: 'card', command: 'cancel' }, 'owner', 'tab-two'); f.send({ id: 'different', command: 'cancel' }); pending.resolve(response(record())); await wait(); expect(f.replies.map(r => r.payload.id)).toEqual(['card']);
  });
  test('teardown unsubscribes and prevents late responses or subsequent GETs', async () => {
    const pending = deferred<unknown>(); const f = fixture({ cors: async () => pending.promise }); f.send({ id: 'closed', command: 'connect' }); await wait(); f.destroy(); pending.resolve(response({ version: '0.4.0' })); await wait(); f.send({ id: 'after', command: 'list' }); await wait();
    expect(f.unsubscribed).toBe(true); expect(f.calls).toHaveLength(1); expect(f.replies).toHaveLength(0);
  });
});

function linkedRecord() {
  return { ...record(), characterId: 'janitor-character-id', conversations: [
    { chatId: '31415', title: 'Original title', label: 'A saved conversation', messageCount: 3, updatedAt: '2026-10-25T10:00:00.000Z', createdAt: '2026-10-20T10:00:00.000Z', url: 'https://janitorai.com/chats/31415', metadata: 'PRIVATE_LINK' },
  ] };
}
function historyExport() {
  return { chatId: '31415', characterName: 'Character name', userName: 'Persona name', messageCount: 3,
    raw: { chat: { id: 31415, character_id: 'janitor-character-id' }, character: { id: 'janitor-character-id' }, personas: ['PRIVATE_PERSONA'], settings: { token: 'PRIVATE_TOKEN' } },
    jsonl: [
      { name: 'A chat title', create_date: '2026-10-20T10:00:00.000Z', chat_metadata: { janitor_chat_id: 31415, janitor_character_id: 'janitor-character-id', note_prompt: 'PRIVATE_NOTE', settings: { apiKey: 'PRIVATE' } } },
      { name: 'Persona name', is_user: true, is_system: false, mes: '  Exact user text\n', send_date: '2026-10-20T10:00:00.000Z', extra: { janitor_metadata: 'PRIVATE_MESSAGE_METADATA' } },
      { name: 'Character name', is_user: false, is_system: false, mes: 'Selected answer', send_date: '2026-10-20T10:02:00.000Z', gen_started: '2026-10-20T10:02:00.000Z', gen_finished: '2026-10-20T10:02:01.000Z', swipes: ['Alternative answer', 'Selected answer'], swipe_id: 1,
        extra: { api: 'imported', model: 'janitorai-import', token_count: 4, janitor_metadata: { apiKey: 'PRIVATE' } },
        swipe_info: [{ send_date: '2026-10-20T10:01:00.000Z', gen_started: '2026-10-20T10:01:00.000Z', gen_finished: '2026-10-20T10:01:01.000Z', extra: { model: 'janitorai-import', janitor_metadata: 'PRIVATE' } }, { send_date: '2026-10-20T10:02:00.000Z', gen_started: '2026-10-20T10:02:00.000Z', gen_finished: '2026-10-20T10:02:01.000Z' }],
        force_avatar: 'https://private.example?token=PRIVATE', payload: 'PRIVATE' },
    ].map(row => JSON.stringify(row)).join('\n') };
}

describe('selected JAR conversation adapters', () => {
  test('returns only saved lightweight links with no raw URL, profile or captured prompt data', () => {
    const linked = linkedRecord(); const result = toConversations(linked);
    expect(result).toEqual({ recordId: '123-abc', characterName: linked.character.name, conversations: [{ chatId: '31415', title: 'A saved conversation', messageCount: 3, updatedAt: '2026-10-25T10:00:00.000Z', createdAt: '2026-10-20T10:00:00.000Z' }] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const malformed: any = linkedRecord(); malformed.conversations.push({ chatId: '../settings' }, { chatId: '31415', title: 'duplicate' });
    expect(toConversations(malformed).conversations).toHaveLength(1);
  });
  test('requires a saved exact chat link plus the character ID, and never accepts chat URLs as IDs', () => {
    expect(assertLinkedConversation(linkedRecord(), '31415')).toEqual({ recordId: '123-abc', characterId: 'janitor-character-id', chatId: '31415' });
    for (const chatId of ['99999', '../settings', 'https://janitorai.com/chats/31415', 31415]) expect(() => assertLinkedConversation(linkedRecord(), chatId)).toThrow();
    expect(() => assertLinkedConversation({ ...linkedRecord(), characterId: '' }, '31415')).toThrow('not linked');
  });
  test('preserves exact message text, selected swipe and all alternate dates while removing arbitrary metadata', () => {
    const output = toHistory(linkedRecord(), '31415', historyExport()); const rows = output.jsonl.split('\n').map(line => JSON.parse(line));
    expect(output.recordId).toBe('123-abc'); expect(output.chatId).toBe('31415'); expect(output.messageCount).toBe(2); expect(output.userName).toBe('Persona name');
    expect(rows[0]).toEqual({ name: 'A chat title', create_date: '2026-10-20T10:00:00.000Z', chat_metadata: { imported_from: 'janitorai', janitor_chat_id: '31415', janitor_character_id: 'janitor-character-id' } });
    expect(rows[1].mes).toBe('  Exact user text\n'); expect(rows[1].name).toBe('Persona name'); expect(rows[1].is_user).toBe(true);
    expect(rows[2].mes).toBe('Selected answer'); expect(rows[2].swipes).toEqual(['Alternative answer', 'Selected answer']); expect(rows[2].swipe_id).toBe(1);
    expect(rows[2].swipe_info[0]).toEqual({ send_date: '2026-10-20T10:01:00.000Z', gen_started: '2026-10-20T10:01:00.000Z', gen_finished: '2026-10-20T10:01:01.000Z', extra: { model: 'janitorai-import' } });
    expect(rows[2].swipe_info[1].send_date).toBe('2026-10-20T10:02:00.000Z'); expect(JSON.stringify(output)).not.toContain('PRIVATE'); expect(output).not.toHaveProperty('raw');
  });
  test('rejects missing, conflicting or cross-character raw export identities and JSONL header identities', () => {
    for (const mutate of [
      (out: any) => { out.chatId = '99999'; },
      (out: any) => { out.raw.chat.id = 99999; },
      (out: any) => { out.raw.chat.chat_id = '99999'; },
      (out: any) => { out.raw.character.id = 'other-character'; },
      (out: any) => { out.raw.chat.character_id = 'other-character'; },
      (out: any) => { delete out.raw; },
      (out: any) => { out.jsonl = out.jsonl.replace('"janitor_chat_id":31415', '"janitor_chat_id":99999'); },
      (out: any) => { out.jsonl = out.jsonl.replace('"janitor_character_id":"janitor-character-id"', '"janitor_character_id":"other-character"'); },
    ]) { const out = historyExport(); mutate(out); expect(() => toHistory(linkedRecord(), '31415', out)).toThrow(); }
    const optionalAbsent: any = historyExport(); optionalAbsent.raw.chat.character_id = null; optionalAbsent.raw.chat.chat_id = null;
    expect(toHistory(linkedRecord(), '31415', optionalAbsent).chatId).toBe('31415');
  });
  test('rejects malformed history rather than silently skipping messages or resetting selected alternatives', () => {
    for (const mutate of [
      (rows: any[]) => { rows[1].mes = 12; },
      (rows: any[]) => { rows[1].send_date = 'not a date'; },
      (rows: any[]) => { rows[2].swipe_id = 12; },
      (rows: any[]) => { rows[2].swipe_info.pop(); },
      (rows: any[]) => { rows[2].swipe_info[0] = null; },
      (rows: any[]) => { rows[2].swipe_info[0] = []; },
      (rows: any[]) => { rows[2].swipe_info[0] = 42; },
      (rows: any[]) => { rows[2].swipe_info[0].send_date = 'PRIVATE_DATE'; },
      (rows: any[]) => { rows[0].create_date = 'PRIVATE_DATE'; },
    ]) { const out = historyExport(); const rows = out.jsonl.split('\n').map(line => JSON.parse(line)); mutate(rows); out.jsonl = rows.map(row => JSON.stringify(row)).join('\n'); expect(() => toHistory(linkedRecord(), '31415', out)).toThrow(); }
  });
  test('preserves a legitimate conversation title in chat_metadata without copying its settings', () => {
    const out = historyExport(); const rows = out.jsonl.split('\n').map(line => JSON.parse(line)); delete rows[0].name;
    rows[0].chat_metadata.name = '  My saved title  '; out.jsonl = rows.map(row => JSON.stringify(row)).join('\n');
    const exported = toHistory(linkedRecord(), '31415', out); const header = JSON.parse(exported.jsonl.split('\n')[0]);
    expect(header.name).toBe('  My saved title  '); expect(header.chat_metadata).not.toHaveProperty('name'); expect(exported.jsonl).not.toContain('PRIVATE');
  });
  test('retains an available source-chat creation date when JAR omits it from the JSONL header', () => {
    const out: any = historyExport(); const rows = out.jsonl.split('\n').map((line: string) => JSON.parse(line)); delete rows[0].create_date;
    out.jsonl = rows.map((row: unknown) => JSON.stringify(row)).join('\n'); out.raw.chat.created_at = '2026-10-19T08:00:00Z';
    expect(JSON.parse(toHistory(linkedRecord(), '31415', out).jsonl.split('\n')[0]).create_date).toBe('2026-10-19T08:00:00Z');
    rows[0].create_date = '2026-10-18T08:00:00Z'; out.jsonl = rows.map((row: unknown) => JSON.stringify(row)).join('\n');
    expect(JSON.parse(toHistory(linkedRecord(), '31415', out).jsonl.split('\n')[0]).create_date).toBe('2026-10-18T08:00:00Z');
    delete rows[0].create_date; out.jsonl = rows.map((row: unknown) => JSON.stringify(row)).join('\n'); out.raw.chat.created_at = 1792396800;
    expect(JSON.parse(toHistory(linkedRecord(), '31415', out).jsonl.split('\n')[0])).not.toHaveProperty('create_date');
    out.raw.chat.created_at = 'not a date'; expect(JSON.parse(toHistory(linkedRecord(), '31415', out).jsonl.split('\n')[0])).not.toHaveProperty('create_date');
  });
});

describe('JAR selected-history backend requests', () => {
  test('setup/connect/card/local linked-chat listing never request a JanitorAI history export', async () => {
    const f = fixture({ cors: async url => response(url.endsWith('/api/version') ? { version: '0.4.0' } : url.endsWith('/api/captures') ? [] : linkedRecord()) });
    expect(f.calls).toHaveLength(0);
    for (const command of ['connect', 'card', 'conversations']) { f.send({ id: command, command, recordId: '123-abc' }); await wait(); }
    expect(f.calls.every(call => call.options.method === 'GET')).toBe(true); expect(f.calls.some(call => call.url.includes('chat-export') || call.url.includes('character-conversations'))).toBe(false);
    expect(f.replies.at(-1)?.payload.result.conversations[0].chatId).toBe('31415'); expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
  });
  test('explicit Load history revalidates the selected record then exports only its selected linked numeric chat', async () => {
    const f = fixture({ cors: async url => response(url.endsWith('/api/chat-export') ? historyExport() : linkedRecord()) });
    f.send({ id: 'load-history', command: 'history', recordId: '123-abc', chatId: '31415' }); await wait();
    expect(f.calls.map(call => ({ url: call.url, method: call.options.method, body: call.options.body }))).toEqual([
      { url: 'http://127.0.0.1:4577/api/captures/123-abc', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:4577/api/chat-export', method: 'POST', body: '{"chat":"31415"}' },
    ]);
    expect(f.replies[0].payload.result.messageCount).toBe(2); expect(f.replies[0].payload.result.jsonl).toContain('Selected answer'); expect(JSON.stringify(f.replies)).not.toContain('PRIVATE'); expect(f.replies[0].options).toEqual({ frontendSessionId: 'tab-one' });
  });
  test('unlinked chat IDs and missing character IDs cannot start JAR remote exports', async () => {
    for (const [chatId, selected] of [['99999', linkedRecord()], ['31415', { ...linkedRecord(), characterId: '' }]] as const) {
      const f = fixture({ cors: async () => response(selected) }); f.send({ id: 'wrong-link', command: 'history', recordId: '123-abc', chatId }); await wait();
      expect(f.calls).toHaveLength(1); expect(f.calls[0].options.method).toBe('GET'); expect(f.replies[0].payload.result).toBeUndefined(); expect(f.replies[0].payload.error).toContain('not linked');
    }
  });
  test('invalid chat IDs are rejected before even reading the selected archive record', async () => {
    const f = fixture(); f.send({ id: 'invalid-chat', command: 'history', recordId: '123-abc', chatId: '../settings' }); await wait(); expect(f.calls).toHaveLength(0); expect(f.replies[0].payload.result).toBeUndefined();
  });
  test('permission revocation before the export POST prevents a remote history request', async () => {
    let checks = 0; const f = fixture({ granted: async () => ++checks <= 2 ? ['cors_proxy'] : [], cors: async () => response(linkedRecord()) });
    f.send({ id: 'revoked-history', command: 'history', recordId: '123-abc', chatId: '31415' }); await wait(); expect(f.calls).toHaveLength(1); expect(f.replies[0].payload.result).toBeUndefined();
  });
  test('lost installer owner pin between the record read and export prevents a remote request', async () => {
    const f = fixture({ cors: async () => { f.api.storage.read = async () => '{}'; return response(linkedRecord()); } });
    f.send({ id: 'lost-pin', command: 'history', recordId: '123-abc', chatId: '31415' }); await wait(); expect(f.calls).toHaveLength(1); expect(f.replies[0].payload.result).toBeUndefined();
  });
  test('wrong-character exports never expose messages or raw results to the frontend', async () => {
    const wrong = historyExport(); wrong.raw.character.id = 'wrong-character';
    const f = fixture({ cors: async url => response(url.endsWith('/api/chat-export') ? wrong : linkedRecord()) });
    f.send({ id: 'wrong-history', command: 'history', recordId: '123-abc', chatId: '31415' }); await wait(); expect(f.replies[0].payload.result).toBeUndefined(); expect(f.replies[0].payload.error).toContain('different character or chat'); expect(JSON.stringify(f.replies)).not.toContain('Selected answer');
  });
  test('cancelled local record reads cannot proceed to remote conversation export', async () => {
    const pending = deferred<unknown>(); const f = fixture({ cors: async () => pending.promise }); f.send({ id: 'cancel-history', command: 'history', recordId: '123-abc', chatId: '31415' }); await wait();
    f.send({ id: 'cancel-history', command: 'cancel' }); pending.resolve(response(linkedRecord())); await wait(); expect(f.calls).toHaveLength(1); expect(f.replies).toHaveLength(0);
  });
  test('cancelled in-flight remote history exports cannot deliver late conversation messages', async () => {
    const pending = deferred<unknown>(); const f = fixture({ cors: async url => url.endsWith('/api/chat-export') ? pending.promise : response(linkedRecord()) });
    f.send({ id: 'cancel-export', command: 'history', recordId: '123-abc', chatId: '31415' }); await wait(); expect(f.calls).toHaveLength(2);
    f.send({ id: 'cancel-export', command: 'cancel' }); pending.resolve(response(historyExport())); await wait(); expect(f.replies).toHaveLength(0);
  });
});

const linkCharacterId = '12345678-1234-1234-1234-123456789abc';
const characterLink = `https://janitorai.com/characters/${linkCharacterId}`;
const chatLink = 'https://janitorai.com/chats/31415';
function directRecord() { return { ...linkedRecord(), characterId: linkCharacterId }; }
function directExport() {
  const output = historyExport();
  output.raw.character.id = linkCharacterId;
  output.raw.chat.character_id = linkCharacterId;
  output.jsonl = output.jsonl.replaceAll('janitor-character-id', linkCharacterId);
  return output;
}
function directResponse(url: string) {
  return response(url.endsWith('/api/inspect') ? { id: '123-abc', raw: 'PRIVATE_INSPECT' }
    : url.endsWith('/api/chat-import') ? { id: '123-abc', conversation: { chatId: '31415' }, raw: 'PRIVATE_CHAT' }
    : url.endsWith('/api/chat-export') ? directExport() : directRecord());
}

describe('explicit pasted JanitorAI links', () => {
  test('character preview only inspects the canonical selected URL and returns a sanitized card', async () => {
    const f = fixture({ cors: async url => directResponse(url) });
    expect(f.calls).toHaveLength(0);
    f.send({ id: 'character-link', command: 'preview-link', sourceUrl: `${characterLink}-some-name?tracking=PRIVATE#fragment` }); await wait();
    expect(f.calls.map(call => ({ url: call.url, method: call.options.method, body: call.options.body }))).toEqual([
      { url: 'http://127.0.0.1:4577/api/inspect', method: 'POST', body: JSON.stringify({ url: characterLink }) },
      { url: 'http://127.0.0.1:4577/api/captures/123-abc', method: 'GET', body: undefined },
    ]);
    const result = f.replies[0].payload.result;
    expect(result.kind).toBe('character'); expect(result.sourceUrl).toBe(characterLink); expect(result.characterUrl).toBe(characterLink);
    expect(result.card.recordId).toBe('123-abc'); expect(result.card.card.data.description).toBe(record().character.description);
    expect(result).not.toHaveProperty('history'); expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
    expect(f.replies[0].options).toEqual({ frontendSessionId: 'tab-one' });
  });
  test('chat preview links only the selected chat and exports it without probing or discovering other conversations', async () => {
    const f = fixture({ cors: async url => directResponse(url) });
    f.send({ id: 'chat-link', command: 'preview-link', sourceUrl: `${chatLink}/messages/999?tracking=PRIVATE` }); await wait();
    expect(f.calls.map(call => ({ url: call.url, method: call.options.method, body: call.options.body }))).toEqual([
      { url: 'http://127.0.0.1:4577/api/chat-import', method: 'POST', body: JSON.stringify({ chat: chatLink }) },
      { url: 'http://127.0.0.1:4577/api/captures/123-abc', method: 'GET', body: undefined },
      { url: 'http://127.0.0.1:4577/api/chat-export', method: 'POST', body: JSON.stringify({ chat: '31415' }) },
    ]);
    const result = f.replies[0].payload.result;
    expect(result.kind).toBe('chat'); expect(result.sourceUrl).toBe(chatLink); expect(result.characterUrl).toBe(characterLink);
    expect(result.card.recordId).toBe('123-abc'); expect(result.history.chatId).toBe('31415'); expect(result.history.jsonl).toContain('Selected answer');
    expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
    expect(f.calls.every(call => !/capture$|extract|separate|character-conversations|settings|login|save-|hampter|lumiverse/i.test(new URL(call.url).pathname))).toBe(true);
  });
  test('incomplete definitions give file guidance and still permit the exact chat history preview', async () => {
    const pending = { ...directRecord(), character: { name: 'Pending', definitionSource: 'pending' } };
    for (const sourceUrl of [characterLink, chatLink]) {
      const f = fixture({ cors: async url => url.includes('/api/captures/') ? response(pending) : directResponse(url) });
      f.send({ id: 'pending-link', command: 'preview-link', sourceUrl }); await wait();
      const result = f.replies[0].payload.result;
      expect(result.card).toBeUndefined(); expect(result.warning).toContain('card file');
      if (sourceUrl === chatLink) expect(result.history.chatId).toBe('31415');
      else expect(result.history).toBeUndefined();
    }
  });
  test('reuses only a complete previously verified record in the same account, document and JAR address', async () => {
    const f = fixture({ cors: async url => directResponse(url) });
    f.send({ id: 'first-link', command: 'preview-link', sourceUrl: characterLink }); await wait();
    f.send({ id: 'repeat-link', command: 'preview-link', sourceUrl: characterLink }); await wait();
    expect(f.calls.map(call => new URL(call.url).pathname)).toEqual(['/api/inspect', '/api/captures/123-abc', '/api/captures/123-abc']);
    f.send({ id: 'other-document', command: 'preview-link', sourceUrl: characterLink }, 'owner', 'tab-two'); await wait();
    expect(f.calls.at(-2)!.url).toEndWith('/api/inspect');
    f.send({ id: 'other-address', command: 'preview-link', sourceUrl: characterLink, baseUrl: 'http://localhost:4580' }); await wait();
    expect(f.calls.at(-2)!.url).toBe('http://127.0.0.1:4580/api/inspect');
  });
  test('does not reuse a pending record and never lists or scans unrelated archive records', async () => {
    const pending = { ...directRecord(), character: { name: 'Pending', definitionSource: 'pending' } };
    const f = fixture({ cors: async url => url.includes('/api/captures/') ? response(pending) : directResponse(url) });
    for (const id of ['pending-one', 'pending-two']) { f.send({ id, command: 'preview-link', sourceUrl: characterLink }); await wait(); }
    expect(f.calls.map(call => new URL(call.url).pathname)).toEqual(['/api/inspect', '/api/captures/123-abc', '/api/inspect', '/api/captures/123-abc']);
  });
  test('rejects foreign hosts, malformed links and path tricks before any CORS call', async () => {
    const f = fixture();
    for (const [index, sourceUrl] of [undefined, {}, `https://evil.example/characters/${linkCharacterId}`, `https://janitorai.com/characters/../characters/${linkCharacterId}`, 'https://janitorai.com/chats/31415%2fmessages%2f9', 'https://user:PRIVATE@janitorai.com/chats/31415'].entries()) {
      f.send({ id: `bad-link-${index}`, command: 'preview-link', sourceUrl }); await wait();
    }
    expect(f.calls).toHaveLength(0); expect(f.replies).toHaveLength(6); expect(f.replies.every(reply => !!reply.payload.error && !reply.payload.result)).toBe(true);
    expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
    const get = createJarTransport(f.api, 'http://localhost', { current: () => true });
    await expect(get({ kind: 'inspect', sourceUrl: 'https://evil.example/chats/31415' })).rejects.toThrow();
    await expect(get({ kind: 'inspect', sourceUrl: chatLink })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  test('rejects malformed operation identities and cross-character records before exporting or exposing data', async () => {
    const variants = [
      { sourceUrl: characterLink, operation: { id: '../settings' }, stored: directRecord(), requests: 1 },
      { sourceUrl: characterLink, operation: { id: '123-abc' }, stored: { ...directRecord(), id: 'wrong-record' }, requests: 2 },
      { sourceUrl: characterLink, operation: { id: '123-abc' }, stored: { ...directRecord(), characterId: 'different-character' }, requests: 2 },
      { sourceUrl: chatLink, operation: { id: '123-abc', conversation: { chatId: '99999' } }, stored: directRecord(), requests: 1 },
      { sourceUrl: chatLink, operation: { id: '123-abc', conversation: { chatId: '31415' } }, stored: { ...directRecord(), id: 'wrong-record' }, requests: 2 },
      { sourceUrl: chatLink, operation: { id: '123-abc', conversation: { chatId: '31415' } }, stored: { ...directRecord(), conversations: [] }, requests: 2 },
    ];
    for (const variant of variants) {
      const f = fixture({ cors: async url => response(url.includes('/api/captures/') ? variant.stored : variant.operation) });
      f.send({ id: 'wrong-link', command: 'preview-link', sourceUrl: variant.sourceUrl }); await wait();
      expect(f.calls).toHaveLength(variant.requests); expect(f.replies[0].payload.result).toBeUndefined(); expect(f.replies[0].payload.error).toBeTruthy();
      expect(JSON.stringify(f.replies)).not.toContain('PRIVATE');
    }
    const wrong = directExport(); wrong.raw.character.id = 'wrong-character';
    const f = fixture({ cors: async url => url.endsWith('/api/chat-export') ? response(wrong) : directResponse(url) });
    f.send({ id: 'wrong-export', command: 'preview-link', sourceUrl: chatLink }); await wait();
    expect(f.replies[0].payload.result).toBeUndefined(); expect(JSON.stringify(f.replies)).not.toContain('Selected answer');
  });
  test('missing account pin or CORS permission cannot start link inspection or linking', async () => {
    for (const options of [{ pin: {} }, { granted: async () => [] }]) {
      const f = fixture(options); f.send({ id: 'denied-link', command: 'preview-link', sourceUrl: chatLink }); await wait();
      expect(f.calls).toHaveLength(0); expect(f.replies[0].payload.result).toBeUndefined();
    }
  });
  test('rechecks owner pin and CORS permission at every link-preview sequence boundary', async () => {
    for (const stopAfter of [1, 2, 3]) {
      for (const revoke of ['permission', 'pin']) {
        let calls = 0; let allowed = true;
        const f = fixture({ granted: async () => allowed ? ['cors_proxy'] : [], cors: async url => {
          calls++;
          if (calls === stopAfter) {
            if (revoke === 'permission') allowed = false;
            else f.api.storage.read = async () => '{}';
          }
          return directResponse(url);
        } });
        f.send({ id: `revoke-${revoke}-${stopAfter}`, command: 'preview-link', sourceUrl: chatLink }); await wait();
        expect(f.calls).toHaveLength(stopAfter); expect(f.replies[0].payload.result).toBeUndefined(); expect(f.replies[0].payload.error).toBeTruthy();
      }
    }
  });
  test('cancelling during any sequence step suppresses its response and prevents every following request', async () => {
    for (const stopAfter of [1, 2, 3]) {
      const pending = deferred<unknown>(); let calls = 0; let heldUrl = '';
      const f = fixture({ cors: async url => { if (++calls === stopAfter) { heldUrl = url; return pending.promise; } return directResponse(url); } });
      f.send({ id: `cancel-link-${stopAfter}`, command: 'preview-link', sourceUrl: chatLink }); await wait();
      f.send({ id: `cancel-link-${stopAfter}`, command: 'cancel' }); pending.resolve(directResponse(heldUrl)); await wait();
      expect(f.calls).toHaveLength(stopAfter); expect(f.replies).toHaveLength(0);
    }
  });
  test('failed link operations give actionable generic errors without exposing response bodies or browser credentials', async () => {
    for (const sourceUrl of [characterLink, chatLink]) {
      const f = fixture({ cors: async () => response({ error: 'PRIVATE_COOKIE http://user:password@private.invalid' }, 500) });
      f.send({ id: 'failed-link', command: 'preview-link', sourceUrl }); await wait();
      expect(f.replies[0].payload.error).toContain('JAR could not load this link'); expect(f.replies[0].payload.error).toContain('signed into JanitorAI');
      expect(JSON.stringify(f.replies)).not.toContain('PRIVATE'); expect(f.replies[0].payload.result).toBeUndefined();
    }
  });
});
