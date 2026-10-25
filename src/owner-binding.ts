import type { SpindleAPI } from 'lumiverse-spindle-types';
import { object } from './jar-adapter';

const PIN_FILE = 'installation.json';
const PROOF_TTL_MS = 10_000;
type Request = { userId: string; sessionId: string; id: string; command: string; current(): boolean };
type Proof = Request & { nonce: string; expires: number; timer: ReturnType<typeof setTimeout>; settle(value: boolean): void };
type PinState = 'missing' | 'valid' | 'invalid';

/** A missing pin is different from an unreadable, malformed, or mismatched pin. */
async function pinState(api: SpindleAPI, userId: string): Promise<PinState> {
  let raw: string;
  try { raw = await api.storage.read(PIN_FILE); }
  catch {
    try { return typeof api.storage.exists === 'function' && await api.storage.exists(PIN_FILE) === false ? 'missing' : 'invalid'; }
    catch { return 'invalid'; }
  }
  if (typeof raw !== 'string' || raw.length > 4096) return 'invalid';
  try {
    const pin = object(JSON.parse(raw));
    return pin.schemaVersion === 1 && pin.ownerUserId === userId && typeof pin.installationId === 'string'
      && !!pin.installationId && pin.installationId === api.host.extensionInstallationId ? 'valid' : 'invalid';
  } catch { return 'invalid'; }
}

export async function isPinnedOwner(api: SpindleAPI, userId: string): Promise<boolean> {
  return await pinState(api, userId) === 'valid';
}

/**
 * Bootstrap only a personal installation, using two independent host properties:
 * users.getRole() without an ID rejects on operator installs; session-targeted
 * sends on personal installs are forced to the real owner. A random challenge
 * can therefore be acknowledged only by that owner's requesting document.
 * The frontend supplies no owner ID or installation ID that we trust here.
 */
export function createOwnerBinding(api: SpindleAPI, options: { proofTtlMs?: number } = {}) {
  const proofs = new Map<string, Proof>();
  const key = (userId: string, sessionId: string) => `${userId}\0${sessionId}`;
  const ttl = Math.min(PROOF_TTL_MS, Math.max(1, options.proofTtlMs ?? PROOF_TTL_MS));
  let disposed = false;

  function finish(proof: Proof, value: boolean) {
    if (proofs.get(key(proof.userId, proof.sessionId)) !== proof) return;
    proofs.delete(key(proof.userId, proof.sessionId)); clearTimeout(proof.timer); proof.settle(value);
  }
  function cancel(userId: string, sessionId: string, id?: string) {
    const proof = proofs.get(key(userId, sessionId));
    if (proof && (id === undefined || proof.id === id)) finish(proof, false);
  }
  function accept(payload: unknown, userId: string, sessionId: string): boolean {
    const value = object(payload);
    if (value.type !== 'jar_bridge:owner-proof') return false;
    const proof = proofs.get(key(userId, sessionId));
    if (!disposed && proof && proof.current() && Date.now() < proof.expires && value.id === proof.id
      && value.command === proof.command && value.nonce === proof.nonce) finish(proof, true);
    return true;
  }

  async function ensure(request: Request): Promise<boolean> {
    const active = () => !disposed && request.current();
    const state = await pinState(api, request.userId);
    if (!active()) return false;
    if (state === 'valid') return true;
    if (state !== 'missing' || typeof api.users?.getRole !== 'function' || typeof api.storage.write !== 'function'
      || typeof api.sendToFrontend !== 'function' || typeof globalThis.crypto?.getRandomValues !== 'function'
      || !(api.host.capabilities['frontend-session-routing-v1'] >= 1)
      || typeof api.host.extensionInstallationId !== 'string' || !api.host.extensionInstallationId) return false;
    try {
      // Passing request.userId here would also work on operator installs and
      // would not prove that host delivery/storage are constrained to an owner.
      const role = await api.users.getRole();
      if (!active() || !['operator', 'admin', 'user'].includes(role)) return false;
    } catch { return false; }
    if (!active()) return false;
    cancel(request.userId, request.sessionId);
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    const nonce = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const proved = await new Promise<boolean>(settle => {
      const proof: Proof = { ...request, nonce, expires: Date.now() + ttl, settle,
        timer: setTimeout(() => finish(proof, false), ttl) };
      proofs.set(key(request.userId, request.sessionId), proof);
      try {
        api.sendToFrontend({ type: 'jar_bridge:owner-challenge', id: request.id, command: request.command, nonce }, request.userId, { frontendSessionId: request.sessionId });
      } catch { finish(proof, false); }
    });
    if (!proved || !active()) return false;
    // An established binding can never be replaced by an incoming document.
    const latest = await pinState(api, request.userId);
    if (!active() || latest === 'invalid') return false;
    if (latest === 'valid') return true;
    try {
      await api.storage.write(PIN_FILE, JSON.stringify({ schemaVersion: 1, ownerUserId: request.userId, installationId: api.host.extensionInstallationId }));
      return active() && await isPinnedOwner(api, request.userId);
    } catch { return false; }
  }

  return { ensure, accept, cancel, dispose() { disposed = true; for (const proof of [...proofs.values()]) finish(proof, false); } };
}
