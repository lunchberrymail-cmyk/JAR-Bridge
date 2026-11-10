import type { SpindleAPI } from 'lumiverse-spindle-types';

/** Document-targeted bridge to the documented backend-only UUID API. */
export function registerUuidHost(api: SpindleAPI): () => void {
  let disposed = false;
  const off = api.onFrontendMessage((payload, userId, frontendSessionId) => {
    const value = payload as { type?: unknown; requestId?: unknown } | null;
    if (disposed || !value || value.type !== 'jar_bridge:uuid'
      || typeof value.requestId !== 'string' || !/^\d{1,16}$/.test(value.requestId)
      || !userId || !frontendSessionId || !(api.host.capabilities['frontend-session-routing-v1'] >= 1)) return;
    const reply = (result: { uuid: string } | { error: string; code: 'unsupported' | 'failed' }) => {
      if (disposed) return;
      try { api.sendToFrontend({ type: 'jar_bridge:uuid:result', requestId: value.requestId, ...result }, userId, { frontendSessionId }); }
      catch { /* The originating frontend may have unloaded while UUID RPC was pending. */ }
    };
    void (async () => {
      try {
        if (!(api.host.capabilities['uuid-v1'] >= 1) || typeof api.uuid?.v4 !== 'function') {
          reply({ error: 'Host UUID generation is unavailable.', code: 'unsupported' }); return;
        }
        reply({ uuid: await api.uuid.v4() });
      } catch { reply({ error: 'Host UUID generation failed.', code: 'failed' }); }
    })();
  });
  return () => { disposed = true; off(); };
}
