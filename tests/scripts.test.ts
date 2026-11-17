import { withHostUuid } from './host-uuid-fixture';
import { afterEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { runScripts, type ScriptTurn } from '../src/script-runner';
import { createScriptHost, settle as settleText } from '../src/script-host';
import { hasScriptMacro, scriptMacro, toScripts, withoutScriptMacros, withScriptMacro } from '../src/script-source';
import { toLorebooks } from '../src/lorebook-adapter';
import { setupJarBackend } from '../src/backend';
import { createLorebooks } from '../src/lorebooks-ui';
import { createJarClient } from '../src/client';

const original = { document: globalThis.document, fetch: globalThis.fetch };
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); Object.assign(globalThis, original); });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 10)); };

// The shape of JanitorAI's lorebook-style advanced script template.
const LORE_SCRIPT = `
const loreEntries = [
  { keywords: ['titans'], priority: 5, minMessages: 0, personality: ' [Titans: the lacrosse team.]', scenario: ' [Merit Hall is near.]' },
  { keywords: ['party'], priority: 3, minMessages: 10, personality: ' [Late-game party lore.]', scenario: '' },
];
const lastMessage = context.chat.last_message.toLowerCase();
const count = context.chat.message_count;
loreEntries.filter(e => count >= e.minMessages && e.keywords.some(k => lastMessage.includes(k)))
  .sort((a, b) => b.priority - a.priority)
  .forEach(e => { context.character.personality += e.personality; context.character.scenario += e.scenario; });
`;
const turn = (over: Partial<ScriptTurn> = {}): ScriptTurn => ({
  name: 'Klaus', userName: 'Ana', personality: 'Klaus is cold.', scenario: 'Olympus campus.', exampleDialogs: '',
  lastMessage: '', messageCount: 0, lastMessages: [], ...over,
});
const script = (source: string, title = 'Lore') => ({ id: title, title, source });

describe('JanitorAI script runner', () => {
  test('returns only what a script adds, honoring keywords and message-count gates', async () => {
    const hit = await runScripts([script(LORE_SCRIPT)], turn({ lastMessage: 'The TITANS are at the party', messageCount: 12 }));
    expect(hit).toEqual({ personality: ' [Titans: the lacrosse team.] [Late-game party lore.]', scenario: ' [Merit Hall is near.]', errors: [] });
    const early = await runScripts([script(LORE_SCRIPT)], turn({ lastMessage: 'The titans are at the party', messageCount: 2 }));
    expect(early.personality).toBe(' [Titans: the lacrosse team.]');
    const miss = await runScripts([script(LORE_SCRIPT)], turn({ lastMessage: 'hello', messageCount: 50 }));
    expect(miss).toEqual({ personality: '', scenario: '', errors: [] });
  });

  test('later scripts see what earlier ones added, and a failing script is skipped', async () => {
    const result = await runScripts([
      script('context.character.personality += " A";', 'first'),
      script('throw new Error("broken on purpose")', 'broken'),
      script('if (context.character.personality.endsWith(" A")) context.character.scenario += " B";', 'third'),
    ], turn());
    expect(result.personality).toBe(' A');
    expect(result.scenario).toBe(' B');
    expect(result.errors).toEqual([{ title: 'broken', message: 'broken on purpose' }]);
  });

  test('contains loops, memory bombs and attempts to reach the host', async () => {
    const started = Date.now();
    const loop = await runScripts([script('while (true) {}', 'loop'), script('context.character.scenario += " still ran";', 'after')], turn());
    expect(Date.now() - started).toBeLessThan(1500);
    expect(loop.errors.map(e => e.title)).toEqual(['loop']);
    expect(loop.scenario).toBe(' still ran');
    const bomb = await runScripts([script('var x = [...new Array(4e9)];', 'bomb')], turn());
    expect(bomb.errors).toEqual([{ title: 'bomb', message: 'out of memory' }]);
    // Built-in calls on huge arrays would run past the time limit; they are refused up front.
    for (const source of ['new Array(4294967295).join("")', 'new Array(4294967295).forEach(function(){})', 'Array.prototype.indexOf.call({ length: 4e9 }, 1)', '"".repeat(4e9)', 'Array.from({ length: 4e9 })', 'new Uint8Array(1e7).join("")', 'var a = []; while (true) a.push(new Array(1e6).join("x"));']) {
      const began = Date.now();
      const refused = await runScripts([script(source, 'huge')], turn());
      expect(Date.now() - began).toBeLessThan(300);
      expect(refused.errors).toEqual([{ title: 'huge', message: 'This script uses an array or text that is too long.' }]);
    }
    const regex = await runScripts([script('/(a+)+$/.test("a".repeat(40) + "b")', 'regex')], turn());
    expect(regex.errors).toEqual([{ title: 'regex', message: 'interrupted' }]);
    const probe = await runScripts([script(`
      var seen = [typeof fetch, typeof Bun, typeof process, typeof require, typeof spindle, typeof setTimeout, typeof XMLHttpRequest, typeof WebAssembly];
      try { var g = [].constructor.constructor('return this')(); seen.push(typeof g.Bun, typeof g.process, typeof g.fetch); } catch (e) { seen.push('threw'); }
      context.character.scenario += seen.join(',');`, 'probe')], turn());
    expect(probe.scenario.split(',').every(type => type === 'undefined')).toBe(true);
  });

  test('keeps non-English text, symbols and emoji intact', async () => {
    const result = await runScripts([script('context.character.personality += " — ♡ café 東京 🎉 " + context.chat.last_message;')], turn({ lastMessage: 'ñandú ✩' }));
    expect(result.personality).toBe(' — ♡ café 東京 🎉 ñandú ✩');
  });

  test('a script cannot add unbounded text', async () => {
    const result = await runScripts([script('var s = "x".repeat(50000); for (var i = 0; i < 10; i++) context.character.personality += s;', 'big')], turn());
    expect(result.personality.length).toBe(60_000);
  });
});

describe('script sources and macros', () => {
  const record = {
    id: '123-abc', characterName: 'Klaus', meta: {},
    publicLorebooks: [
      { id: 'js-1', title: 'TITANS', isJs: true, scriptSource: LORE_SCRIPT, isCodePublic: true, accessible: false },
      { id: 'js-2', title: 'Private', isJs: true, scriptSource: 'x', isCodePublic: false, accessible: false },
      { id: 'lore-1', title: 'Closed lore', accessible: false },
    ],
  };
  test('only scripts with public code are taken; they are not listed as closed lorebooks', () => {
    expect(toScripts(record).map(s => s.title)).toEqual(['TITANS']);
    const books = toLorebooks(record);
    expect(books.scripts).toEqual([{ id: 'js-1', title: 'TITANS' }]);
    expect(books.closedTitles).toEqual(['Private', 'Closed lore']);
    expect(JSON.stringify(books)).not.toContain('loreEntries');
  });
  test('the macro is added once and removed cleanly', () => {
    const once = withScriptMacro('Klaus is cold.\n', 'personality', 'char-1');
    expect(once).toBe(`Klaus is cold.\n${scriptMacro('personality', 'char-1')}`);
    expect(withScriptMacro(once, 'personality', 'char-1')).toBe(once);
    expect(withScriptMacro('', 'scenario', 'char-1')).toBe(scriptMacro('scenario', 'char-1'));
    expect(hasScriptMacro(once)).toBe(true);
    expect(withoutScriptMacros(once)).toBe('Klaus is cold.\n');
  });
  test('script output resolves names and cannot smuggle other macros', () => {
    expect(settleText('{{char}} waves at {{ User }}. {{setvar::x::1}}', { user: 'Ana', char: 'Klaus' })).toBe('Klaus waves at Ana. {​{setvar::x::1}}');
  });
});

describe('script macro host', () => {
  function host(run?: Parameters<typeof createScriptHost>[1]) {
    const files = new Map<string, string>();
    let registered: any;
    const api: any = {
      storage: { read: async (path: string) => { if (!files.has(path)) throw new Error('missing'); return files.get(path)!; }, write: async (path: string, data: string) => { files.set(path, data); }, delete: async (path: string) => { files.delete(path); } },
      registerMacro: (def: unknown) => { registered = def; }, unregisterMacro: () => {},
    };
    const scripts = createScriptHost(api, run);
    return { scripts, files, get registered() { return registered; } };
  }
  const env = (over: Record<string, unknown> = {}) => ({
    names: { user: 'Ana', char: 'Klaus' },
    character: { name: 'Klaus', description: `Klaus is cold.${scriptMacro('personality', 'char-1')}`, scenario: `Olympus.${scriptMacro('scenario', 'char-1')}`, mesExamples: '' },
    chat: { id: 'chat-1', messageCount: 12, lastUserMessage: 'tell me about the titans', lastCharMessage: 'Hm.' }, ...over,
  });

  test('both fields share one run per reply, so random choices agree', async () => {
    let runs = 0;
    const h = host(async (list, input) => { runs++; expect(input.personality).toBe('Klaus is cold.'); expect(input.scenario).toBe('Olympus.'); return runScripts(list, input); });
    await h.scripts.save('char-1', 'Klaus', [script('var r = Math.random(); context.character.personality += " " + r; context.character.scenario += " " + r;')]);
    expect(h.registered).toMatchObject({ name: 'jarScripts', volatile: true });
    const p = await h.registered.handler({ args: ['personality', 'char-1'], chatId: 'chat-1', env: env() });
    const s = await h.registered.handler({ args: ['scenario', 'char-1'], chatId: 'chat-1', env: env() });
    expect(runs).toBe(1);
    expect(p.trim()).toBe(s.trim());
    expect(Number(p)).toBeGreaterThanOrEqual(0);
    // The next user message is a new reply and runs again.
    await h.registered.handler({ args: ['personality', 'char-1'], chatId: 'chat-1', env: env({ chat: { id: 'chat-1', messageCount: 14, lastUserMessage: 'again' } }) });
    expect(runs).toBe(2);
  });

  test('real lore script output reaches the field the script wrote to', async () => {
    const h = host();
    await h.scripts.save('char-1', 'Klaus', [script(LORE_SCRIPT, 'TITANS')]);
    expect(await h.registered.handler({ args: ['personality', 'char-1'], env: env() })).toBe(' [Titans: the lacrosse team.]');
    expect(await h.registered.handler({ args: ['scenario', 'char-1'], env: env() })).toBe(' [Merit Hall is near.]');
  });

  test('runs only for the card it was added to, and not after the scripts are removed', async () => {
    const h = host();
    await h.scripts.save('char-1', 'Klaus', [script('context.character.personality += " added";')]);
    expect(await h.registered.handler({ args: ['personality', 'char-1'], env: env({ character: { name: 'Someone else', description: '' } }) })).toBe('');
    expect(await h.registered.handler({ args: ['personality', '../char-1'], env: env() })).toBe('');
    expect(await h.registered.handler({ args: ['personality', 'char-1'], env: env() })).toBe(' added');
    await h.scripts.remove('char-1');
    expect(await h.registered.handler({ args: ['personality', 'char-1'], env: env() })).toBe('');
  });
});

describe('turning scripts on and off', () => {
  function backend() {
    const files = new Map<string, string>();
    let handler: (payload: unknown, userId: string, sessionId?: string) => void = () => {};
    const replies: any[] = [], updates: any[] = [];
    const character: any = { id: 'char-1', name: 'Klaus', description: 'Klaus is cold.', scenario: 'Olympus.' };
    const jarRecord = { id: '123-abc', characterName: 'Klaus', characterId: '7c637fb2-0f19-4ad2-9ac2-f66de203b47b', meta: {},
      character: { name: 'Klaus', description: 'Klaus is cold.' },
      publicLorebooks: [{ id: 'js-1', title: 'TITANS', isJs: true, scriptSource: LORE_SCRIPT, isCodePublic: true }] };
    const api: any = {
      host: { extensionInstallationId: 'installed-one', capabilities: { 'frontend-session-routing-v1': 1 } },
      storage: {
        read: async (path: string) => { if (path === 'installation.json') return JSON.stringify({ schemaVersion: 1, ownerUserId: 'owner', installationId: 'installed-one' }); if (!files.has(path)) throw new Error('missing'); return files.get(path)!; },
        write: async (path: string, data: string) => { files.set(path, data); }, delete: async (path: string) => { files.delete(path); },
      },
      users: { getRole: async () => 'user' },
      permissions: { getGranted: async () => ['cors_proxy', 'characters'] },
      cors: async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(jarRecord) }),
      characters: { get: async (id: string) => id === character.id ? { ...character } : null, update: async (_id: string, patch: any) => { updates.push(patch); Object.assign(character, patch); return { ...character }; } },
      registerMacro() {}, unregisterMacro() {},
      onFrontendMessage: (fn: typeof handler) => { handler = fn; return () => {}; },
      sendToFrontend: (payload: unknown) => { replies.push(payload); },
    };
    cleanups.push(setupJarBackend(api));
    return { files, replies, updates, character, send: (payload: any) => handler({ type: 'jar_bridge:request', ...payload }, 'owner', 'tab-one') };
  }
  const result = async (f: ReturnType<typeof backend>, id: string) => { for (let i = 0; i < 50 && !f.replies.some(r => r.id === id); i++) await settle(); return f.replies.find(r => r.id === id); };

  test('attach stores the scripts and adds the macros; detach removes only them', async () => {
    const f = backend();
    f.send({ id: 'a1', command: 'attach-scripts', recordId: '123-abc', characterId: 'char-1' });
    expect((await result(f, 'a1')).result).toEqual({ characterId: 'char-1', scripts: [{ id: 'js-1', title: 'TITANS' }] });
    expect(f.character.description).toBe(`Klaus is cold.${scriptMacro('personality', 'char-1')}`);
    expect(f.character.scenario).toBe(`Olympus.${scriptMacro('scenario', 'char-1')}`);
    expect(f.files.get('scripts-char-1.json')).toContain('loreEntries');
    f.send({ id: 'a2', command: 'detach-scripts', characterId: 'char-1' });
    expect((await result(f, 'a2')).result).toEqual({ characterId: 'char-1', scripts: [] });
    expect(f.character.description).toBe('Klaus is cold.');
    expect(f.character.scenario).toBe('Olympus.');
    expect(f.files.has('scripts-char-1.json')).toBe(false);
  });

  test('refuses unknown characters and forged IDs', async () => {
    const f = backend();
    f.send({ id: 'b1', command: 'attach-scripts', recordId: '123-abc', characterId: 'char-2' });
    expect((await result(f, 'b1')).error).toContain('no longer in your library');
    f.send({ id: 'b2', command: 'attach-scripts', recordId: '123-abc', characterId: '../x' });
    expect((await result(f, 'b2')).error).toContain('Choose the imported character');
    expect(f.updates).toEqual([]);
  });
});

test('importing a character with scripts turns them on, and the button turns them off', async () => {
  const dom = new JSDOM('<body></body>', { url: 'http://localhost:7860' }); globalThis.document = dom.window.document;
  const requests: any[] = [];
  let receive: (payload: unknown) => void = () => {};
  const books = { recordId: 'record-1', characterName: 'Klaus', allowProxy: true, captured: false, capturedAt: 0, rebuiltAt: 0, closedTitles: [], books: [], scripts: [{ id: 'js-1', title: 'TITANS' }] };
  const ctx: any = {
    permissions: { getGranted: async () => ['cors_proxy', 'characters', 'world_books'] },
    onBackendMessage: (fn: typeof receive) => { receive = fn; return () => {}; },
    sendToBackend: (request: any) => { requests.push(request); if (request.command === 'cancel') return;
      const result = request.command === 'lorebooks' ? books : { characterId: request.characterId, scripts: request.command === 'attach-scripts' ? books.scripts : [] };
      setTimeout(() => receive({ type: 'jar_bridge:response', id: request.id, command: request.command, result }), 0); },
  };
  globalThis.fetch = (async () => Response.json({ data: [] })) as any;
  const client = createJarClient(withHostUuid(ctx));
  const ui = createLorebooks(ctx, { client, getBaseUrl: () => 'http://localhost:4577', onBusy() {} });
  document.body.append(ui.root, ui.banner); cleanups.push(() => { ui.destroy(); client.dispose(); dom.window.close(); });
  ui.show('record-1'); await settle();
  expect(ui.banner.textContent).toContain('Script · runs with the card');
  expect(ui.root.textContent).toContain('sandbox');
  ui.setCharacter({ id: 'native-char-1', name: 'Klaus' }); for (let i = 0; i < 3; i++) await settle();
  expect(requests.filter(r => r.command === 'attach-scripts')).toEqual([expect.objectContaining({ recordId: 'record-1', characterId: 'native-char-1' })]);
  expect(ui.banner.textContent).toContain('Script · runs on Klaus');
  [...ui.root.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Stop running scripts on Klaus')!.click();
  for (let i = 0; i < 3; i++) await settle();
  expect(requests.filter(r => r.command === 'detach-scripts')).toEqual([expect.objectContaining({ characterId: 'native-char-1' })]);
  expect(ui.root.textContent).toContain('Run scripts on Klaus');
});
