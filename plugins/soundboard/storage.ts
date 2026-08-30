import { openDB, type IDBPDatabase } from "idb";

export const MAX_SOUNDS = 9;
const DB_NAME = "awful-plugin-soundboard";
const STORE = "sounds";

export interface SoundRecord {
  ownerDid: string;
  slot: number;
  id: string;
  name: string;
  blob: Blob;
  durationMs: number;
  volume: number;
  createdAt: number;
  schemaVersion: 1;
}

let dbPromise: Promise<IDBPDatabase> | null = null;
const listeners = new Set<() => void>();

function database(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: ["ownerDid", "slot"] });
    },
  });
  return dbPromise;
}

function valid(record: unknown): record is SoundRecord {
  const sound = record as Partial<SoundRecord> | null;
  return !!sound &&
    typeof sound.ownerDid === "string" &&
    Number.isInteger(sound.slot) && sound.slot! >= 1 && sound.slot! <= MAX_SOUNDS &&
    typeof sound.id === "string" &&
    typeof sound.name === "string" &&
    sound.blob instanceof Blob &&
    typeof sound.durationMs === "number" && sound.durationMs >= 250 && sound.durationMs <= 5000 &&
    (sound.volume === undefined ||
      (typeof sound.volume === "number" && Number.isFinite(sound.volume) && sound.volume >= 0 && sound.volume <= 1)) &&
    sound.schemaVersion === 1;
}

export async function listSounds(ownerDid: string): Promise<SoundRecord[]> {
  if (!ownerDid) return [];
  const records = await (await database()).getAll(STORE);
  return records
    .filter((record) => valid(record) && record.ownerDid === ownerDid)
    .map((record) => ({ ...record, volume: record.volume ?? 1 }))
    .sort((a, b) => a.slot - b.slot);
}

export async function putSound(record: SoundRecord): Promise<void> {
  if (!valid(record)) throw new Error("Invalid sound record");
  const db = await database();
  const existing = await db.get(STORE, [record.ownerDid, record.slot]);
  if (existing) throw new Error("That soundboard slot is already occupied");
  await db.put(STORE, record);
  for (const listener of listeners) listener();
}

export async function updateSound(
  ownerDid: string,
  slot: number,
  changes: { name: string; volume: number }
): Promise<void> {
  const db = await database();
  const existing = await db.get(STORE, [ownerDid, slot]);
  if (!valid(existing) || existing.ownerDid !== ownerDid) throw new Error("Sound not found");
  const updated = { ...existing, name: changes.name.trim(), volume: changes.volume };
  if ([...updated.name].length < 1 || [...updated.name].length > 32 || !valid(updated)) {
    throw new Error("Invalid sound changes");
  }
  await db.put(STORE, updated);
  for (const listener of listeners) listener();
}

export async function deleteSound(ownerDid: string, slot: number): Promise<void> {
  if (!ownerDid || !Number.isInteger(slot) || slot < 1 || slot > MAX_SOUNDS) {
    throw new Error("Invalid sound slot");
  }
  await (await database()).delete(STORE, [ownerDid, slot]);
  for (const listener of listeners) listener();
}

export function onLibraryChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tests only: closes the cached connection so each fake IndexedDB starts clean. */
export async function resetSoundboardStorageForTests(): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = null;
  listeners.clear();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
