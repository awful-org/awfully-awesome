import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteSound,
  listSounds,
  onLibraryChange,
  putSound,
  resetSoundboardStorageForTests,
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
    createdAt: 1,
    schemaVersion: 1,
  };
}

afterEach(() => resetSoundboardStorageForTests());

describe("soundboard storage", () => {
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
});
