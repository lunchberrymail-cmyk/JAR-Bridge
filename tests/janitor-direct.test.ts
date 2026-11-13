import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { setupJarBackend } from '../src/backend';
import { accessTokenFrom, toDirectCard, tokenExpiry } from '../src/janitor-direct';
import { createJarClient } from '../src/client';
import { createJanitorLogin } from '../src/janitor-login-ui';
import { withHostUuid } from './host-uuid-fixture';

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 5)); };
const b64url = (value: string) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (exp = Math.floor(Date.now() / 1000) + 3600) => `eyJ${b64url('{"alg":"HS256"}').slice(3)}.${b64url(JSON.stringify({ exp, sub: 'PRIVATE_SUB', email: 'PRIVATE@example.com' }))}.c2lnbmF0dXJl`;
const id = 'c4d8e56a-17f4-4653-8289-b9d6733148a6';
const meta = (extra: Record<string, unknown> = {}) => ({
  id, name: 'pig in makeup | Niklaus', chat_name: 'Klaus', showdefinition: true, allow_proxy: true, avatar: 'abc_DEF-1.webp',
  personality: 'Klaus is {{char}}.', scenario: 'Olympus campus.', first_message: 'Hey.', first_messages: ['Hey.', 'Another greeting.'], example_dialogs: '<START>',
  description: '<p>Creator notes</p>', custom_tags: ['musicmania2'], creator_name: 'Effitoryy', ...extra,
});
function response(body: unknown, status = 200, type = 'application/json') { return { status, headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) }; }

describe('pasted JanitorAI login', () => {
  test('accepts the access token or the sb-…-auth-token cookie, and keeps only the access token', () => {
    const token = jwt();
    const session = JSON.stringify({ access_token: token, refresh_token: 'PRIVATE_REFRESH', user: { email: 'PRIVATE@example.com' } });
    expect(accessTokenFrom(token)).toBe(token);
    expect(accessTokenFrom(`Bearer ${token}`)).toBe(token);
    expect(accessTokenFrom(`base64-${b64url(session)}`)).toBe(token);
    expect(accessTokenFrom(encodeURIComponent(`base64-${b64url(session)}`))).toBe(token);
    expect(accessTokenFrom(session)).toBe(token);
    for (const bad of ['', 'password123', 'eyJ.notajwt', 'x'.repeat(70_000), 42]) expect(() => accessTokenFrom(bad)).toThrow();
    expect(tokenExpiry(jwt(1_900_000_000))).toBe(1_900_000_000);
  });

  test('reads the Bearer token from a pasted Copy as cURL, or its cookie header, without leaking anything else', () => {
    const token = jwt();
    const encoded = `base64-${b64url(JSON.stringify({ access_token: token, refresh_token: 'PRIVATE_REFRESH' }))}`;
    const curl = `curl 'https://janitorai.com/hampter/characters/${id}' -X GET -H 'accept: application/json'`
      + ` -H 'authorization: Bearer ${token}' -H 'cookie: __cf_bm=PRIVATE_CF; sb-auth-auth-token.0=PRIVATE0; sb-auth-auth-token.1=PRIVATE1' --compressed`;
    expect(accessTokenFrom(curl)).toBe(token);
    expect(accessTokenFrom(curl)).not.toContain('PRIVATE');
    // Windows double-quoted cURL with no authorization header falls back to the cookie chunks.
    const cookieOnly = `curl "https://janitorai.com/" -H "accept: */*" -H "cookie: cf_clearance=PRIVATE; sb-auth-auth-token.1=${encoded.slice(40)}; sb-auth-auth-token.0=${encoded.slice(0, 40)}"`;
    expect(accessTokenFrom(cookieOnly)).toBe(token);
    expect(accessTokenFrom(cookieOnly)).not.toContain('PRIVATE_REFRESH');
  });

  test('maps JanitorAI fields to a card and refuses a hidden definition', () => {
    const card = toDirectCard(meta(), id, 'data:image/webp;base64,AAAA');
    expect(card.recordId).toBe(`jai-${id}`); expect(card.sourceUrl).toBe(`https://janitorai.com/characters/${id}`);
    expect(card.card.data).toMatchObject({ name: 'pig in makeup | Niklaus', description: 'Klaus is {{char}}.', scenario: 'Olympus campus.', first_mes: 'Hey.',
      alternate_greetings: ['Another greeting.'], mes_example: '<START>', creator_notes: '<p>Creator notes</p>', tags: ['musicmania2'], creator: 'Effitoryy' });
    expect(() => toDirectCard(meta({ personality: null, scenario: null, first_message: null, first_messages: null, example_dialogs: null, showdefinition: false }), id)).toThrow('hides its definition');
    expect(() => toDirectCard(meta({ personality: null, scenario: null, first_message: null, first_messages: null, example_dialogs: null }), id)).toThrow('Use JAR');
    expect(toDirectCard(meta(), id).warnings?.[0]).toContain('avatar');
  });
});

function backend(cors: (url: string, init: any) => unknown, granted = ['cors_proxy']) {
  let handler: (payload: unknown, userId: string, sessionId?: string) => void = () => {};
  const calls: { url: string; init: any }[] = [], replies: any[] = [], secrets = new Map<string, string>();
  const api: any = {
    host: { extensionInstallationId: 'installed-one', capabilities: { 'frontend-session-routing-v1': 1, 'uuid-v1': 1 } },
    uuid: { v4: () => '00000000-0000-4000-8000-000000000000' },
    storage: { read: async () => JSON.stringify({ schemaVersion: 1, ownerUserId: 'owner', installationId: 'installed-one' }) },
    users: { getRole: async () => 'user' },
    permissions: { getGranted: async () => granted },
    enclave: { put: async (k: string, v: string) => { secrets.set(k, v); }, get: async (k: string) => secrets.get(k) ?? null, delete: async (k: string) => secrets.delete(k), has: async (k: string) => secrets.has(k), list: async () => [...secrets.keys()] },
    cors: async (url: string, init: any) => { calls.push({ url, init }); return cors(url, init); },
    onFrontendMessage: (fn: typeof handler) => { handler = fn; return () => {}; },
    sendToFrontend: (payload: unknown) => { replies.push(payload); },
  };
  cleanups.push(setupJarBackend(api));
  return { calls, replies, secrets, send: (payload: any) => handler({ type: 'jar_bridge:request', ...payload }, 'owner', 'tab-one') };
}
const flush = async () => { for (let i = 0; i < 6; i++) await wait(); };

describe('JanitorAI login backend', () => {
  test('saving checks the login with JanitorAI, stores it encrypted, and never returns it', async () => {
    const token = jwt();
    const f = backend(url => url.endsWith('/hampter/profiles/mine') ? response({ name: 'Lunch', email: 'PRIVATE@example.com', id: 'PRIVATE_ID' }) : response({}, 404));
    f.send({ id: 's1', command: 'direct-save', token: `base64-${b64url(JSON.stringify({ access_token: token, refresh_token: 'PRIVATE_REFRESH' }))}` }); await flush();
    expect(f.calls.map(call => call.url)).toEqual(['https://janitorai.com/hampter/profiles/mine']);
    expect(f.calls[0].init.headers.Authorization).toBe(`Bearer ${token}`);
    expect(f.secrets.get('janitorai_access_token')).toBe(token);
    expect(f.replies[0].result).toMatchObject({ saved: true, account: 'Lunch' });
    expect(JSON.stringify(f.replies)).not.toContain(token.split('.')[1]);
    expect(JSON.stringify(f.replies)).not.toMatch(/PRIVATE/);
  });

  test('a login JanitorAI rejects is not stored, and blocked or expired logins say so', async () => {
    const rejected = backend(() => response({ error: 'unauthorized' }, 401));
    rejected.send({ id: 'r1', command: 'direct-save', token: jwt() }); await flush();
    expect(rejected.replies[0].error).toContain('did not accept this login'); expect(rejected.secrets.size).toBe(0);
    const blocked = backend(() => response('<html><script src="/cdn-cgi/challenge-platform/x"></script></html>', 403, 'text/html'));
    blocked.send({ id: 'b1', command: 'direct-save', token: jwt() }); await flush();
    expect(blocked.replies[0].error).toContain('did not accept');
    const cloudflare = backend(() => response('<html>Just a moment...<script src="/cdn-cgi/challenge-platform/x"></script></html>', 503, 'text/html'));
    cloudflare.send({ id: 'c1', command: 'direct-save', token: jwt() }); await flush();
    expect(cloudflare.replies[0].error).toContain('protection blocked');
    const expired = backend(() => response({ name: 'Lunch' }));
    expired.send({ id: 'e1', command: 'direct-save', token: jwt(1_000) }); await flush();
    expect(expired.calls).toHaveLength(0); expect(expired.replies[0].error).toContain('already expired');
  });

  test('preview reads only the linked character and its avatar, as a card', async () => {
    const token = jwt();
    const f = backend(url => url.endsWith('/hampter/profiles/mine') ? response({ username: 'Lunch' })
      : url.endsWith(`/hampter/characters/${id}`) ? response(meta())
        : url.startsWith('https://ella.janitorai.com/bot-avatars/abc_DEF-1.webp') ? { status: 200, headers: { 'content-type': 'image/webp' }, body: 'UklGRg==', encoding: 'base64' } : response({}, 404));
    f.send({ id: 's1', command: 'direct-save', token }); await flush();
    f.send({ id: 'p1', command: 'direct-preview', sourceUrl: `https://janitorai.com/characters/${id}` }); await flush();
    expect(f.calls.map(call => call.url)).toEqual(['https://janitorai.com/hampter/profiles/mine', `https://janitorai.com/hampter/characters/${id}`, 'https://ella.janitorai.com/bot-avatars/abc_DEF-1.webp?width=1200']);
    expect(f.calls[2].init.headers).toBeUndefined();
    const card = f.replies[1].result;
    expect(card.recordId).toBe(`jai-${id}`); expect(card.avatarDataUrl).toBe('data:image/webp;base64,UklGRg=='); expect(card.card.data.first_mes).toBe('Hey.');
  });

  test('preview needs a saved, unexpired login and the CORS permission', async () => {
    const none = backend(() => response({}));
    none.send({ id: 'p1', command: 'direct-preview', sourceUrl: `https://janitorai.com/characters/${id}` }); await flush();
    expect(none.calls).toHaveLength(0); expect(none.replies[0].error).toContain('Save your JanitorAI login first');
    const noPermission = backend(() => response({}), []);
    noPermission.send({ id: 'p2', command: 'direct-status' }); await flush();
    expect(noPermission.calls).toHaveLength(0); expect(noPermission.replies[0].error).toContain('CORS proxy');
    const stale = backend(() => response({ name: 'Lunch' }));
    stale.secrets.set('janitorai_access_token', jwt(1_000));
    stale.send({ id: 's1', command: 'direct-status' }); await flush();
    expect(stale.replies[0].result).toEqual({ saved: true, expired: true, expiresAt: 1_000_000 });
    stale.send({ id: 'p3', command: 'direct-preview', sourceUrl: `https://janitorai.com/characters/${id}` }); await flush();
    expect(stale.replies[1].error).toContain('expired'); expect(stale.calls).toHaveLength(0);
    stale.send({ id: 'c1', command: 'direct-clear' }); await flush();
    expect(stale.secrets.size).toBe(0); expect(stale.replies[2].result).toEqual({ saved: false });
  });
});

describe('JanitorAI login panel', () => {
  test('sends the pasted login once, clears the field, and hands a previewed card to the importer', async () => {
    const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
    const requests: any[] = []; let receive: (payload: unknown) => void = () => {};
    const card = toDirectCard(meta(), id, 'data:image/webp;base64,AAAA');
    const ctx: any = {
      onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
      sendToBackend: (request: any) => { requests.push(request); if (request.command === 'cancel') return;
        const result = request.command === 'direct-preview' ? card : request.command === 'direct-clear' ? { saved: false } : { saved: true, account: 'Lunch', expiresAt: Date.now() + 30 * 60_000 };
        setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result }), 0); },
    };
    const client = createJarClient(withHostUuid(ctx)); const cards: unknown[] = [];
    let link = '';
    const ui = createJanitorLogin({ client, getLink: () => link, onBusy() {}, onCard: value => cards.push(value) });
    document.body.append(ui.root); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
    const button = (text: string) => [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)!;
    ui.root.open = true; ui.root.dispatchEvent(new dom.window.Event('toggle')); await settle();
    expect(requests.map(r => r.command)).toEqual(['direct-status']);
    const input = ui.root.querySelector<HTMLInputElement>('input')!;
    expect(input.type).toBe('password');
    input.value = 'eyJsecret'; input.dispatchEvent(new dom.window.Event('input'));
    button('Save login').click(); expect(input.value).toBe(''); await settle();
    expect(requests[1]).toMatchObject({ command: 'direct-save', token: 'eyJsecret' });
    expect(ui.root.textContent).toContain('Signed in as Lunch');
    expect(button('Preview the link above with my JanitorAI login').disabled).toBe(true);
    link = `https://janitorai.com/characters/${id}_character-x`; ui.refresh();
    button('Preview the link above with my JanitorAI login').click(); await settle();
    expect(requests[2]).toMatchObject({ command: 'direct-preview', sourceUrl: `https://janitorai.com/characters/${id}` });
    expect(requests[2].token).toBeUndefined();
    expect(cards).toHaveLength(1);
  });
});
