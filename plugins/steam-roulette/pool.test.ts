import { describe, expect, it } from "vitest";
import {
  initialState,
  reduce,
  ROLL_ROWS,
  rollWindow,
  sampleSpinPool,
  SPIN_POOL_CAP,
  type RouletteState,
} from "./logic";

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

  it("intersects a pool with the common games - unowned ids drop, spin lands", () => {
    // A concurrent library link can change `common` between the spinner's
    // snapshot and the fold; rejecting used to strand every client unspun.
    const s = twoLibraries();
    const spun = reduce(s, { data: { action: "spin", pool: [20, 99] } }, ctx("did:a", "A", "sp")) as RouletteState;
    expect(spun.spun).toBe(true);
    expect(spun.winnerAppid).toBe(20);
    expect(spun.potSize).toBe(1);
  });

  it("a pool with nothing in common falls back to the full common set", () => {
    const s = twoLibraries();
    const spun = reduce(s, { data: { action: "spin", pool: [98, 99] } }, ctx("did:a", "A", "sp")) as RouletteState;
    expect(spun.spun).toBe(true);
    expect([20, 30, 40]).toContain(spun.winnerAppid);
    expect(spun.potSize).toBe(3);
  });

  it("records the drawn pool for the roll animation", () => {
    const s = twoLibraries();
    const spun = reduce(s, { data: { action: "spin", pool: [20, 40] } }, ctx("did:a", "A", "sp")) as RouletteState;
    expect(spun.pool).toEqual([20, 40]);
  });

  it("respin resets the round but keeps the libraries", () => {
    const s = twoLibraries();
    const spun = reduce(s, { data: { action: "spin" } }, ctx("did:a", "A", "sp")) as RouletteState;
    const reset = reduce(spun, { data: { action: "respin" } }, ctx("did:b", "B", "rs", 2)) as RouletteState;
    expect(reset.spun).toBe(false);
    expect(reset.winnerAppid).toBeNull();
    expect(reset.pool).toEqual([]);
    expect(reset.libraries.size).toBe(2);
    // respin on an unspun card is a no-op
    expect(reduce(reset, { data: { action: "respin" } }, ctx("did:a", "A", "rs2", 3))).toBe(reset);
    // and the next spin lands again
    const again = reduce(reset, { data: { action: "spin" } }, ctx("did:a", "A", "sp2", 4)) as RouletteState;
    expect(again.spun).toBe(true);
  });

  it("no pool means the full common set, deterministic as before", () => {
    const s = twoLibraries();
    const a = reduce(s, { data: { action: "spin" } }, ctx("did:a", "A", "same")) as RouletteState;
    const b = reduce(s, { data: { action: "spin" } }, ctx("did:a", "A", "same")) as RouletteState;
    expect(a.winnerAppid).toBe(b.winnerAppid);
    expect(a.potSize).toBe(3);
  });
});

describe("sampleSpinPool", () => {
  it("passes small pools through untouched", () => {
    const small = [1, 2, 3];
    expect(sampleSpinPool(small)).toBe(small);
  });

  it("caps a big pool under the 4KB update budget, deterministically", () => {
    // ~590 shared appids already blew the cap in the wild; make it 3000.
    const big = Array.from({ length: 3000 }, (_, i) => (i + 1) * 137);
    const a = sampleSpinPool(big);
    expect(a).toEqual(sampleSpinPool(big));
    expect(a).toHaveLength(SPIN_POOL_CAP);
    expect(
      JSON.stringify({ action: "spin", pool: a }).length
    ).toBeLessThan(4096);
    // Every sampled id is a real pool member and order is preserved.
    const bigSet = new Set(big);
    expect(a.every((id) => bigSet.has(id))).toBe(true);
    expect([...a].sort((x, y) => x - y)).toEqual(a);
  });
});

describe("the spinning window", () => {
  const pool = [10, 20, 30, 40, 50, 60, 70];

  it("is the same size wherever the index is", () => {
    // The bug it replaces: a slice gave three rows near the start and five in
    // the middle, so the card changed height on almost every frame and shoved
    // the chat below it around.
    for (let i = 0; i < pool.length; i++) {
      expect(rollWindow(pool, i)).toHaveLength(ROLL_ROWS);
    }
  });

  it("centres the index, so the middle row is the one that won", () => {
    expect(rollWindow(pool, 3)).toEqual([20, 30, 40, 50, 60]);
    expect(rollWindow(pool, 3)[Math.floor(ROLL_ROWS / 2)]).toBe(pool[3]);
  });

  it("wraps at both ends rather than running short", () => {
    expect(rollWindow(pool, 0)).toEqual([60, 70, 10, 20, 30]);
    expect(rollWindow(pool, 6)).toEqual([50, 60, 70, 10, 20]);
  });

  it("fills the window from a pool smaller than it", () => {
    // Two entries repeat to fill five rows, which is why the card keys those
    // rows by position: keying by appid would be a duplicate-key error.
    expect(rollWindow([1, 2], 0)).toHaveLength(ROLL_ROWS);
    expect(new Set(rollWindow([1, 2], 0))).toEqual(new Set([1, 2]));
  });

  it("has nothing to show for an empty pool", () => {
    expect(rollWindow([], 0)).toEqual([]);
  });
});
