import type { UpdateCtx } from "$lib/plugins/api";

export type ActivityAction =
  | "added"
  | "added a playlist"
  | "removed"
  | "skipped"
  | "played"
  | "paused"
  | "seeked"
  | "selected"
  | "closed"
  | "host left"
  | "joined"
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
  const others = dids.slice(0, -1);
  return others.includes(music.ownerDid) ? music.ownerDid : (others[0] ?? null);
}

export function initialState(cardData: unknown): MusicState {
  const data = cardData as {
    videoId?: unknown;
    playlistId?: unknown;
    ownerDid?: unknown;
  } | null;
  const videoId = validVideoId(data?.videoId) ? data.videoId : null;
  const playlistId =
    typeof data?.playlistId === "string" &&
    /^[A-Za-z0-9_-]{10,128}$/.test(data.playlistId)
      ? data.playlistId
      : null;
  const ownerDid = typeof data?.ownerDid === "string" ? data.ownerDid : "";
  return {
    queue: videoId ? [videoId] : [],
    currentIndex: videoId ? 0 : null,
    playing: false,
    position: 0,
    activity: [],
    activitySeq: 0,
    loop: "off",
    closed: false,
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
      return music.ownerDid && ctx.senderDid !== music.ownerDid
        ? music
        : withActivity(
            { ...music, playing: false, closed: true },
            ctx,
            "closed",
            null
          );
    case "host-left":
      return !music.members.has(ctx.senderDid)
        ? music
        : withActivity(
            { ...music, playing: false, closed: true },
            ctx,
            "host left",
            null
          );
    case "join": {
      if (music.members.has(ctx.senderDid)) return music;
      const members = new Map(music.members);
      members.set(ctx.senderDid, ctx.senderName);
      return withActivity({ ...music, members }, ctx, "joined", null);
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
      if (
        ctx.senderDid !== music.ownerDid ||
        !validIndex(data.index, music.queue) ||
        !validPosition(data.position) ||
        typeof data.playing !== "boolean"
      )
        return music;
      return {
        ...music,
        currentIndex: data.index,
        position: data.position,
        playing: data.playing,
      };
    }
    default:
      break;
  }

  if (music.ownerDid && !music.members.has(ctx.senderDid)) return music;

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
      };
    }
    case "select": {
      if (!validIndex(data.index, music.queue)) return music;
      return withActivity(
        { ...music, currentIndex: data.index, position: 0 },
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
      if (music.loop === "track") return { ...music, position: 0 };
      const next = music.currentIndex + 1;
      if (next < music.queue.length)
        return { ...music, currentIndex: next, position: 0 };
      return music.loop === "queue" && music.queue.length
        ? { ...music, currentIndex: 0, position: 0 }
        : { ...music, currentIndex: null, playing: false, position: 0 };
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

      if (currentIndex === data.index) {
        currentIndex =
          queue.length === 0 ? null : Math.min(data.index, queue.length - 1);
        playing = queue.length === 0 ? false : playing;
        position = 0;
      } else if (currentIndex !== null && currentIndex > data.index) {
        currentIndex -= 1;
      }

      return withActivity(
        { ...music, queue, currentIndex, playing, position },
        ctx,
        "removed",
        removedVideoId
      );
    }
    case "skip": {
      if (music.currentIndex === null) return music;
      const videoId = music.queue[music.currentIndex] ?? null;
      const currentIndex = music.currentIndex + 1;
      return withActivity(
        currentIndex < music.queue.length
          ? { ...music, currentIndex, position: 0 }
          : { ...music, currentIndex: null, playing: false, position: 0 },
        ctx,
        "skipped",
        videoId
      );
    }
    case "play": {
      if (music.currentIndex === null || !validPosition(data.position))
        return music;
      if (music.playing && music.position === data.position) return music;
      return withActivity(
        { ...music, playing: true, position: data.position },
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
        { ...music, playing: false, position: data.position },
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
        { ...music, position: data.position },
        ctx,
        "seeked",
        music.queue[music.currentIndex]
      );
    }
    default:
      return music;
  }
}
