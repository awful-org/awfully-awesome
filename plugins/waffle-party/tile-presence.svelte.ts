/**
 * One tab must never play the party twice. The call tile and the chat card
 * each mount a player; while a tile player exists, the card stands down
 * entirely (no player, no lifecycle side effects). Module-level state:
 * both components live in this plugin's graph.
 */
export const tilePresence = $state({ count: 0 });

/**
 * Whichever surface currently renders the player registers a live position
 * getter here, so surfaces WITHOUT a player (the sidebar widget) can pause
 * at the real position instead of the stale last-synced one - which yanked
 * the whole party backwards.
 */
let _positionSource: (() => number) | null = null;

export function registerPositionSource(fn: () => number): () => void {
  _positionSource = fn;
  return () => {
    if (_positionSource === fn) _positionSource = null;
  };
}

export function livePosition(fallback: number): number {
  try {
    const p = _positionSource?.();
    return typeof p === "number" && Number.isFinite(p) ? p : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Renderer handoff: when the tile unmounts (leaving the call) it parks the
 * live position here, and the card - whose player would otherwise start
 * from the STALE last-synced state.position - picks it up and re-syncs the
 * party. Consumed once, fresh only.
 */
let _handoff: { position: number; playing: boolean; at: number } | null = null;

export function parkHandoff(position: number, playing: boolean): void {
  if (Number.isFinite(position) && position > 0) {
    _handoff = { position, playing, at: Date.now() };
  }
}

export function takeHandoff(): { position: number; playing: boolean } | null {
  const h = _handoff;
  _handoff = null;
  if (!h || Date.now() - h.at > 15_000) return null;
  const elapsed = h.playing ? (Date.now() - h.at) / 1000 : 0;
  return { position: h.position + elapsed, playing: h.playing };
}
