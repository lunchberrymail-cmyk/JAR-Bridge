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
    'On janitorai.com, signed in, press F12 to open developer tools, then click the Network tab.',
    'Reload the page. Click any request to janitorai.com in the list, then right-click it → Copy → Copy as cURL.',
    'Come back here, paste it in the box below, and choose Save login. The bridge reads only your login from it.',
  ]) steps.append(el('li', 'jar-help', step));
  const manual = el('details', 'jar-address-details');
  manual.append(el('summary', '', 'Prefer not to use the Network tab? Copy the cookie by hand'));
  const manualSteps = el('ol', 'jar-guide-tutorial');
  for (const step of [
    'On janitorai.com, signed in, press F12. Open Storage (Firefox: Stockage) or Application (Chrome, Edge), then Cookies → https://janitorai.com.',
    'Copy the value of sb-auth-auth-token.0 and paste it below, then copy the value of sb-auth-auth-token.1 and paste it right after, with nothing in between. Ignore the …-flow-… and …-code-verifier cookies.',
  ]) manualSteps.append(el('li', 'jar-help', step));
  manual.append(manualSteps);
  how.append(steps, manual, el('p', 'jar-help jar-guide-note', 'A cURL (or cookie) is a key to your JanitorAI account. Paste it only here and never share it. Lumiverse keeps only the login token, encrypted; it stops working after about an hour, and Forget removes it.'));
  const field = el('label', 'jar-field');
  const input = el('input', 'jar-input'); input.type = 'password'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'Paste the Copy as cURL (or your access token)';
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
