import type { SpindleFrontendContext } from 'lumiverse-spindle-types';

type Context = Pick<SpindleFrontendContext, 'sendToBackend' | 'onBackendMessage' | 'onTeardown'>;
let sequence = 0;
const channel = 'jar_bridge:uuid';
const unavailable = 'Host UUID generation is unavailable. Use Lumiverse staging with the uuid-v1 capability.';

/** Ask our backend to call spindle.uuid.v4(); this module never generates UUIDs. */
export function requestHostUuid(ctx: Context, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const requestId = String(++sequence); // Transport correlation only; not a UUID.
    let settled = false, off: (() => void) | undefined, offTeardown: (() => void) | undefined;
    const timer = setTimeout(() => finish(new Error(unavailable)), 10_000);
    function finish(error?: Error, value?: string) {
      if (settled) return;
      settled = true; clearTimeout(timer); off?.(); offTeardown?.(); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value!);
    }
    function abort() { finish(new DOMException('Cancelled', 'AbortError')); }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      off = ctx.onBackendMessage(payload => {
        const value = payload as { type?: unknown; requestId?: unknown; uuid?: unknown; error?: unknown } | null;
        if (!value || value.type !== `${channel}:result` || value.requestId !== requestId) return;
        if (typeof value.uuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.uuid)) finish(undefined, value.uuid);
        else finish(new Error(unavailable));
      });
      offTeardown = ctx.onTeardown?.(abort);
      if (settled) { offTeardown?.(); return; }
      ctx.sendToBackend({ type: channel, requestId });
    } catch { finish(new Error(unavailable)); }
  });
}
