import type { UpdateCtx } from "$lib/plugins/api";

export type ActivityAction =
  | "added"
  | "added a playlist"
  | "shuffled the queue"
  | "removed"
  | "skipped"
  | "went to the previous track"
  | "played"
  | "paused"
  | "seeked"
  | "selected"
  | "closed"
  | "host left"
  | "joined"
  | "sync requested"
  | "left";

export interface Activity {
  senderName: string;
  action: ActivityAction;
  videoId: string | null;
}

export interface MusicState {
  queue: string[];
  currentIndex: number | null;
  playing: boolean;
  position: number;
  /**
   * When `position` was true on the SENDER's wall clock (the $lib/plugins/
   * watch tick model): a bare position ages the moment it is written, and
   * two peers reading it at different instants land in different places.
   * Null for legacy updates and for track changes, where position 0 has no
   * sender clock to project against - consumers then fall back to the raw
   * position, which is exactly the old behavior.
   */
  tickAtMs: number | null;
  /** Whose clock tickAtMs is on (ctx.senderDid, host-verified). */
  tickBy: string | null;
  activity: Activity[];
  /** Total activity entries EVER, monotonic. The array itself is capped
   *  (only the tail is rendered), so length cannot be used as a "something
   *  happened" cursor - this can. */
  activitySeq: number;
  loop: "off" | "track" | "queue";
  closed: boolean;
  ownerDid: string;
  members: Map<string, string>;
  playlistRequests: string[];
  syncRequest?: { id: string; requesterDid: string };
  syncResponse?: { id: string; targetDid: string; duration: number };
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function validVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID_RE.test(value);
}

export function videoIdFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    let candidate: string | null = null;

    if (host === "youtu.be") {
      candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
    } else if (
      host === "youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com"
    ) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/watch") candidate = url.searchParams.get("v");
      if (parts[0] === "shorts" || parts[0] === "embed")
        candidate = parts[1] ?? null;
    }

    return validVideoId(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function playlistIdFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      host !== "youtube.com" &&
      host !== "m.youtube.com" &&
      host !== "music.youtube.com"
    )
      return null;
    const id = url.searchParams.get("list");
    return id && /^[A-Za-z0-9_-]{10,128}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Who answers a fresh join with the authoritative position: the owner if
 * still a member, else the longest-standing member - never the newest
 * member (the joiner themselves). Map insertion order IS fold order, so
 * every client computes the same responder; owner-only responding left
 * joiners stuck at the stale synced position whenever the owner was gone.
 */
export function syncResponder(music: MusicState): string | null {
  const dids = [...music.members.keys()];
  if (dids.length < 2) return null;
  return syncResponderFor(music, dids[dids.length - 1]);
}

/**
 * The responder for a specific requester: any member but them, owner
 * preferred. A refreshed HOST asks too - the party's live position lives
 * with whoever kept playing, and the owner's own folded state is exactly
 * what went stale.
 */
export function syncResponderFor(
  music: MusicState,
  excludeDid: string
): string | null {
  const others = [...music.members.keys()].filter((did) => did !== excludeDid);
  if (!others.length) return null;
  return others.includes(music.ownerDid) ? music.ownerDid : others[0];
}

/** Fisher-Yates permutation of [0..length) seeded from a string - the
 *  updateId is identical on every client, so so is the deal. */
export function shuffledOrder(length: number, seed: string): number[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const rand = () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
  const order = Array.from({ length }, (_, index) => index);
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export function initialState(cardData: unknown): MusicState {
  const data = cardData as {
    videoId?: unknown;
    playlistId?: unknown;
    ownerDid?: unknown;
  } | null;
  const videoId = validVideoId(data?.videoId) ? data.videoId : null;
  const suppliedQueue = Array.isArray(data?.queue)
    ? data.queue.filter(validVideoId)
    : [];
  const queue = suppliedQueue.length ? suppliedQueue : videoId ? [videoId] : [];
  const currentIndex =
    typeof data?.currentIndex === "number" &&
    Number.isInteger(data.currentIndex) &&
    data.currentIndex >= 0 &&
    data.currentIndex < queue.length
      ? data.currentIndex
      : queue.length
        ? 0
        : null;
  const playlistId =
    typeof data?.playlistId === "string" &&
    /^[A-Za-z0-9_-]{10,128}$/.test(data.playlistId)
      ? data.playlistId
      : null;
  // cardData comes from a peer, so an absent or empty ownerDid is not a
  // party with no host - it is a party nobody can be shown to own. Every
  // real creation path sets it (index.ts and MusicCard's start-again both
  // pass selfDid), so the only way to get here is a forged card.
  const ownerDid =
    typeof data?.ownerDid === "string" && data.ownerDid !== ""
      ? data.ownerDid
      : "";
  return {
    queue,
    currentIndex,
    playing: currentIndex !== null,
    position: 0,
    tickAtMs: null,
    tickBy: null,
    activity: [],
    activitySeq: 0,
    loop: "off",
    // Born closed when there is no owner, so the reducer's first line turns
    // every action into a no-op rather than each gate having to remember.
    closed: ownerDid === "",
    ownerDid,
    members: new Map(ownerDid ? [[ownerDid, "Host"]] : []),
    playlistRequests: playlistId ? [playlistId] : [],
  };
}

function validIndex(index: unknown, queue: string[]): index is number {
  return (
    typeof index === "number" &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < queue.length
  );
}

/** Sender wall clock for a tick: epoch ms inside a sane century. */
function validAtMs(atMs: unknown): atMs is number {
  return (
    typeof atMs === "number" &&
    Number.isFinite(atMs) &&
    atMs > 1e12 &&
    atMs < 1e13
  );
}

/** The tick fields a position-bearing action carries (or clears). */
function tickOf(
  data: { atMs?: unknown },
  ctx: { senderDid: string }
): { tickAtMs: number | null; tickBy: string | null } {
  return validAtMs(data.atMs)
    ? { tickAtMs: data.atMs, tickBy: ctx.senderDid }
    : { tickAtMs: null, tickBy: null };
}

function validPosition(position: unknown): position is number {
  return (
    typeof position === "number" && Number.isFinite(position) && position >= 0
  );
}

/** Only this many activity entries survive; 4 are ever rendered. Unbounded,
 *  a week-old party's replay copied an ever-growing array per fold - O(n²)
 *  over the party's whole life, paid on every cold rebuild. */
const ACTIVITY_CAP = 16;

/**
 * Room-wide queue ceiling, ENFORCED here because update.data is untrusted -
 * the README's "up to 200" was only a promise until this line. Every member
 * renders the whole queue, so an unbounded playlist import is an unbounded
 * DOM on every client.
 */
export const QUEUE_CAP = 200;
/** Pending playlist imports; more than a couple queued is a stuck resolver. */
const PLAYLIST_REQUEST_CAP = 3;

function withActivity(
  state: MusicState,
  ctx: UpdateCtx,
  action: ActivityAction,
  videoId: string | null
): MusicState {
  const activity = [
    ...state.activity.slice(-(ACTIVITY_CAP - 1)),
    { senderName: ctx.senderName, action, videoId },
  ];
  return { ...state, activity, activitySeq: state.activitySeq + 1 };
}

function nextTrack(music: MusicState): MusicState {
  if (music.currentIndex === null) return music;
  if (music.loop === "track")
    return { ...music, position: 0, tickAtMs: null, tickBy: null };
  const next = music.currentIndex + 1;
  if (next < music.queue.length)
    return { ...music, currentIndex: next, position: 0, tickAtMs: null, tickBy: null };
  return music.loop === "queue" && music.queue.length
    ? { ...music, currentIndex: 0, position: 0, tickAtMs: null, tickBy: null }
    : { ...music, currentIndex: null, playing: false, position: 0, tickAtMs: null, tickBy: null };
}

function previousTrack(music: MusicState): MusicState {
  if (music.currentIndex === null) return music;
  if (music.loop === "track")
    return { ...music, position: 0, tickAtMs: null, tickBy: null };
  const previous = music.currentIndex - 1;
  if (previous >= 0)
    return { ...music, currentIndex: previous, position: 0, tickAtMs: null, tickBy: null };
  return music.loop === "queue" && music.queue.length
    ? { ...music, currentIndex: music.queue.length - 1, position: 0, tickAtMs: null, tickBy: null }
    : { ...music, position: 0, tickAtMs: null, tickBy: null };
}

export function reduce(
  state: unknown,
  update: { data: unknown },
  ctx: UpdateCtx
): MusicState {
  const music = state as MusicState;
  const data = update.data as Record<string, unknown>;

  if (music.closed) return music;

  switch (data.action) {
    case "close":
      // Strict, with no `music.ownerDid &&` in front of it. That guard reads
      // as "only check when there is an owner" and behaves as "skip the
      // check when there is not", which let any peer disband a party whose
      // card simply omitted the field.
      return ctx.senderDid !== music.ownerDid
        ? music
        : withActivity(
            { ...music, playing: false, closed: true },
            ctx,
            "closed",
            null
          );
    case "host-left": {
      const observers = [...music.members.keys()].filter(
        (did) => did !== music.ownerDid
      );
      return !music.members.has(ctx.senderDid) || observers[0] !== ctx.senderDid
        ? music
        : withActivity(
            { ...music, playing: false, closed: true },
            ctx,
            "host left",
            null
          );
    }
    case "join": {
      if (music.members.has(ctx.senderDid)) return music;
      const members = new Map(music.members);
      members.set(ctx.senderDid, ctx.senderName);
      return withActivity({ ...music, members }, ctx, "joined", null);
    }
    case "resync": {
      if (
        !music.members.has(ctx.senderDid) ||
        typeof data.requestId !== "string" ||
        data.requestId.length < 8 ||
        data.requestId.length > 128 ||
        data.requesterDid !== ctx.senderDid
      )
        return music;
      return withActivity(
        {
          ...music,
          syncRequest: {
            id: data.requestId,
            requesterDid: ctx.senderDid,
          },
        },
        ctx,
        "sync requested",
        music.currentIndex === null ? null : music.queue[music.currentIndex]
      );
    }
    case "leave": {
      if (!music.members.has(ctx.senderDid) || ctx.senderDid === music.ownerDid)
        return music;
      const members = new Map(music.members);
      members.delete(ctx.senderDid);
      return withActivity({ ...music, members }, ctx, "left", null);
    }
    case "prune": {
      if (
        ctx.senderDid !== music.ownerDid ||
        typeof data.did !== "string" ||
        data.did === music.ownerDid ||
        !music.members.has(data.did)
      )
        return music;
      const members = new Map(music.members);
      members.delete(data.did);
      return { ...music, members };
    }
    case "sync": {
      // A targeted response is judged against ITS request's responder, so a
      // non-owner can answer the owner's own refresh resync.
      const expectedResponder =
        typeof data.requestId === "string" &&
        music.syncRequest &&
        data.requestId === music.syncRequest.id
          ? syncResponderFor(music, music.syncRequest.requesterDid)
          : syncResponder(music);
      if (
        ctx.senderDid !== expectedResponder ||
        !validIndex(data.index, music.queue) ||
        !validPosition(data.position) ||
        typeof data.playing !== "boolean" ||
        (data.duration !== undefined && !validPosition(data.duration))
      )
        return music;
      const targeted =
        typeof data.requestId === "string" &&
        typeof data.targetDid === "string"
          ? {
              id: data.requestId,
              targetDid: data.targetDid,
              duration:
                typeof data.duration === "number" ? data.duration : 0,
            }
          : undefined;
      return {
        ...music,
        currentIndex: data.index,
        position: data.position,
        playing: data.playing,
        ...tickOf(data, ctx),
        syncRequest: targeted ? undefined : music.syncRequest,
        syncResponse: targeted,
      };
    }
    default:
      break;
  }

  // Likewise unconditional. The owner is seeded into members at creation
  // and "join" is handled above this line, so nothing legitimate is locked
  // out - but a card with no owner no longer waves everybody through.
  if (!music.members.has(ctx.senderDid)) return music;

  switch (data.action) {
    case "add-playlist": {
      if (
        typeof data.playlistId !== "string" ||
        !/^[A-Za-z0-9_-]{10,128}$/.test(data.playlistId) ||
        music.playlistRequests.includes(data.playlistId) ||
        music.playlistRequests.length >= PLAYLIST_REQUEST_CAP ||
        music.queue.length >= QUEUE_CAP
      )
        return music;
      return withActivity(
        {
          ...music,
          playlistRequests: [...music.playlistRequests, data.playlistId],
        },
        ctx,
        "added a playlist",
        null
      );
    }
    case "resolve-playlist": {
      if (
        ctx.senderDid !== music.ownerDid ||
        typeof data.playlistId !== "string" ||
        data.playlistId !== music.playlistRequests[0] ||
        !Array.isArray(data.videoIds) ||
        typeof data.done !== "boolean"
      )
        return music;
      // A full queue retires the request instead of letting the resolver
      // spin on a head entry that can never land another track.
      const room = QUEUE_CAP - music.queue.length;
      if (room <= 0)
        return { ...music, playlistRequests: music.playlistRequests.slice(1) };
      const videoIds = data.videoIds
        .filter(validVideoId)
        .slice(0, Math.min(2, room));
      if (!videoIds.length) return music;
      const playlistRequests =
        data.done || room <= videoIds.length
          ? music.playlistRequests.slice(1)
          : music.playlistRequests;
      return {
        ...music,
        playlistRequests,
        queue: [...music.queue, ...videoIds],
        currentIndex:
          music.currentIndex === null && videoIds.length
            ? music.queue.length
            : music.currentIndex,
        playing:
          music.currentIndex === null && videoIds.length
            ? true
            : music.playing,
      };
    }
    case "shuffle": {
      if (music.queue.length < 2) return music;
      const order = shuffledOrder(music.queue.length, ctx.updateId);
      const queue = order.map((index) => music.queue[index]);
      return withActivity(
        {
          ...music,
          queue,
          // The playing track keeps playing; only its slot moves.
          currentIndex:
            music.currentIndex === null
              ? null
              : order.indexOf(music.currentIndex),
        },
        ctx,
        "shuffled the queue",
        null
      );
    }
    case "select": {
      if (!validIndex(data.index, music.queue)) return music;
      return withActivity(
        { ...music, currentIndex: data.index, position: 0, tickAtMs: null, tickBy: null },
        ctx,
        "selected",
        music.queue[data.index]
      );
    }
    case "loop": {
      if (data.mode !== "off" && data.mode !== "track" && data.mode !== "queue")
        return music;
      return { ...music, loop: data.mode };
    }
    case "ended": {
      if (data.index !== music.currentIndex || music.currentIndex === null)
        return music;
      return nextTrack(music);
    }
    case "add": {
      if (!validVideoId(data.videoId) || music.queue.length >= QUEUE_CAP)
        return music;
      return withActivity(
        { ...music, queue: [...music.queue, data.videoId] },
        ctx,
        "added",
        data.videoId
      );
    }
    case "remove": {
      if (!validIndex(data.index, music.queue)) return music;
      const removedVideoId = music.queue[data.index];
      const queue = music.queue.filter((_, index) => index !== data.index);
      let currentIndex = music.currentIndex;
      let playing = music.playing;
      let position = music.position;
      // The tick survives queue management that does not touch playback;
      // it only dies with the position reset below - clearing it on every
      // remove disabled drift correction for the whole party over an
      // unrelated queue edit.
      let tickAtMs = music.tickAtMs;
      let tickBy = music.tickBy;

      if (currentIndex === data.index) {
        currentIndex =
          queue.length === 0 ? null : Math.min(data.index, queue.length - 1);
        playing = queue.length === 0 ? false : playing;
        position = 0;
        tickAtMs = null;
        tickBy = null;
      } else if (currentIndex !== null && currentIndex > data.index) {
        currentIndex -= 1;
      }

      return withActivity(
        { ...music, queue, currentIndex, playing, position, tickAtMs, tickBy },
        ctx,
        "removed",
        removedVideoId
      );
    }
    case "skip": {
      if (music.currentIndex === null) return music;
      const videoId = music.queue[music.currentIndex] ?? null;
      return withActivity(nextTrack(music), ctx, "skipped", videoId);
    }
    case "previous": {
      if (music.currentIndex === null) return music;
      const videoId = music.queue[music.currentIndex] ?? null;
      return withActivity(
        previousTrack(music),
        ctx,
        "went to the previous track",
        videoId
      );
    }
    case "play": {
      if (music.currentIndex === null || !validPosition(data.position))
        return music;
      if (music.playing && music.position === data.position) return music;
      return withActivity(
        { ...music, playing: true, position: data.position, ...tickOf(data, ctx) },
        ctx,
        "played",
        music.queue[music.currentIndex]
      );
    }
    case "pause": {
      if (music.currentIndex === null || !validPosition(data.position))
        return music;
      if (!music.playing && music.position === data.position) return music;
      return withActivity(
        { ...music, playing: false, position: data.position, ...tickOf(data, ctx) },
        ctx,
        "paused",
        music.queue[music.currentIndex]
      );
    }
    case "seek": {
      if (music.currentIndex === null || !validPosition(data.position))
        return music;
      if (music.position === data.position) return music;
      return withActivity(
        { ...music, position: data.position, ...tickOf(data, ctx) },
        ctx,
        "seeked",
        music.queue[music.currentIndex]
      );
    }
    default:
      return music;
  }
}

/**
 * Where a relative seek lands: clamped so "back 10s" near the start hits 0
 * and "forward 10s" near the end stops just short of it (seeking AT the
 * duration fires "ended" and skips the track, which is not what a nudge
 * forward means).
 */
export function seekTarget(
  position: number,
  delta: number,
  duration: number
): number {
  const ceiling = duration > 0 ? Math.max(0, duration - 1) : Infinity;
  return Math.min(Math.max(0, position + delta), ceiling);
}

/**
 * The state's position as a $lib/plugins/watch tick, or null when the last
 * position write carried no sender clock (legacy update, track change) -
 * consumers fall back to the raw position then. rate is always 1: YouTube's
 * iframe rounds fractional playback rates, so this party never plays off
 * unity. seq is unused by the control law and pinned to 0.
 */
export function stateTick(
  music: Pick<MusicState, "playing" | "position" | "tickAtMs">
): { paused: boolean; position: number; atMs: number; rate: number; seq: number } | null {
  if (music.tickAtMs === null) return null;
  return {
    paused: !music.playing,
    position: music.position,
    atMs: music.tickAtMs,
    rate: 1,
    seq: 0,
  };
}
