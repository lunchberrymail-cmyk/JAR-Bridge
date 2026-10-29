import type { SpindleAPI } from 'lumiverse-spindle-types';
import { object } from './jar-adapter';

const PIN_FILE = 'installation.json';
const PROOF_TTL_MS = 10_000;
type Request = { userId: string; sessionId: string; id: string; command: string; current(): boolean };
type Proof = Request & { nonce: string; expires: number; timer: ReturnType<typeof setTimeout>; settle(value: boolean): void };
/** `stale`: the same owner's pin from an earlier installation of this extension. */
type PinState = 'missing' | 'valid' | 'stale' | 'invalid';

/**
 * A missing pin is different from an unreadable, malformed, or mismatched pin.
 * Lumiverse keeps a personal installation's storage when it is removed, and a
 * reinstall gets a new installation ID, so the owner's old pin becomes `stale`.
 */
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
    if (pin.schemaVersion !== 1 || pin.ownerUserId !== userId || typeof pin.installationId !== 'string' || !pin.installationId) return 'invalid';
    return pin.installationId === api.host.extensionInstallationId ? 'valid' : 'stale';
  } catch { return 'invalid'; }
}

const roles = new Set(['operator', 'admin', 'user']);

/** Determine scope through the native host, never through frontend payloads. */
async function nativeAccess(api: SpindleAPI, userId: string): Promise<'personal' | 'operator' | undefined> {
  if (!userId || typeof api.users?.getRole !== 'function') return;
  try {
    // Only personal installations have an implicit account. Other RPC failures
    // must not accidentally turn a personal installation into a shared bridge.
    return roles.has(await api.users.getRole()) ? 'personal' : undefined;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'userId is required for operator-scoped extensions') return;
  }
  try {
    // userId comes from onFrontendMessage's authenticated host context. All
    // signed-in roles can use an Operator installation's shared JAR session.
    return roles.has(await api.users.getRole(userId)) ? 'operator' : undefined;
  } catch { return; }
}

export async function hasJarAccess(api: SpindleAPI, userId: string): Promise<boolean> {
  const access = await nativeAccess(api, userId);
  return access === 'operator' || (access === 'personal' && await pinState(api, userId) === 'valid');
}

/**
 * Operator installations deliberately share the server's JAR session with
 * authenticated Lumiverse users. Personal installations retain their account
 * pin and exact-document challenge; native delivery is forced to their owner.
 * Neither mode trusts an account or installation ID from a frontend payload.
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
    const access = await nativeAccess(api, request.userId);
    if (!active() || !access) return false;
    // There is no first-user claim or global account pin in shared mode.
    if (access === 'operator') return true;
    const state = await pinState(api, request.userId);
    if (!active()) return false;
    if (state === 'valid') return true;
    // A stale pin is re-proved exactly like a missing one; another owner's pin never is.
    if ((state !== 'missing' && state !== 'stale') || typeof api.users?.getRole !== 'function' || typeof api.storage.write !== 'function'
      || typeof api.sendToFrontend !== 'function' || typeof globalThis.crypto?.getRandomValues !== 'function'
      || !(api.host.capabilities['frontend-session-routing-v1'] >= 1)
      || typeof api.host.extensionInstallationId !== 'string' || !api.host.extensionInstallationId) return false;
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
    if (!active() || latest === 'invalid' || (latest === 'stale' && state !== 'stale')) return false;
    if (latest === 'valid') return true;
    try {
      await api.storage.write(PIN_FILE, JSON.stringify({ schemaVersion: 1, ownerUserId: request.userId, installationId: api.host.extensionInstallationId }));
      return active() && await hasJarAccess(api, request.userId);
    } catch { return false; }
  }

  return { ensure, accept, cancel, dispose() { disposed = true; for (const proof of [...proofs.values()]) finish(proof, false); } };
}
