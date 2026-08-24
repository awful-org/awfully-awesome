import { describe, expect, it } from "vitest";
import {
  initialState,
  reduce,
  commonGames,
  isComplete,
  type RouletteState,
} from "./logic";

const ctx = (did: string, name = "N", id = "u1", lamport = 1) => ({
  senderDid: did,
  senderName: name,
  updateId: id,
  lamport,
  ephemeral: false,
});

function link(state: RouletteState, did: string, appids: number[], parts = 1): RouletteState {
  const size = Math.ceil(appids.length / parts);
  let s = state;
  for (let i = 0; i < parts; i++) {
    s = reduce(
      s,
      {
        data: {
          action: "library",
          steamId: `7656119800000000${did.length}`,
          part: i + 1,
          of: parts,
          appids: appids.slice(i * size, (i + 1) * size),
        },
      },
      ctx(did, did, `lib-${did}-${i}`)
    ) as RouletteState;
  }
  return s;
}

describe("steam roulette logic", () => {
  it("assembles chunked libraries and intersects only complete ones", () => {
    let s = initialState({});
    s = link(s, "did:a", [10, 20, 30, 40], 2);
    // b's library arrives half-done: 2 parts declared, 1 sent
    s = reduce(
      s,
      { data: { action: "library", steamId: "76561198000000001", part: 1, of: 2, appids: [20, 30] } },
      ctx("did:b", "b", "half")
    ) as RouletteState;
    expect(isComplete(s.libraries.get("did:a")!)).toBe(true);
    expect(isComplete(s.libraries.get("did:b")!)).toBe(false);
    expect(commonGames(s)).toEqual([]); // only ONE complete library

    s = reduce(
      s,
      { data: { action: "library", steamId: "76561198000000001", part: 2, of: 2, appids: [40, 99] } },
      ctx("did:b", "b", "half2", 2)
    ) as RouletteState;
    expect(commonGames(s)).toEqual([20, 30, 40]);
  });

  it("three members: the intersection shrinks to what everyone owns", () => {
    let s = initialState({});
    s = link(s, "did:a", [1, 2, 3, 4]);
    s = link(s, "did:b", [2, 3, 4, 5]);
    s = link(s, "did:c", [3, 4, 6]);
    expect(commonGames(s)).toEqual([3, 4]);
  });

  it("first spin wins and picks a deterministic winner from the common set", () => {
    let s = initialState({});
    s = link(s, "did:a", [10, 20, 30]);
    s = link(s, "did:b", [20, 30, 40]);
    const spun1 = reduce(s, { data: { action: "spin" } }, ctx("did:a", "A", "spinX")) as RouletteState;
    const spun2 = reduce(s, { data: { action: "spin" } }, ctx("did:a", "A", "spinX")) as RouletteState;
    expect(spun1.spun).toBe(true);
    expect([20, 30]).toContain(spun1.winnerAppid);
    expect(spun2.winnerAppid).toBe(spun1.winnerAppid); // deterministic
    const after = reduce(spun1, { data: { action: "spin" } }, ctx("did:b", "B", "later", 9)) as RouletteState;
    expect(after.winnerAppid).toBe(spun1.winnerAppid); // first spin wins
  });

  it("cannot spin with fewer than two complete libraries", () => {
    let s = initialState({});
    s = link(s, "did:a", [10, 20]);
    const spun = reduce(s, { data: { action: "spin" } }, ctx("did:a")) as RouletteState;
    expect(spun.spun).toBe(false);
  });

  it("rejects malformed library updates and non-integer appids", () => {
    let s = initialState({});
    for (const bad of [
      { action: "library", steamId: "x", part: 0, of: 1, appids: [1] },
      { action: "library", steamId: "x", part: 2, of: 1, appids: [1] },
      { action: "library", steamId: "x", part: 1, of: 999, appids: [1] },
      { action: "library", part: 1, of: 1, appids: [1] },
    ]) {
      s = reduce(s, { data: bad }, ctx("did:a")) as RouletteState;
    }
    expect(s.libraries.size).toBe(0);
    s = reduce(
      s,
      { data: { action: "library", steamId: "x", part: 1, of: 1, appids: [1.5, "2", -3, 7] } },
      ctx("did:a")
    ) as RouletteState;
    expect([...s.libraries.get("did:a")!.parts.get(1)!]).toEqual([7]);
  });

  it("unlink removes a library, and nothing changes after the spin", () => {
    let s = initialState({});
    s = link(s, "did:a", [1, 2]);
    s = link(s, "did:b", [2, 3]);
    const unlinked = reduce(s, { data: { action: "unlink" } }, ctx("did:b")) as RouletteState;
    expect(unlinked.libraries.size).toBe(1);
    const spun = reduce(s, { data: { action: "spin" } }, ctx("did:a")) as RouletteState;
    const lateLink = link(spun, "did:c", [2]);
    const lateUnlink = reduce(spun, { data: { action: "unlink" } }, ctx("did:a")) as RouletteState;
    expect(lateLink.libraries.size).toBe(2);
    expect(lateUnlink.libraries.size).toBe(2);
  });
});
