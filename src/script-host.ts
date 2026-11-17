import type { SpindleAPI } from 'lumiverse-spindle-types';
import { object } from './jar-adapter';
import { runScripts, type ScriptRun, type ScriptTurn } from './script-runner';
import { MAX_SCRIPTS, SCRIPT_MACRO, withoutScriptMacros, type JanitorScript } from './script-source';

const FILE_PREFIX = 'scripts-';
const CACHE_MS = 15_000;
const MAX_CACHE = 50;
const entityId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface StoredScripts { schemaVersion: 1; name: string; scripts: JanitorScript[] }

/** JanitorAI's last_messages, from what Lumiverse hands a macro. */
function recent(chat: Record<string, unknown>, names: Record<string, unknown>, character: string): ScriptTurn['lastMessages'] {
  const bot = typeof chat.lastCharMessage === 'string' ? chat.lastCharMessage : '';
  const user = typeof chat.lastUserMessage === 'string' ? chat.lastUserMessage : '';
  const userName = typeof names.user === 'string' ? names.user : '';
  return [
    ...(bot ? [{ message: bot, is_bot: true, is_user: false, name: character, role: 'assistant' as const }] : []),
    ...(user ? [{ message: user, is_bot: false, is_user: true, name: userName, role: 'user' as const }] : []),
  ];
}

/** How many recent messages scripts get when the user allowed reading the chat. */
export const HISTORY_MESSAGES = 20;
/** Lumiverse's permission for reading chat messages. The bridge only reads with it. */
export const HISTORY_PERMISSION = 'chat_mutation';

type HistoryApi = Partial<Pick<SpindleAPI, 'chat' | 'permissions' | 'host'>>;

/**
 * The last messages of the chat, oldest first, as JanitorAI's last_messages.
 * Needs the chat permission; without it, or on any failure, returns undefined
 * and scripts get only the last two messages Lumiverse hands the macro.
 */
export async function chatHistory(api: HistoryApi, chatId: string, lastMessage: string): Promise<ScriptTurn['lastMessages'] | undefined> {
  if (!chatId || typeof api.chat?.getMessages !== 'function' || typeof api.permissions?.getGranted !== 'function') return undefined;
  try {
    if (!(await api.permissions.getGranted()).includes(HISTORY_PERMISSION)) return undefined;
    const lean = (api.host?.capabilities?.['chat-lean-messages-v1'] ?? 0) >= 1;
    const rows = lean
      ? await api.chat.getMessages(chatId, { tail: HISTORY_MESSAGES + 2, light: true, includeExtra: false })
      : (await api.chat.getMessages(chatId)).slice(-(HISTORY_MESSAGES + 2));
    const list = rows.filter(row => !row.hidden && row.role !== 'system' && typeof row.content === 'string');
    // The reply being written can already exist as an empty message, and a regenerated
    // reply is still stored: end the list where the prompt's last message is.
    while (list.length && list[list.length - 1].role !== 'user' && !list[list.length - 1].content.trim()) list.pop();
    if (lastMessage) {
      const at = list.map(row => row.content).lastIndexOf(lastMessage);
      if (at >= 0 && list.length - 1 - at <= 2) list.length = at + 1;
    }
    return list.slice(-HISTORY_MESSAGES).map(row => ({
      message: row.content, is_bot: row.role !== 'user', is_user: row.role === 'user', name: typeof row.name === 'string' ? row.name : '',
      role: row.role === 'user' ? 'user' as const : 'assistant' as const,
    }));
  } catch { return undefined; }
}

/** Resolve the usual names; any other macro a script wrote reaches the model as plain text. */
export function settle(text: string, names: Record<string, unknown>): string {
  const user = typeof names.user === 'string' ? names.user : '';
  const char = typeof names.char === 'string' ? names.char : '';
  return text.replace(/\{\{\s*user\s*\}\}/gi, () => user).replace(/\{\{\s*char\s*\}\}/gi, () => char).replaceAll('{{', '{​{');
}

/**
 * Stores each character's scripts and answers the macro. Each reply runs the
 * scripts once; the description and scenario macros share that run, so random
 * choices agree between them.
 */
export function createScriptHost(api: Pick<SpindleAPI, 'storage' | 'registerMacro' | 'unregisterMacro'> & HistoryApi, run: typeof runScripts = runScripts) {
  const cache = new Map<string, { at: number; result: Promise<ScriptRun> }>();
  const file = (characterId: string) => `${FILE_PREFIX}${characterId}.json`;
  const forget = (characterId: string) => { for (const key of cache.keys()) if (key.startsWith(`${characterId}\0`)) cache.delete(key); };

  async function load(characterId: string): Promise<StoredScripts | undefined> {
    if (!entityId.test(characterId)) return undefined;
    try {
      const stored = object(JSON.parse(await api.storage.read(file(characterId))));
      if (stored.schemaVersion !== 1 || typeof stored.name !== 'string' || !Array.isArray(stored.scripts)) return undefined;
      const scripts = stored.scripts.map(object).filter(item => typeof item.source === 'string' && typeof item.title === 'string')
        .map(item => ({ id: String(item.id ?? ''), title: item.title as string, source: item.source as string })).slice(0, MAX_SCRIPTS);
      return { schemaVersion: 1, name: stored.name, scripts };
    } catch { return undefined; }
  }

  async function resolve(context: unknown): Promise<string> {
    const ctx = object(context);
    const args = Array.isArray(ctx.args) ? ctx.args.map(value => String(value ?? '').trim()) : [];
    const [field, characterId] = args;
    if ((field !== 'personality' && field !== 'scenario') || !characterId || !entityId.test(characterId)) return '';
    const env = object(ctx.env), character = object(env.character), chat = object(env.chat), names = object(env.names);
    const stored = await load(characterId);
    const name = typeof character.name === 'string' ? character.name : '';
    // The macro only runs for the card it was added to.
    if (!stored?.scripts.length || stored.name.trim().toLowerCase() !== name.trim().toLowerCase()) return '';
    const personality = withoutScriptMacros(typeof character.description === 'string' && character.description.trim() ? character.description : typeof character.personality === 'string' ? character.personality : '');
    const scenario = withoutScriptMacros(typeof character.scenario === 'string' ? character.scenario : '');
    const lastMessage = typeof chat.lastUserMessage === 'string' ? chat.lastUserMessage : '';
    const messageCount = typeof chat.messageCount === 'number' && Number.isSafeInteger(chat.messageCount) ? chat.messageCount : 0;
    const chatId = typeof ctx.chatId === 'string' ? ctx.chatId : String(chat.id ?? '');
    const key = [characterId, chatId, messageCount, lastMessage, String(chat.lastCharMessage ?? ''), personality, scenario].join('\0');
    const now = Date.now();
    for (const [old, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(old);
    let entry = cache.get(key);
    if (!entry) {
      const promptLast = typeof chat.lastMessage === 'string' ? chat.lastMessage : lastMessage;
      entry = { at: now, result: chatHistory(api, chatId, promptLast).then(history => run(stored.scripts, {
        name, userName: typeof names.user === 'string' ? names.user : '', personality, scenario,
        exampleDialogs: typeof character.mesExamples === 'string' ? character.mesExamples : '',
        lastMessage, messageCount, lastMessages: history ?? recent(chat, names, name),
      })) };
      cache.set(key, entry);
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
    }
    let result: ScriptRun;
    try { result = await entry.result; } catch { cache.delete(key); return ''; }
    // Exactly what the scripts appended, as JanitorAI joins it to the field.
    return settle(field === 'personality' ? result.personality : result.scenario, names);
  }

  // Hosts without extension macros simply never run the scripts.
  const registered = typeof api.registerMacro === 'function';
  if (registered) api.registerMacro({
    name: SCRIPT_MACRO, category: 'extension:jar_bridge', returnType: 'string', volatile: true,
    description: 'Runs the JanitorAI scripts imported with this character and returns what they add.',
    args: [{ name: 'field', description: 'personality or scenario', required: true }, { name: 'character', description: 'Lumiverse character ID', required: true }],
    // The worker runs function handlers; the type still describes the old string form.
    handler: resolve as unknown as string,
  });

  return {
    resolve,
    load,
    async save(characterId: string, name: string, scripts: JanitorScript[]) {
      if (!entityId.test(characterId)) throw new Error('Choose the imported character again.');
      await api.storage.write(file(characterId), JSON.stringify({ schemaVersion: 1, name, scripts: scripts.slice(0, MAX_SCRIPTS) } satisfies StoredScripts));
      forget(characterId);
    },
    async remove(characterId: string) {
      if (!entityId.test(characterId)) return;
      try { await api.storage.delete(file(characterId)); } catch { /* already gone */ }
      forget(characterId);
    },
    dispose() { cache.clear(); if (registered) try { api.unregisterMacro(SCRIPT_MACRO); } catch { /* host gone */ } },
  };
}
