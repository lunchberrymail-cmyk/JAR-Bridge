import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-sync';
import type { JanitorScript } from './script-source';

export type { JanitorScript };

/** What a script can read for one reply. JanitorAI's personality is Lumiverse's description. */
export interface ScriptTurn {
  name: string; userName: string; personality: string; scenario: string; exampleDialogs: string;
  lastMessage: string; messageCount: number;
  lastMessages: { message: string; is_bot: boolean; is_user: boolean; name: string }[];
}
export interface ScriptRun { personality: string; scenario: string; errors: { title: string; message: string }[] }

export const SCRIPT_BUDGET_MS = 200;
export const TOTAL_BUDGET_MS = 1500;
/** Most text all scripts together may add to one field. */
export const MAX_ADDED_CHARS = 60_000;
const MEMORY_BYTES = 16 * 1024 * 1024;
const STACK_BYTES = 512 * 1024;
/** Longest array or string a built-in function may walk in one call. */
export const MAX_NATIVE_LENGTH = 100_000;
/** A script slower than this is not run again until JAR Bridge restarts. */
const BLOCK_AFTER_MS = 1000;

/**
 * The time limit is only checked between script steps, so one built-in call on a
 * huge, mostly empty array could run for minutes. These wrappers refuse such
 * calls before they start; real scripts never come near the limit.
 */
const GUARD = `(function(){
  var MAX = ${MAX_NATIVE_LENGTH}, apply = Function.prototype.apply, define = Object.defineProperty;
  function guard(proto, names, size) {
    names.forEach(function(name){
      var original = proto[name];
      if (typeof original !== 'function') return;
      define(proto, name, { configurable: true, writable: true, value: function(){
        if (size(this, arguments) > MAX) throw new RangeError('This script uses an array or text that is too long.');
        return apply.call(original, this, arguments);
      } });
    });
  }
  var length = function(self){ return self == null ? 0 : +self.length || 0; };
  guard(Array.prototype, ['join','toString','toLocaleString','indexOf','lastIndexOf','includes','fill','copyWithin','reverse','concat','slice','splice','flat','flatMap','every','some','forEach','map','filter','reduce','reduceRight','find','findIndex','findLast','findLastIndex','sort','toReversed','toSorted','toSpliced','with','push','unshift','shift','pop','keys','values','entries'], length);
  guard(Array, ['from'], function(_, args){ return length(args[0]); });
  if (typeof Uint8Array === 'function') guard(Object.getPrototypeOf(Uint8Array.prototype), ['join','toString','toLocaleString','indexOf','lastIndexOf','includes','fill','copyWithin','reverse','slice','subarray','set','every','some','forEach','map','filter','reduce','reduceRight','find','findIndex','findLast','findLastIndex','sort','toReversed','toSorted','with'], length);
  guard(String.prototype, ['repeat'], function(self, args){ return (+args[0] || 0) * Math.max(1, String(self).length); });
  guard(String.prototype, ['padStart','padEnd'], function(_, args){ return +args[0] || 0; });
})();`;
const blocked = new Set<string>();
function sourceKey(source: string): string { let hash = 2166136261; for (let i = 0; i < source.length; i++) hash = Math.imul(hash ^ source.charCodeAt(i), 16777619); return `${source.length}:${hash >>> 0}`; }

let modulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | undefined;
function quickjs() {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  // A failed load is retried on the next reply instead of failing forever.
  modulePromise.catch(() => { modulePromise = undefined; });
  return modulePromise;
}

/** What the script added. Scripts append; one that rewrites a field has its whole text used. */
function added(after: string, before: string): string {
  if (after.startsWith(before)) return after.slice(before.length);
  const at = before ? after.indexOf(before) : -1;
  return at < 0 ? after : after.slice(0, at) + after.slice(at + before.length);
}

/**
 * Run scripts in order, each in its own QuickJS interpreter with no access to
 * the network, files, Lumiverse or this extension. A script that fails, loops
 * or runs out of memory is skipped; later scripts see what earlier ones added.
 * Returns only the added text.
 */
export async function runScripts(scripts: JanitorScript[], turn: ScriptTurn): Promise<ScriptRun> {
  const QuickJS = await quickjs();
  const started = Date.now();
  let personality = turn.personality, scenario = turn.scenario;
  const errors: ScriptRun['errors'] = [];
  for (const script of scripts) {
    if (Date.now() - started > TOTAL_BUDGET_MS) { errors.push({ title: script.title, message: 'skipped: the scripts took too long' }); continue; }
    const key = sourceKey(script.source);
    if (blocked.has(key)) { errors.push({ title: script.title, message: 'skipped: it ran too long on an earlier reply' }); continue; }
    const began = Date.now();
    let deadline = began + SCRIPT_BUDGET_MS;
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(MEMORY_BYTES);
    runtime.setMaxStackSize(STACK_BYTES);
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const vm = runtime.newContext();
    try {
      const seed = JSON.stringify({
        chat: { last_message: turn.lastMessage, lastMessage: turn.lastMessage, last_messages: turn.lastMessages, message_count: turn.messageCount, user_name: turn.userName },
        character: { name: turn.name, personality, scenario, example_dialogs: turn.exampleDialogs, example_dialogues: turn.exampleDialogs },
      });
      const boot = vm.evalCode(`globalThis.context = JSON.parse(${JSON.stringify(seed)}); globalThis.console = { log(){}, info(){}, warn(){}, error(){}, debug(){} };${GUARD}`);
      if (boot.error) { boot.error.dispose(); errors.push({ title: script.title, message: 'could not start' }); continue; }
      boot.value.dispose();
      const run = vm.evalCode(`(function(){\n${script.source}\n})();`);
      if (run.error) {
        const dumped = vm.dump(run.error) as unknown; run.error.dispose();
        const message = dumped && typeof dumped === 'object' ? String((dumped as { message?: unknown }).message ?? 'failed') : String(dumped);
        errors.push({ title: script.title, message: message.slice(0, 300) });
        continue;
      }
      run.value.dispose();
      deadline = Date.now() + SCRIPT_BUDGET_MS;
      const limit = Math.max(personality.length, scenario.length) + MAX_ADDED_CHARS;
      const out = vm.evalCode(`(function(){ var c = (globalThis.context || {}).character || {}; var t = function(v){ return typeof v === 'string' ? v.slice(0, ${limit}) : ''; }; return JSON.stringify({ p: t(c.personality), s: t(c.scenario) }); })()`);
      if (out.error) { out.error.dispose(); errors.push({ title: script.title, message: 'its result could not be read' }); continue; }
      const parsed = JSON.parse(vm.getString(out.value)) as { p: string; s: string }; out.value.dispose();
      personality = parsed.p; scenario = parsed.s;
    } catch (error) {
      errors.push({ title: script.title, message: error instanceof Error ? error.message.slice(0, 300) : 'failed' });
    } finally {
      try { vm.dispose(); runtime.dispose(); } catch { /* a broken interpreter is dropped */ }
      if (Date.now() - began > BLOCK_AFTER_MS) blocked.add(key);
    }
  }
  return { personality: added(personality, turn.personality).slice(0, MAX_ADDED_CHARS), scenario: added(scenario, turn.scenario).slice(0, MAX_ADDED_CHARS), errors };
}
