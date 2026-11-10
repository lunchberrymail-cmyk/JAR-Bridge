/** Test host transport, not a UUID generator in shipped extension code. */
let next = 0;
export function withHostUuid<T extends object>(context: T): T {
  const listeners = new Set<(value: unknown) => void>();
  const original = context as any;
  return { ...context,
    onBackendMessage(handler: (value: unknown) => void) {
      listeners.add(handler);
      const off = original.onBackendMessage?.(handler);
      return () => { listeners.delete(handler); off?.(); };
    },
    sendToBackend(payload: any) {
      if (payload?.type === 'jar_bridge:uuid') {
        const uuid = `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
        for (const handler of [...listeners]) handler({ type: 'jar_bridge:uuid:result', requestId: payload.requestId, uuid });
      } else original.sendToBackend?.(payload);
    },
  };
}
