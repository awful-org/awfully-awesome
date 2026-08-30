import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSound,
  DEFAULT_SOUND_VOLUME,
  listSounds,
  onLibraryChange,
  putSound,
  resetSoundboardStorageForTests,
  updateSound,
  type SoundRecord,
} from "./storage";

function sound(ownerDid: string, slot: number): SoundRecord {
  return {
    ownerDid,
    slot,
    id: `${ownerDid}-${slot}`,
    name: `Sound ${slot}`,
    blob: new Blob(["wav"], { type: "audio/wav" }),
    durationMs: 1000,
    volume: 1,
    createdAt: 1,
    schemaVersion: 1,
  };
}

afterEach(() => resetSoundboardStorageForTests());

describe("soundboard storage", () => {
  it("uses a quieter fifty-percent default for new sounds", () => {
    expect(DEFAULT_SOUND_VOLUME).toBe(0.5);
  });

  it("isolates records by DID and keeps stable slot order", async () => {
    await putSound(sound("did:a", 9));
    await putSound(sound("did:b", 1));
    await putSound(sound("did:a", 2));
    expect((await listSounds("did:a")).map((s) => s.slot)).toEqual([2, 9]);
    expect((await listSounds("did:b")).map((s) => s.slot)).toEqual([1]);
  });

  it("refuses implicit replacement of an occupied slot", async () => {
    await putSound(sound("did:a", 1));
    await expect(putSound({ ...sound("did:a", 1), name: "Replacement" }))
      .rejects.toThrow("occupied");
    expect((await listSounds("did:a"))[0].name).toBe("Sound 1");
  });

  it("deletes only the selected owner slot and notifies observers", async () => {
    const listener = vi.fn();
    const unsubscribe = onLibraryChange(listener);
    await putSound(sound("did:a", 1));
    await putSound(sound("did:a", 2));
    await deleteSound("did:a", 1);
    unsubscribe();
    expect((await listSounds("did:a")).map((s) => s.slot)).toEqual([2]);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("rejects records outside the nine slots or five-second bound", async () => {
    await expect(putSound({ ...sound("did:a", 9), durationMs: 5000 })).resolves.toBeUndefined();
    expect((await listSounds("did:a"))[0].durationMs).toBe(5000);
    await expect(putSound(sound("did:a", 10))).rejects.toThrow("Invalid");
    await expect(putSound({ ...sound("did:a", 1), durationMs: 5001 }))
      .rejects.toThrow("Invalid");
  });

  it("updates only the editable name and volume fields", async () => {
    const original = sound("did:a", 2);
    await putSound(original);
    await updateSound("did:a", 2, { name: "  Edited  ", volume: 0.4 });
    expect((await listSounds("did:a"))[0])
      .toEqual({ ...original, name: "Edited", volume: 0.4 });
  });

  it("rejects invalid edits without changing the sound", async () => {
    const original = sound("did:a", 2);
    await putSound(original);
    await expect(updateSound("did:a", 2, { name: "", volume: 1.1 }))
      .rejects.toThrow("Invalid");
    expect((await listSounds("did:a"))[0]).toEqual(original);
  });

  it("loads legacy records without a volume at full volume", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("awful-plugin-soundboard", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("sounds", { keyPath: ["ownerDid", "slot"] });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction("sounds", "readwrite");
        const { volume: _, ...legacy } = sound("did:a", 1);
        transaction.objectStore("sounds").put(legacy);
        transaction.onerror = () => reject(transaction.error);
        transaction.oncomplete = () => { db.close(); resolve(); };
      };
    });
    expect((await listSounds("did:a"))[0].volume).toBe(1);
  });
});
