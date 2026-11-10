import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

type Context = Pick<SpindleFrontendContext, 'sendToBackend' | 'onBackendMessage' | 'onTeardown'>;
let sequence = 0;
const channel = 'jar_bridge:uuid';
const noReply = 'JAR Bridge did not receive a host UUID reply. Retry; if it continues, restart JAR Bridge in Extensions and reload the page.';
const unsupported = 'This Lumiverse server does not provide Spindle UUIDs (uuid-v1). Update the Lumiverse server, then restart JAR Bridge.';
const failed = 'Lumiverse could not generate a host UUID. Check JAR Bridge in Extensions, then retry.';

/** Ask our backend to call spindle.uuid.v4(); this module never generates UUIDs. */
export function requestHostUuid(ctx: Context, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const requestId = String(++sequence); // Transport correlation only; not a UUID.
    let settled = false, off: (() => void) | undefined, offTeardown: (() => void) | undefined;
    const timer = setTimeout(() => finish(new Error(noReply)), 10_000);
    function finish(error?: Error, value?: string) {
      if (settled) return;
      settled = true; clearTimeout(timer); off?.(); offTeardown?.(); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    }
    function abort() { finish(new DOMException('Cancelled', 'AbortError')); }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      off = ctx.onBackendMessage(payload => {
        const value = payload as { type?: unknown; requestId?: unknown; uuid?: unknown; error?: unknown; code?: unknown } | null;
        if (!value || value.type !== `${channel}:result` || value.requestId !== requestId) return;
        if (typeof value.uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.uuid)) finish(undefined, value.uuid);
        else if (typeof value.error === 'string') finish(new Error(value.code === 'unsupported' ? unsupported : failed));
        else finish(new Error('JAR Bridge received an invalid host UUID reply. Restart JAR Bridge in Extensions, then retry.'));
      });
      offTeardown = ctx.onTeardown?.(abort);
      if (settled) { offTeardown?.(); return; }
      ctx.sendToBackend({ type: channel, requestId });
    } catch { finish(new Error('JAR Bridge could not contact its Lumiverse backend for a host UUID. Reload the page, then retry.')); }
  });
}
