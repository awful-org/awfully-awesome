/**
 * One tab must never play the party twice. The call tile and the chat card
 * each mount a player; while a tile player exists, the card stands down
 * entirely (no player, no lifecycle side effects). Module-level state:
 * both components live in this plugin's graph.
 */
export const tilePresence = $state({ count: 0 });
export const livePositionState = $state({
  position: 0,
  playing: false,
  published: false,
});
export const liveDurationState = $state({ duration: 0 });

export function publishLivePosition(position: number, playing: boolean): void {
  if (Number.isFinite(position) && position >= 0) {
    livePositionState.position = position;
    livePositionState.playing = playing;
    livePositionState.published = true;
  }
}

export function publishLiveDuration(duration: number): void {
  if (Number.isFinite(duration) && duration >= 0)
    liveDurationState.duration = duration;
}

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
  // Keep consumers reactive while the renderer publishes once per second.
  livePositionState.position;
  try {
    const p = _positionSource?.();
    if (typeof p === "number" && Number.isFinite(p)) return p;
    return livePositionState.published ? livePositionState.position : fallback;
  } catch {
    return livePositionState.published ? livePositionState.position : fallback;
  }
}

/**
 * Renderer handoff: when the tile unmounts (leaving the call) it parks the
 * live position here, and the card - whose player would otherwise start
 * from the STALE last-synced state.position - picks it up and re-syncs the
 * party. Consumed once, fresh only.
 */
export interface RendererHandoff {
  token: number;
  position: number;
  duration: number;
  playing: boolean;
  at: number;
}

let _handoff: (RendererHandoff & { videoId: string }) | null = null;
let _handoffToken = 0;

export function peekHandoff(videoId?: string): RendererHandoff | null {
  const h = _handoff;
  if (!h || (videoId && h.videoId !== videoId) || Date.now() - h.at > 15_000)
    return null;
  const elapsed = h.playing ? (Date.now() - h.at) / 1000 : 0;
  return {
    token: h.token,
    position: h.position + elapsed,
    duration: h.duration,
    playing: h.playing,
    // position already includes elapsed time up to this read; consumers use
    // this timestamp as the new clock origin and must not add it twice.
    at: Date.now(),
  };
}

export function parkHandoff(
  videoId: string,
  position: number,
  duration: number,
  playing: boolean
): void {
  if (Number.isFinite(position) && position > 0) {
    _handoff = {
      videoId,
      token: ++_handoffToken,
      position,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
      playing,
      at: Date.now(),
    };
  }
}

export function takeHandoff(videoId?: string): RendererHandoff | null {
  const h = peekHandoff(videoId);
  _handoff = null;
  return h;
}
