import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { contentHash } from '../src/content-hash';
import { uuid } from '../src/uuid';
import { importNativeCard } from '../src/import-flow';
import { importNativeChat } from '../src/chat-import';
import { createJarTransport } from '../src/transport';
import { toCardV2 } from '../src/jar-adapter';

test('LAN HTTP produces the same content identities as native SHA-256', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto')!;
  const secure=crypto;
  Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:secure.getRandomValues.bind(secure)}});
  try {
    for(const text of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '世界 🌍'.repeat(1000), 'x'.repeat(1_000_000)]) {
      expect(await contentHash(text)).toBe(createHash('sha256').update(text).digest('hex'));
    }
    expect(await contentHash('same length A')).not.toBe(await contentHash('same length B'));
    expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {Object.defineProperty(globalThis,'crypto',descriptor);}
});

test('native content hashing preserves the established identity', async()=>{
  expect(await contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('rejected character permission gives actionable guidance before preparing or sending a file',async()=>{
  const ctx={permissions:{getGranted:async()=>[],request:async()=>{throw new Error('Permission request denied by user');}}};
  await expect(importNativeCard(ctx as any,async()=>{throw new Error('must not prepare file');},()=>true,new AbortController().signal)).rejects.toThrow('Allow Characters');
});

test('rejected chat permission gives actionable guidance without starting import',async()=>{
  const ctx={permissions:{getGranted:async()=>[],request:async()=>{throw new Error('Permission request denied by user');}}};
  await expect(importNativeChat(ctx as any,{name:'History',created_at:1700000000,messages:[{is_user:true,name:'You',content:'Hi',send_date:1700000000}]},'character',()=>true,new AbortController().signal)).rejects.toThrow('Allow Chats');
});

test('host response-size rejection recommends the file route without exposing host details',async()=>{
  const request=createJarTransport({permissions:{getGranted:async()=>['cors_proxy']},cors:async()=>{throw new Error('CORS proxy response too large (declared 30000000 bytes, max 26214400)');}} as any,'http://localhost:4577',{current:()=>true});
  await expect(request({kind:'history',chatId:'31415'})).rejects.toThrow('response is too large');
});

test('refused local connections explain how to start JAR and keep its server running', async () => {
  for (const detail of ['connect ECONNREFUSED PRIVATE', 'Unable to connect. PRIVATE', 'FailedToOpenSocket PRIVATE']) {
    const request = createJarTransport({ permissions: { getGranted: async () => ['cors_proxy'] }, cors: async () => { throw new Error(detail); } } as any, 'http://localhost:4577', { current: () => true });
    try { await request({ kind: 'version' }); throw new Error('Expected refusal'); }
    catch (error) {
      const message = String(error);
      expect(message).toContain('not accepting connections'); expect(message).toContain('start.bat');
      expect(message).toContain('keep its console open'); expect(message).not.toContain('PRIVATE');
    }
  }
});

test('fresh JAR browser setup failures are distinguished from an unreachable server', async () => {
  const request = createJarTransport({ permissions: { getGranted: async () => ['cors_proxy'] }, cors: async () => ({ status: 500, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: "browserType.launchPersistentContext: Executable doesn't exist at PRIVATE_PROFILE. Please run playwright install" }) }) } as any, 'http://localhost:4577', { current: () => true });
  try { await request({ kind: 'inspect', sourceUrl: 'https://janitorai.com/characters/11111111-2222-3333-4444-555555555555' }); throw new Error('Expected missing browser'); }
  catch (error) {
    const message = String(error);
    expect(message).toContain('JAR is running'); expect(message).toContain('npx.cmd playwright install chromium');
    expect(message).not.toContain('PRIVATE_PROFILE');
  }
});

test('unsupported avatar formats are omitted with a warning before preview and import', () => {
  for (const type of ['gif', 'svg+xml', 'avif']) {
    const card = toCardV2({ id: 'record-1', character: { name: 'Character', description: 'Definition', avatarBase64: `data:image/${type};base64,AAAA` } });
    expect(card.avatarDataUrl).toBeUndefined();
    expect(card.warnings?.join(' ')).toContain('avatar is unavailable');
  }
  for (const type of ['png', 'jpeg', 'webp']) {
    const avatar = `data:image/${type};base64,AAAA`;
    expect(toCardV2({ id: 'record-1', character: { name: 'Character', description: 'Definition', avatarBase64: avatar } }).avatarDataUrl).toBe(avatar);
  }
});

test('frontend UUID generation always goes through the LAN-compatible helper', async () => {
  for await (const path of new Bun.Glob('**/*.ts').scan(fileURLToPath(new URL('../src', import.meta.url)))) {
    const source = await Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
    expect(source).not.toMatch(/\brandomUUID\s*\(/);
  }
});
