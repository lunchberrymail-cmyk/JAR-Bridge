import type { createJarClient } from './client';
import type { DirectStatus, JarCardResult } from './jar-adapter';
import { parseJanitorLink } from './janitor-link';

type Client = ReturnType<typeof createJarClient>;
export interface JanitorLoginOptions {
  client: Client;
  /** The link currently in the importer's link field. */
  getLink: () => string;
  /** The direct requests share the importer's single request slot. */
  onBusy: (busy: boolean) => void;
  /** A character read with the user's login, ready for the normal preview. */
  onCard: (card: JarCardResult) => void;
}

/** Bookmark code: on janitorai.com, copy only the `sb-…-auth-token` cookie pieces. */
export const BOOKMARKLET = "javascript:(()=>{const p=document.cookie.split('; ').filter(c=>/^sb-[^=]*-auth-token(\\.\\d+)?=/.test(c));"
  + "if(!/(^|\\.)janitorai\\.com$/.test(location.hostname)||!p.length){alert('Open janitorai.com, sign in, then click this bookmark again.');return}"
  + "const t=p.join('; ');navigator.clipboard.writeText(t).then(()=>alert('Your JanitorAI login is copied. Paste it into JAR Bridge.'),"
  + "()=>prompt('Copy your JanitorAI login, then paste it into JAR Bridge:',t))})()";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') { const node = document.createElement(tag); node.className = cls; node.textContent = text; return node; }
function button(text: string, click: () => void, cls = 'jar-button') { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', click); return node; }
function isAbort(error: unknown) { return error instanceof Error && error.name === 'AbortError'; }

/**
 * Experimental JAR-free preview: the user pastes their own JanitorAI login, the
 * backend checks it and keeps only the access token, encrypted. The token never
 * comes back to the page; the field is cleared as soon as it is sent.
 */
export function createJanitorLogin(options: JanitorLoginOptions) {
  let busy = false, outerBusy = false, disposed = false, checked = false, state: DirectStatus | undefined;
  const root = el('details', 'jar-direct');
  root.append(el('summary', '', 'Experimental: use your JanitorAI login instead of JAR'));
  const intro = el('p', 'jar-help', 'Reads a character’s public definition straight from JanitorAI with your own login. It only reads: it never sends messages or changes your account. Hidden definitions and closed lorebooks still need JAR.');
  const how = el('details', 'jar-address-details');
  how.append(el('summary', '', 'How to get your login'));
  const steps = el('ol', 'jar-guide-tutorial');
  for (const step of [
    'Click “Copy bookmark code” below. (If your browser shows a bookmarks bar, you can drag the button onto it instead.)',
    'In Firefox, open the Bookmarks menu → Manage bookmarks (Ctrl+Shift+O). Right-click a folder → Add Bookmark. Paste the code into the URL field, name it “Copy JanitorAI login”, and Save.',
    'On janitorai.com, signed in, open your Bookmarks and click it. It copies your login.',
    'Come back here, paste it in the box below, then choose Save login.',
  ]) steps.append(el('li', 'jar-help', step));
  // On a browser with a bookmarks bar this drags there and, on janitorai.com, copies
  // only the session cookie's pieces. In the desktop app, clicking copies the same
  // code so it can be pasted into a new bookmark by hand.
  const bookmarklet = el('a', 'jar-button jar-bookmarklet', 'Copy bookmark code');
  bookmarklet.href = BOOKMARKLET; bookmarklet.draggable = true; bookmarklet.title = 'Drag me to a bookmarks bar, or click to copy the code';
  bookmarklet.addEventListener('click', event => { event.preventDefault(); void copyText(BOOKMARKLET, 'Bookmark code copied. In Firefox, make a new bookmark and paste it into the URL field, then click the bookmark on janitorai.com.'); });
  const manual = el('details', 'jar-address-details');
  manual.append(el('summary', '', 'Can’t use a bookmark? Copy it by hand'));
  const manualSteps = el('ol', 'jar-guide-tutorial');
  for (const step of [
    'On janitorai.com, signed in, press F12. Open Storage (Firefox: Stockage) or Application (Chrome, Edge), then Cookies → https://janitorai.com.',
    'Copy the value of sb-auth-auth-token.0 and paste it below, then copy the value of sb-auth-auth-token.1 and paste it right after, with nothing in between. Ignore the …-flow-… and …-code-verifier cookies.',
  ]) manualSteps.append(el('li', 'jar-help', step));
  manual.append(manualSteps);
  how.append(steps, bookmarklet, manual, el('p', 'jar-help jar-guide-note', 'This is a key to your JanitorAI account. Paste it only here and never share it. Lumiverse keeps it encrypted; it stops working after about an hour, and Forget removes it.'));
  const field = el('label', 'jar-field');
  const input = el('input', 'jar-input'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'Paste your JanitorAI login';
  field.append(el('span', 'jar-label', 'JanitorAI login'), input);
  const save = button('Save login', () => { void run('direct-save'); }, 'jar-button jar-primary');
  const forget = button('Forget', () => { void run('direct-clear'); }, 'jar-link');
  const row = el('div', 'jar-actions'); row.append(save, forget);
  const status = el('p', 'jar-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const preview = button('Preview the link above with my JanitorAI login', () => { void run('direct-preview'); });
  root.append(intro, how, field, row, status, preview);
  input.addEventListener('input', render);
  root.addEventListener('toggle', () => { if (root.open && !checked) void run('direct-status'); });

  function describe(value: DirectStatus): string {
    if (!value.saved) return 'No login saved.';
    if (value.expired) return 'Your saved login has expired. Paste a fresh one.';
    const minutes = value.expiresAt ? Math.round((value.expiresAt - Date.now()) / 60_000) : undefined;
    return `Signed in as ${value.account || 'your JanitorAI account'}${minutes !== undefined ? ` · expires in ${minutes < 1 ? 'under a minute' : `${minutes} min`}` : ''}.`;
  }
  function message(text: string, tone = '') { if (disposed) return; status.textContent = text; status.dataset.tone = tone; status.hidden = !text; }
  /** Copy to clipboard where allowed; otherwise show the text so it can be copied by hand. */
  async function copyText(text: string, done: string): Promise<void> {
    try { await navigator.clipboard?.writeText(text); message(done, 'success'); }
    catch { try { globalThis.prompt?.('Copy this, then paste it into a new Firefox bookmark’s URL field:', text); } catch { /* no prompt */ } message('Copy the code shown, then paste it into a new Firefox bookmark’s URL field.', 'warning'); }
  }
  function hasLink() { try { return parseJanitorLink(options.getLink()).kind === 'character'; } catch { return false; } }
  function render() {
    if (disposed) return;
    const locked = busy || outerBusy;
    input.disabled = locked; save.disabled = locked || !input.value.trim(); forget.disabled = locked || !state?.saved;
    preview.disabled = locked || !state?.saved || !!state.expired || !hasLink();
    root.setAttribute('aria-busy', String(busy));
  }

  async function run(command: 'direct-save' | 'direct-status' | 'direct-clear' | 'direct-preview') {
    if (disposed || busy || outerBusy) return;
    const token = command === 'direct-save' ? input.value.trim() : undefined;
    if (command === 'direct-save') { if (!token) return; input.value = ''; }
    busy = true; options.onBusy(true); render();
    message(command === 'direct-save' ? 'Checking this login with JanitorAI…' : command === 'direct-preview' ? 'Reading this character from JanitorAI…' : command === 'direct-clear' ? 'Forgetting your login…' : 'Checking your saved login…');
    try {
      if (command === 'direct-preview') {
        const link = parseJanitorLink(options.getLink());
        const card = await options.client.request('direct-preview', '', undefined, undefined, link) as JarCardResult;
        if (disposed) return;
        message('');
        options.onCard(card);
      } else {
        state = await options.client.request(command, '', undefined, undefined, undefined, token ? { token } : undefined) as DirectStatus;
        checked = true;
        if (!disposed) message(command === 'direct-clear' ? 'Login forgotten.' : describe(state), state.expired ? 'warning' : state.saved ? 'success' : '');
      }
    } catch (error) {
      if (!isAbort(error) && !disposed) message(error instanceof Error ? error.message : 'JanitorAI could not be reached.', 'error');
    } finally { if (!disposed) { busy = false; options.onBusy(false); render(); } }
  }

  render();
  return {
    root,
    /** The link field changed or the importer became busy elsewhere. */
    refresh() { render(); },
    setBusy(value: boolean) { outerBusy = value && !busy; render(); },
    destroy() { disposed = true; input.value = ''; root.remove(); },
  };
}
