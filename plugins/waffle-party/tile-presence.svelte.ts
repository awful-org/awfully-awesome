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
