import type { SpindleAPI } from 'lumiverse-spindle-types';
import { isRecordId, object } from './jar-adapter';

const INDEX_FILE = 'jar-links.json';
const MAX_LINKS = 1000;

/**
 * Which JAR record the bridge uses for each JanitorAI character link. JAR saves a
 * new record on every link preview, so reusing the remembered one keeps JAR from
 * filling up with copies. Stored on disk so it survives restarts; a lost or
 * unreadable index only means JAR is asked to inspect the link again.
 */
export function createLinkIndex(api: Pick<SpindleAPI, 'storage'>) {
  let links: Map<string, string> | undefined;
  let saving: Promise<void> = Promise.resolve();

  async function load(): Promise<Map<string, string>> {
    if (links) return links;
    const loaded = new Map<string, string>();
    try {
      const stored = object(JSON.parse(await api.storage.read(INDEX_FILE)));
      if (stored.schemaVersion === 1) for (const [key, id] of Object.entries(object(stored.links))) if (typeof id === 'string' && isRecordId(id)) loaded.set(key, id);
    } catch { /* missing or unreadable: start empty */ }
    links ??= loaded;
    return links;
  }
  function save(map: Map<string, string>) {
    const body = JSON.stringify({ schemaVersion: 1, links: Object.fromEntries(map) });
    saving = saving.then(() => api.storage.write(INDEX_FILE, body)).catch(() => {});
    return saving;
  }

  return {
    async get(key: string) { return (await load()).get(key); },
    async set(key: string, recordId: string) {
      const map = await load();
      if (map.get(key) === recordId) return;
      map.delete(key); map.set(key, recordId);
      while (map.size > MAX_LINKS) map.delete(map.keys().next().value!);
      await save(map);
    },
    async delete(key: string) { const map = await load(); if (map.delete(key)) await save(map); },
  };
}
