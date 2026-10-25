import { afterEach, describe, expect, test } from 'bun:test'
import { ChatImportError, importNativeChat, MAX_CHAT_REQUEST_BYTES, type PreparedChat } from '../src/chat-import'

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })
const signal = () => new AbortController().signal
function chat(): PreparedChat {
  return {
    name: 'An imported conversation', created_at: 1_700_000_000,
    metadata: { imported_from: 'janitorai' },
    messages: [
      { is_user: true, name: 'Alice', content: '  Hello, 世界.\n', send_date: 1_700_000_010 },
      { is_user: false, name: 'Character', content: 'Selected reply', send_date: 1_700_000_030,
        swipes: ['Original reply', 'Selected reply'], swipe_id: 1,
        swipe_dates: [1_700_000_020, 1_700_000_030], extra: { api: 'imported', model: 'janitorai-import' } },
    ],
  }
}
function context(get: () => Promise<string[]> = async () => ['chats'], request: () => Promise<string[]> = async () => ['chats']) {
  return { permissions: { getGranted: get, request } } as any
}
function success(count = 2) {
  return Response.json({ results: [{ chat_name: 'Imported name', success: true, chat_id: 'native-chat-id', message_count: count }], summary: { total: 1, imported: 1, failed: 0 } }, { status: 201 })
}

describe('explicit native JAR conversation import', () => {
  test('preserves message text, selected alternate, individual dates and creation time through one native request', async () => {
    const calls: { url: unknown; options: RequestInit }[] = []
    globalThis.fetch = (async (url, options) => { calls.push({ url, options: options! }); return success() }) as typeof fetch
    const prepared = chat()
    const result = await importNativeChat(context(), prepared, 'owned-character', () => true, signal())
    expect(result).toEqual({ id: 'native-chat-id', name: 'Imported name', messageCount: 2 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/v1/migrate/chats')
    expect(calls[0].options.method).toBe('POST')
    expect(calls[0].options.credentials).toBe('same-origin')
    expect(calls[0].options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(String(calls[0].options.body))).toEqual({ character_id: 'owned-character', chats: [prepared] })
  })

  test('permission denial makes no write and requests only Chats', async () => {
    let writes = 0, requested: unknown
    const ctx = context(async () => [], async (...args: unknown[]) => { requested = args[0]; return [] })
    globalThis.fetch = (async () => { writes++; return success() }) as typeof fetch
    await expect(importNativeChat(ctx, chat(), 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: false })
    expect(requested).toEqual(['chats'])
    expect(writes).toBe(0)
  })

  test('revocation immediately before dispatch prevents writing', async () => {
    let reads = 0, writes = 0
    globalThis.fetch = (async () => { writes++; return success() }) as typeof fetch
    await expect(importNativeChat(context(async () => ++reads === 1 ? ['chats'] : []), chat(), 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: false })
    expect(reads).toBe(2)
    expect(writes).toBe(0)
  })

  test('dismissal during the permission dialog prevents writing after approval', async () => {
    let current = true, writes = 0
    let approve!: (value: string[]) => void
    let opened!: () => void
    const dialog = new Promise<string[]>(resolve => { approve = resolve })
    const pendingDialog = new Promise<void>(resolve => { opened = resolve })
    const ctx = context(async () => [], () => { opened(); return dialog })
    globalThis.fetch = (async () => { writes++; return success() }) as typeof fetch
    const pending = importNativeChat(ctx, chat(), 'owned-character', () => current, signal())
    await pendingDialog
    current = false; approve(['chats'])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(writes).toBe(0)
  })

  test('the reviewed source is captured before async permission work', async () => {
    let release!: (value: string[]) => void, calls = 0, body: any
    const paused = new Promise<string[]>(resolve => { release = resolve })
    const ctx = context(async () => ++calls === 1 ? paused : ['chats'])
    globalThis.fetch = (async (_url, options) => { body = JSON.parse(String(options?.body)); return success() }) as typeof fetch
    const prepared = chat(), original = structuredClone(prepared)
    const pending = importNativeChat(ctx, prepared, 'original-character', () => true, signal())
    prepared.name = 'Changed name'; prepared.messages[0].content = 'Changed message'; prepared.messages[1].swipes![0] = 'Changed alternate'
    release(['chats'])
    await pending
    expect(body).toEqual({ character_id: 'original-character', chats: [original] })
  })

  test('native partial failure is uncertain and never retried', async () => {
    let writes = 0
    globalThis.fetch = (async () => {
      writes++
      return Response.json({ results: [{ success: false, error: 'private server content' }], summary: { total: 1, imported: 0, failed: 1 } }, { status: 201 })
    }) as typeof fetch
    try { await importNativeChat(context(), chat(), 'owned-character', () => true, signal()); throw new Error('Expected failure') }
    catch (error) { expect(error).toBeInstanceOf(ChatImportError); expect((error as ChatImportError).uncertain).toBe(true); expect((error as Error).message).not.toContain('private server content') }
    expect(writes).toBe(1)
  })

  test('a lost response is uncertain, while a missing owned character is rejected before creation', async () => {
    globalThis.fetch = (async () => { throw new Error('socket closed') }) as typeof fetch
    await expect(importNativeChat(context(), chat(), 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: true })
    globalThis.fetch = (async () => Response.json({ error: 'Not found' }, { status: 404 })) as typeof fetch
    await expect(importNativeChat(context(), chat(), 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: false })
    globalThis.fetch = (async () => Response.json({ error: 'server exception' }, { status: 500 })) as typeof fetch
    await expect(importNativeChat(context(), chat(), 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: true })
  })

  test('a misleading message count or malformed success result is uncertain', async () => {
    globalThis.fetch = (async () => success(1)) as typeof fetch
    await expect(importNativeChat(context(), chat(), 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: true })
    globalThis.fetch = (async () => new Response('not json', { status: 201 })) as typeof fetch
    await expect(importNativeChat(context(), chat(), 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: true })
  })

  test('invalid target, inconsistent swipes and oversized payloads never reach the server', async () => {
    let writes = 0
    globalThis.fetch = (async () => { writes++; return success() }) as typeof fetch
    await expect(importNativeChat(context(), chat(), '../another-character', () => true, signal())).rejects.toMatchObject({ uncertain: false })
    const invalid = chat(); invalid.messages[1].swipe_dates = [1_700_000_020]
    await expect(importNativeChat(context(), invalid, 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: false })
    const mismatch = chat(); mismatch.messages[1].content = 'Different selected content'
    await expect(importNativeChat(context(), mismatch, 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: false })
    const large = chat(); large.messages[0].content = 'x'.repeat(MAX_CHAT_REQUEST_BYTES)
    await expect(importNativeChat(context(), large, 'owned-character', () => true, signal())).rejects.toMatchObject({ uncertain: false })
    expect(writes).toBe(0)
  })
})
