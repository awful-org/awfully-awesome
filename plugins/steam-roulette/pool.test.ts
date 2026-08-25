import { describe, expect, it } from "vitest";
import { initialState, reduce, type RouletteState } from "./logic";

const ctx = (did: string, name = "N", id = "u1", lamport = 1) => ({
  senderDid: did, senderName: name, updateId: id, lamport, ephemeral: false,
});

function twoLibraries(): RouletteState {
  let s = initialState({});
  for (const [did, appids] of [["did:a", [10, 20, 30, 40]], ["did:b", [20, 30, 40, 50]]] as const) {
    s = reduce(
      s,
      { data: { action: "library", steamId: "76561198000000000", part: 1, of: 1, appids: [...appids] } },
      ctx(did, did, `lib-${did}`)
    ) as RouletteState;
  }
  return s; // common: 20, 30, 40
}

describe("spin pool (multiplayer filter)", () => {
  it("spins over the carried pool and records its size", () => {
    const s = twoLibraries();
    const spun = reduce(s, { data: { action: "spin", pool: [20, 40] } }, ctx("did:a", "A", "sp")) as RouletteState;
    expect(spun.spun).toBe(true);
    expect([20, 40]).toContain(spun.winnerAppid);
    expect(spun.potSize).toBe(2);
  });

  it("rejects a pool that is not a subset of the common games", () => {
    const s = twoLibraries();
    const spun = reduce(s, { data: { action: "spin", pool: [20, 99] } }, ctx("did:a", "A", "sp")) as RouletteState;
    expect(spun.spun).toBe(false);
  });

  it("no pool means the full common set, deterministic as before", () => {
    const s = twoLibraries();
    const a = reduce(s, { data: { action: "spin" } }, ctx("did:a", "A", "same")) as RouletteState;
    const b = reduce(s, { data: { action: "spin" } }, ctx("did:a", "A", "same")) as RouletteState;
    expect(a.winnerAppid).toBe(b.winnerAppid);
    expect(a.potSize).toBe(3);
  });
});
