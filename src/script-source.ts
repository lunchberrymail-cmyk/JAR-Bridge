import { object } from './jar-adapter';

/** One JanitorAI "advanced" script: JavaScript that appends to the personality and scenario. */
export interface JanitorScript { id: string; title: string; source: string }
export type ScriptField = 'personality' | 'scenario';

/** The macro the bridge adds to a card's description and scenario. */
export const SCRIPT_MACRO = 'jarScripts';
export const MAX_SCRIPTS = 20;
export const MAX_SCRIPT_SOURCE = 200_000;

/** The macro text for one field of one character. */
export function scriptMacro(field: ScriptField, characterId: string): string { return `{{${SCRIPT_MACRO}::${field}::${characterId}}}`; }
const anyMacro = new RegExp(`\\{\\{\\s*${SCRIPT_MACRO}::[^}]*\\}\\}`, 'gi');
/** Card text without the bridge's macros, as JanitorAI would hand it to a script. */
export function withoutScriptMacros(text: string): string { return text.replace(anyMacro, ''); }
/**
 * Card text with the macro once, right after it. JanitorAI scripts append to the
 * field, often continuing its last sentence, so nothing is put in between.
 */
export function withScriptMacro(text: string, field: ScriptField, characterId: string): string {
  return `${withoutScriptMacros(text)}${scriptMacro(field, characterId)}`;
}
export function hasScriptMacro(text: unknown): boolean { return typeof text === 'string' && new RegExp(anyMacro.source, 'i').test(text); }

/**
 * Advanced (JavaScript) scripts JAR downloaded for a character. Only scripts
 * whose code the creator made public have a source; private ones are skipped.
 */
export function toScripts(recordValue: unknown): JanitorScript[] {
  const linked = object(recordValue).publicLorebooks;
  const scripts: JanitorScript[] = [];
  for (const item of Array.isArray(linked) ? linked : []) {
    const book = object(item);
    const source = typeof book.scriptSource === 'string' ? book.scriptSource.trim() : '';
    if (book.isJs !== true || !source || book.isCodePublic === false || source.length > MAX_SCRIPT_SOURCE) continue;
    scripts.push({ id: String(book.id ?? scripts.length).slice(0, 120), title: (typeof book.title === 'string' && book.title.trim() ? book.title.trim() : 'Untitled script').slice(0, 200), source });
    if (scripts.length >= MAX_SCRIPTS) break;
  }
  return scripts;
}

/** Script titles for the import panel; the code itself stays in the backend. */
export function scriptTitles(recordValue: unknown): { id: string; title: string }[] {
  return toScripts(recordValue).map(({ id, title }) => ({ id, title }));
}
