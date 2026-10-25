import type { SpindleFrontendContext } from 'lumiverse-spindle-types'

/** Native migration shape. Every timestamp is UNIX seconds. */
export interface NativeChatMessage {
  is_user: boolean
  name: string
  content: string
  send_date?: number
  swipes?: string[]
  swipe_dates?: number[]
  swipe_id?: number
  extra?: Record<string, unknown>
}

/** Accept only a parsed/sanitized chat, never a raw JAR archive or header. */
export interface NativeChatImport {
  name: string
  created_at?: number
  metadata?: Record<string, unknown>
  messages: NativeChatMessage[]
}

export type PreparedChat = NativeChatImport
export interface ImportedChat { id: string; name: string; messageCount: number }
export class ChatImportError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); this.name = 'ChatImportError' }
}

export const MAX_CHAT_REQUEST_BYTES = 10 * 1024 * 1024
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function timestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function invalid(): never {
  throw new ChatImportError('This conversation could not be read safely. Choose a JAR JSON or SillyTavern JSONL conversation export.')
}

/** Snapshot the reviewed payload so a later source/target change cannot alter it. */
function snapshotChat(prepared: PreparedChat): NativeChatImport {
  let value: Record<string, unknown>
  try { value = object(JSON.parse(JSON.stringify(prepared))) }
  catch { return invalid() }
  if (typeof value.name !== 'string' || !value.name.trim() || !Array.isArray(value.messages) || !value.messages.length) invalid()
  if (value.created_at !== undefined && !timestamp(value.created_at)) invalid()
  if (value.metadata !== undefined && (value.metadata === null || typeof value.metadata !== 'object' || Array.isArray(value.metadata))) invalid()
  let hasText = false
  const messages = value.messages.map(item => {
    const row = object(item)
    if (typeof row.is_user !== 'boolean' || typeof row.name !== 'string' || typeof row.content !== 'string') invalid()
    if (row.content.length) hasText = true
    if (row.send_date !== undefined && !timestamp(row.send_date)) invalid()
    const swipes = row.swipes
    if (swipes !== undefined && (!Array.isArray(swipes) || !swipes.length || !swipes.every(swipe => typeof swipe === 'string'))) invalid()
    const swipeId = row.swipe_id
    if (swipeId !== undefined && (typeof swipeId !== 'number' || !Number.isSafeInteger(swipeId) || swipeId < 0 || swipeId >= (Array.isArray(swipes) ? swipes.length : 1))) invalid()
    if (Array.isArray(swipes) && swipes[typeof swipeId === 'number' ? swipeId : 0] !== row.content) invalid()
    const dates = row.swipe_dates
    if (dates !== undefined && (!Array.isArray(swipes) || !Array.isArray(dates) || dates.length !== swipes.length || !dates.every(timestamp))) invalid()
    if (row.extra !== undefined && (row.extra === null || typeof row.extra !== 'object' || Array.isArray(row.extra))) invalid()
    // Ignore unknown top-level fields from exports. Sanitized message extras are
    // the parser's explicit allowlist; they do not become native chat settings.
    return {
      is_user: row.is_user, name: row.name, content: row.content,
      ...(row.send_date !== undefined ? { send_date: row.send_date } : {}),
      ...(swipes !== undefined ? { swipes } : {}),
      ...(dates !== undefined ? { swipe_dates: dates } : {}),
      ...(swipeId !== undefined ? { swipe_id: swipeId } : {}),
      ...(row.extra !== undefined ? { extra: row.extra } : {}),
    } as NativeChatMessage
  })
  if (!hasText) invalid()
  return {
    name: value.name,
    ...(value.created_at !== undefined ? { created_at: value.created_at as number } : {}),
    ...(value.metadata !== undefined ? { metadata: value.metadata as Record<string, unknown> } : {}),
    messages,
  }
}

/**
 * One explicit import using Lumiverse's normal migration storage. No automatic
 * retries or cleanup: a transport/server failure may leave a created chat.
 */
export async function importNativeChat(
  ctx: Pick<SpindleFrontendContext, 'permissions'>,
  prepared: PreparedChat,
  characterId: string,
  current: () => boolean,
  signal: AbortSignal,
): Promise<ImportedChat> {
  const active = () => current() && !signal.aborted
  const cancelled = () => { throw new DOMException('Import cancelled.', 'AbortError') }
  if (!active()) cancelled()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(characterId)) throw new ChatImportError('Choose the Lumiverse character that this conversation belongs to.')
  const chat = snapshotChat(prepared)
  let granted = await ctx.permissions.getGranted()
  if (!active()) cancelled()
  if (!granted.includes('chats')) {
    granted = await ctx.permissions.request(['chats'], { reason: 'Import the conversation you reviewed as a normal Lumiverse chat for the character you selected.' })
    if (!active()) cancelled()
    if (!granted.includes('chats')) throw new ChatImportError('Allow Chats to import this conversation.')
  }
  const body = JSON.stringify({ character_id: characterId, chats: [chat] })
  if (new TextEncoder().encode(body).byteLength > MAX_CHAT_REQUEST_BYTES) {
    throw new ChatImportError('This conversation is larger than Lumiverse’s 10 MiB import limit. Choose a smaller conversation export.')
  }
  // Permission prompts and serialization can take time. Recheck immediately
  // before the one durable write, using the captured source and character.
  granted = await ctx.permissions.getGranted()
  if (!active()) cancelled()
  if (!granted.includes('chats')) throw new ChatImportError('Chats permission was removed. The conversation has not been imported.')
  let response: Response
  try {
    response = await fetch('/api/v1/migrate/chats', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body, signal,
    })
  } catch {
    throw new ChatImportError('The import response was interrupted. Check this character’s chats before trying again.', true)
  }
  let data: Record<string, unknown>
  try { data = object(await response.json()) }
  catch { throw new ChatImportError('Lumiverse returned an unreadable result. Check this character’s chats before trying again.', true) }
  if (!response.ok) {
    // These statuses reject before createChatRaw in the native route/middleware.
    // Other failures can occur after a raw chat has already been created.
    if ([400, 401, 403, 404, 413, 429].includes(response.status)) {
      const message = response.status === 404 ? 'The selected character is no longer available in your own library. Choose an owned character.'
        : response.status === 401 ? 'Your Lumiverse session expired. Sign in again before importing.'
        : response.status === 413 ? 'This conversation is larger than Lumiverse’s import limit.'
        : response.status === 429 ? 'Lumiverse is busy. Wait before trying this import again.'
        : 'Lumiverse rejected the conversation before importing. Check the file and selected character.'
      throw new ChatImportError(message)
    }
    throw new ChatImportError('Lumiverse could not confirm the import. Check this character’s chats before trying again.', true)
  }
  const rows = data.results
  const summary = object(data.summary)
  const result = Array.isArray(rows) && rows.length === 1 ? object(rows[0]) : {}
  if (result.success !== true || typeof result.chat_id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(result.chat_id)
      || result.message_count !== chat.messages.length || summary.total !== 1 || summary.imported !== 1 || summary.failed !== 0) {
    throw new ChatImportError('Lumiverse could not confirm every message was imported. Check this character’s chats before trying again.', true)
  }
  return { id: result.chat_id, name: typeof result.chat_name === 'string' ? result.chat_name : chat.name, messageCount: result.message_count }
}
