/**
 * Pure steam-roulette logic. Libraries arrive as CHUNKED updates (the update
 * payload cap is 4 KB and a Steam library is thousands of appids), keyed per
 * member; the roulette runs over the intersection of complete libraries.
 */
import type { UpdateCtx } from "$lib/plugins/api";

export interface MemberLibrary {
  name: string;
  steamId: string;
  /** Parts received so far, keyed by part index (1-based). */
  parts: Map<number, number[]>;
  totalParts: number;
}

export interface RouletteState {
  libraries: Map<string, MemberLibrary>; // senderDid -> library
  spun: boolean;
  winnerAppid: number | null;
  spinnerName: string;
  /** How many games were in the pool the winning spin drew from. */
  potSize: number;
}

export const initialState = (_cardData: unknown): RouletteState => ({
  libraries: new Map(),
  spun: false,
  winnerAppid: null,
  spinnerName: "",
  potSize: 0,
});

export function isComplete(lib: MemberLibrary): boolean {
  if (lib.totalParts < 1 || lib.parts.size < lib.totalParts) return false;
  for (let i = 1; i <= lib.totalParts; i++) if (!lib.parts.has(i)) return false;
  return true;
}

export function appidsOf(lib: MemberLibrary): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i <= lib.totalParts; i++) {
    for (const id of lib.parts.get(i) ?? []) out.add(id);
  }
  return out;
}

/** Appids owned by EVERY member with a complete library, sorted ascending -
 *  the sort is what makes the winner index deterministic on every client. */
export function commonGames(state: RouletteState): number[] {
  const complete = [...state.libraries.values()].filter(isComplete);
  if (complete.length < 2) return [];
  let common = appidsOf(complete[0]);
  for (const lib of complete.slice(1)) {
    const ids = appidsOf(lib);
    common = new Set([...common].filter((id) => ids.has(id)));
  }
  return [...common].sort((a, b) => a - b);
}

export function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash = hash & hash;
  }
  return hash >>> 0;
}

const MAX_PARTS = 40; // 40 * ~350 appids = 14k games, beyond any real library

export const reduce = function (
  state: unknown,
  update: { data: unknown },
  ctx: UpdateCtx
) {
  const s = state as RouletteState;
  const data = update.data as Record<string, unknown>;

  if (data.action === "library") {
    if (s.spun) return state; // the roulette is decided, late links change nothing
    const part = data.part;
    const of = data.of;
    const appids = data.appids;
    if (
      typeof part !== "number" || !Number.isInteger(part) || part < 1 ||
      typeof of !== "number" || !Number.isInteger(of) || of < 1 || of > MAX_PARTS ||
      part > of || !Array.isArray(appids) ||
      typeof data.steamId !== "string"
    ) {
      return state;
    }
    const clean = appids.filter(
      (id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0
    );
    const libraries = new Map(s.libraries);
    const prev = libraries.get(ctx.senderDid);
    // A re-link (new steamId or new part count) starts the library over.
    const lib: MemberLibrary =
      prev && prev.steamId === data.steamId && prev.totalParts === of
        ? { ...prev, parts: new Map(prev.parts) }
        : { name: ctx.senderName, steamId: data.steamId, parts: new Map(), totalParts: of };
    lib.parts.set(part, clean);
    libraries.set(ctx.senderDid, lib);
    return { ...s, libraries };
  }

  if (data.action === "unlink") {
    if (s.spun) return state;
    if (!s.libraries.has(ctx.senderDid)) return state;
    const libraries = new Map(s.libraries);
    libraries.delete(ctx.senderDid);
    return { ...s, libraries };
  }

  if (data.action === "spin") {
    if (s.spun) return state; // first spin wins
    const common = commonGames(s);
    if (common.length === 0) return state;
    // The spin CARRIES its pool (e.g. the multiplayer-only subset).
    // Multiplayer flags come from per-app fetches that finish at different
    // times on different clients, so the pool cannot be derived locally -
    // it must ride the signed update to stay deterministic. The reducer
    // only accepts a subset of the common games, so a pool cannot smuggle
    // in a game somebody does not own.
    let pool = common;
    if (Array.isArray(data.pool) && data.pool.length > 0) {
      const commonSet = new Set(common);
      const candidate = data.pool.filter(
        (id): id is number =>
          typeof id === "number" && Number.isInteger(id) && commonSet.has(id)
      );
      if (candidate.length !== data.pool.length) return state; // not a subset: reject
      pool = [...new Set(candidate)].sort((a, b) => a - b);
    }
    const winner = pool[hashSeed(ctx.updateId + ctx.senderDid) % pool.length];
    return {
      ...s,
      spun: true,
      winnerAppid: winner,
      spinnerName: ctx.senderName,
      potSize: pool.length,
    };
  }

  return state;
};
