// Encrypted storage on the phone (for an offline app; tested, not in the web UI). Everything the device keeps —
// queued photos, messages, the chat — is AES-GCM encrypted with a key derived
// from the midwife's PIN. Nothing is readable at rest without the PIN.

export interface Backend {
  put(id: string, value: { iv: Uint8Array; data: ArrayBuffer }): Promise<void>;
  get(id: string): Promise<{ iv: Uint8Array; data: ArrayBuffer } | undefined>;
  delete(id: string): Promise<void>;
  keys(): Promise<string[]>;
}

export async function deriveKey(pin: string, salt: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode(`maternily:${salt}`), iterations: 150_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export class Vault {
  constructor(private key: CryptoKey, private backend: Backend) {}

  async put(id: string, value: unknown) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, new TextEncoder().encode(JSON.stringify(value)));
    await this.backend.put(id, { iv, data });
  }

  async get<T>(id: string): Promise<T | undefined> {
    const rec = await this.backend.get(id);
    if (!rec) return undefined;
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv as Uint8Array<ArrayBuffer> }, this.key, rec.data);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  }

  delete(id: string) {
    return this.backend.delete(id);
  }

  async keys(prefix = "") {
    return (await this.backend.keys()).filter((k) => k.startsWith(prefix));
  }
}

/** IndexedDB backend: one database per midwife on this device. */
export function indexedDbBackend(name: string): Backend {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`maternily-${name}`, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("vault");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  const dbp = open();
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
    const db = await dbp;
    return new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction("vault", mode).objectStore("vault"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  };
  return {
    put: async (id, v) => void (await run("readwrite", (s) => s.put(v, id))),
    get: (id) => run("readonly", (s) => s.get(id)),
    delete: async (id) => void (await run("readwrite", (s) => s.delete(id))),
    keys: async () => (await run("readonly", (s) => s.getAllKeys())).map(String),
  };
}

export function memoryBackend(): Backend & { raw: Map<string, { iv: Uint8Array; data: ArrayBuffer }> } {
  const raw = new Map<string, { iv: Uint8Array; data: ArrayBuffer }>();
  return {
    raw,
    put: async (id, v) => void raw.set(id, v),
    get: async (id) => raw.get(id),
    delete: async (id) => void raw.delete(id),
    keys: async () => [...raw.keys()],
  };
}
