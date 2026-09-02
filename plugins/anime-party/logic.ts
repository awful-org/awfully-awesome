import type { UpdateCtx } from "$lib/plugins/api";
// The shapes and the two pure validators anidb.ts already owns. Nothing
// here calls a fetcher: reduce replays, and a replayed fetch is a bug.
import type { Episode, Show } from "./anidb";
import { IMAGE_HOST_PREFIX, SEARCH_CAP, validShowId } from "./anidb";

export type ActivityAction =
  | "searched"
  | "picked"
  | "added"
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
  /** The episode NUMBER the action was about, for display - not its id.
   *  "Bruno skipped 7" is the sentence; the id means nothing to a reader. */
  episode: number | null;
}

export interface AnimeState {
  /** What was searched for. Kept so the card can show it above results. */
  query: string;
  /** Candidates, shown only while `show` is null. */
  results: Show[];
  show: Show | null;
  queue: Episode[];
  currentIndex: number | null;
  playing: boolean;
  position: number;
  /**
   * When `position` was true on the SENDER's wall clock (the $lib/plugins/
   * watch tick model): a bare position ages the moment it is written, and
   * two peers reading it at different instants land in different places.
   * Null for track changes, where position 0 has no sender clock to project
   * against - consumers then fall back to the raw position.
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
  syncRequest?: { id: string; requesterDid: string };
  syncResponse?: { id: string; targetDid: string; duration: number };
  /** The command's search hit a 204: this instance has not allowlisted
   *  anidb.app. A fact the card states, not an error it retries. */
  notConfigured: boolean;
}

export { SEARCH_CAP };

/**
 * Room-wide queue ceiling, ENFORCED here because update.data is untrusted -
 * "up to 200" is only a promise until this line. Every member renders the
 * whole queue, so an unbounded season import is an unbounded DOM on every
 * client.
 */
export const QUEUE_CAP = 200;

/**
 * Episodes one update may carry. Updates are capped at 4 KB, and a long
 * season has to arrive in batches anyway - so the reducer says how big a
 * batch it will accept rather than trusting the sender to have split it.
 */
export const ADD_BATCH = 50;

/** Only this many activity entries survive; 4 are ever rendered. Unbounded,
 *  a week-old party's replay copied an ever-growing array per fold - O(n²)
 *  over the party's whole life, paid on every cold rebuild. */
const ACTIVITY_CAP = 16;

const TITLE_CAP = 200;
/** Longest query a card may carry. Exported so the command truncates to the
 *  same length it will be validated against, instead of sending one the
 *  reducer then drops. */
export const QUERY_CAP = 100;
const IMAGE_CAP = 512;

/** A show as it arrives from a peer: every field bounded, image on the
 *  provider's poster CDN or nothing. Pinned to one host rather than allowed
 *  to be any https url, because a peer-supplied image url is a beacon: the
 *  card renders it into an <img> every member's browser fetches, and it
 *  reaches each member's OS media surface too, so whatever host is named
 *  there learns who is in the party and when. A relative path would also
 *  resolve against awful.chat's own origin. */
function validShow(value: unknown): value is Show {
  const show = value as Show | null;
  if (!show || typeof show !== "object") return false;
  if (!validShowId(show.id)) return false;
  if (
    typeof show.title !== "string" ||
    show.title.length === 0 ||
    show.title.length > TITLE_CAP
  )
    return false;
  return (
    show.image === null ||
    (typeof show.image === "string" &&
      show.image.length <= IMAGE_CAP &&
      show.image.startsWith(IMAGE_HOST_PREFIX))
  );
}

function validEpisode(value: unknown): value is Episode {
  const ep = value as Episode | null;
  if (!ep || typeof ep !== "object") return false;
  return (
    typeof ep.id === "number" &&
    Number.isInteger(ep.id) &&
    ep.id > 0 &&
    ep.id < 2 ** 31 &&
    typeof ep.number === "number" &&
    Number.isInteger(ep.number) &&
    ep.number >= 0
  );
}

/** Peer-supplied candidate lists, normalized: valid shows only, no
 *  duplicate ids, never longer than one card is allowed to carry. */
function validShows(value: unknown): Show[] {
  if (!Array.isArray(value)) return [];
  const out: Show[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= SEARCH_CAP) break;
    if (!validShow(raw) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    out.push({ id: raw.id, title: raw.title, image: raw.image });
  }
  return out;
}

function validQuery(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= QUERY_CAP
  );
}

/**
 * Who answers a fresh join with the authoritative position: the owner if
 * still a member, else the longest-standing member - never the newest
 * member (the joiner themselves). Map insertion order IS fold order, so
 * every client computes the same responder; owner-only responding left
 * joiners stuck at the stale synced position whenever the owner was gone.
 */
export function syncResponder(anime: AnimeState): string | null {
  const dids = [...anime.members.keys()];
  if (dids.length < 2) return null;
  return syncResponderFor(anime, dids[dids.length - 1]);
}

/**
 * The responder for a specific requester: any member but them, owner
 * preferred. A refreshed HOST asks too - the party's live position lives
 * with whoever kept playing, and the owner's own folded state is exactly
 * what went stale.
 */
export function syncResponderFor(
  anime: AnimeState,
  excludeDid: string
): string | null {
  const others = [...anime.members.keys()].filter((did) => did !== excludeDid);
  if (!others.length) return null;
  return others.includes(anime.ownerDid) ? anime.ownerDid : others[0];
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

export function initialState(cardData: unknown): AnimeState {
  const data = cardData as {
    query?: unknown;
    results?: unknown;
    show?: unknown;
    ownerDid?: unknown;
    notConfigured?: unknown;
  } | null;
  const show = validShow(data?.show) ? data.show : null;
  // cardData comes from a peer, so an absent or empty ownerDid is not a
  // party with no host - it is a party nobody can be shown to own. Every
  // real creation path sets it (index.ts passes selfDid), so the only way
  // to get here is a forged card.
  const ownerDid =
    typeof data?.ownerDid === "string" && data.ownerDid !== ""
      ? data.ownerDid
      : "";
  return {
    query: validQuery(data?.query) ? data.query : "",
    // Once a show is picked the candidate list is dead weight on every
    // client, so a card that names both keeps only the show.
    results: show ? [] : validShows(data?.results),
    show,
    queue: [],
    currentIndex: null,
    playing: false,
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
    notConfigured: data?.notConfigured === true,
  };
}

function validIndex(index: unknown, queue: Episode[]): index is number {
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

/** The episode NUMBER at a queue slot, for the activity log. */
function numberAt(anime: AnimeState, index: number | null): number | null {
  if (index === null) return null;
  return anime.queue[index]?.number ?? null;
}

function withActivity(
  state: AnimeState,
  ctx: UpdateCtx,
  action: ActivityAction,
  episode: number | null
): AnimeState {
  const activity = [
    ...state.activity.slice(-(ACTIVITY_CAP - 1)),
    { senderName: ctx.senderName, action, episode },
  ];
  return { ...state, activity, activitySeq: state.activitySeq + 1 };
}

/**
 * The queue slot a concrete episode occupies, or -1. Navigation is resolved
 * on the client (which holds the show's full episode list) and sent as a
 * concrete episode, so this is how the reducer tells "already queued, just
 * move to it" from "new, grow the queue".
 */
function indexOfEpisode(anime: AnimeState, id: number): number {
  return anime.queue.findIndex((episode) => episode.id === id);
}

export function reduce(
  state: unknown,
  update: { data: unknown },
  ctx: UpdateCtx
): AnimeState {
  const anime = state as AnimeState;
  const data = update.data as Record<string, unknown>;

  if (anime.closed) return anime;

  switch (data.action) {
    case "close":
      // Strict, with no `anime.ownerDid &&` in front of it. That guard reads
      // as "only check when there is an owner" and behaves as "skip the
      // check when there is not", which let any peer disband a party whose
      // card simply omitted the field.
      return ctx.senderDid !== anime.ownerDid
        ? anime
        : withActivity(
            { ...anime, playing: false, closed: true },
            ctx,
            "closed",
            null
          );
    case "host-left": {
      const observers = [...anime.members.keys()].filter(
        (did) => did !== anime.ownerDid
      );
      return !anime.members.has(ctx.senderDid) || observers[0] !== ctx.senderDid
        ? anime
        : withActivity(
            { ...anime, playing: false, closed: true },
            ctx,
            "host left",
            null
          );
    }
    case "join": {
      if (anime.members.has(ctx.senderDid)) return anime;
      const members = new Map(anime.members);
      members.set(ctx.senderDid, ctx.senderName);
      return withActivity({ ...anime, members }, ctx, "joined", null);
    }
    case "resync": {
      if (
        !anime.members.has(ctx.senderDid) ||
        typeof data.requestId !== "string" ||
        data.requestId.length < 8 ||
        data.requestId.length > 128 ||
        data.requesterDid !== ctx.senderDid
      )
        return anime;
      return withActivity(
        {
          ...anime,
          syncRequest: {
            id: data.requestId,
            requesterDid: ctx.senderDid,
          },
        },
        ctx,
        "sync requested",
        numberAt(anime, anime.currentIndex)
      );
    }
    case "leave": {
      if (!anime.members.has(ctx.senderDid) || ctx.senderDid === anime.ownerDid)
        return anime;
      const members = new Map(anime.members);
      members.delete(ctx.senderDid);
      return withActivity({ ...anime, members }, ctx, "left", null);
    }
    case "prune": {
      if (
        ctx.senderDid !== anime.ownerDid ||
        typeof data.did !== "string" ||
        data.did === anime.ownerDid ||
        !anime.members.has(data.did)
      )
        return anime;
      const members = new Map(anime.members);
      members.delete(data.did);
      return { ...anime, members };
    }
    case "sync": {
      // A targeted response is judged against ITS request's responder, so a
      // non-owner can answer the owner's own refresh resync.
      const expectedResponder =
        typeof data.requestId === "string" &&
        anime.syncRequest &&
        data.requestId === anime.syncRequest.id
          ? syncResponderFor(anime, anime.syncRequest.requesterDid)
          : syncResponder(anime);
      if (
        ctx.senderDid !== expectedResponder ||
        !validIndex(data.index, anime.queue) ||
        !validPosition(data.position) ||
        typeof data.playing !== "boolean" ||
        (data.duration !== undefined && !validPosition(data.duration))
      )
        return anime;
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
        ...anime,
        currentIndex: data.index,
        position: data.position,
        playing: data.playing,
        ...tickOf(data, ctx),
        syncRequest: targeted ? undefined : anime.syncRequest,
        syncResponse: targeted,
      };
    }
    default:
      break;
  }

  // Likewise unconditional. The owner is seeded into members at creation
  // and "join" is handled above this line, so nothing legitimate is locked
  // out - but a card with no owner no longer waves everybody through.
  if (!anime.members.has(ctx.senderDid)) return anime;

  switch (data.action) {
    case "search": {
      // Only while nothing is picked. Once the party is watching a show,
      // a stray search would swap the whole card out from under it.
      if (anime.show !== null || !validQuery(data.query)) return anime;
      const results = validShows(data.results);
      return withActivity(
        { ...anime, query: data.query, results },
        ctx,
        "searched",
        null
      );
    }
    case "pick-show": {
      // Re-pickable until the queue has something in it: picking the wrong
      // Bocchi is a two-second mistake, and re-running /anime to fix it
      // would strand the members who already joined.
      if (anime.queue.length > 0 || !validShow(data.show)) return anime;
      const show: Show = {
        id: data.show.id,
        title: data.show.title,
        image: data.show.image,
      };
      return withActivity({ ...anime, show, results: [] }, ctx, "picked", null);
    }
    case "add": {
      if (anime.show === null || !Array.isArray(data.episodes)) return anime;
      const room = QUEUE_CAP - anime.queue.length;
      if (room <= 0) return anime;
      // Already-queued episodes are dropped rather than rejecting the whole
      // batch: "add the season" over a queue that holds episode 1 should
      // land 2..12, not nothing.
      const have = new Set(anime.queue.map((ep) => ep.id));
      const additions: Episode[] = [];
      for (const raw of data.episodes.slice(0, ADD_BATCH)) {
        if (additions.length >= room) break;
        if (!validEpisode(raw) || have.has(raw.id)) continue;
        have.add(raw.id);
        additions.push({ id: raw.id, number: raw.number });
      }
      if (!additions.length) return anime;
      const landedAt = anime.queue.length;
      const idle = anime.currentIndex === null;
      return withActivity(
        {
          ...anime,
          queue: [...anime.queue, ...additions],
          // An idle party starts on what just arrived, so the first batch
          // of a season begins playing before the rest has been queued.
          currentIndex: idle ? landedAt : anime.currentIndex,
          playing: idle ? true : anime.playing,
        },
        ctx,
        "added",
        additions[0].number
      );
    }
    case "select": {
      if (!validIndex(data.index, anime.queue)) return anime;
      return withActivity(
        { ...anime, currentIndex: data.index, position: 0, tickAtMs: null, tickBy: null },
        ctx,
        "selected",
        anime.queue[data.index].number
      );
    }
    case "step": {
      // Next and previous walk the SHOW, not just the queue. The client holds
      // the show's full episode list (the reducer never fetches), resolves the
      // adjacent episode, and sends it here as a concrete { id, number }. If it
      // is already queued we just move to it; otherwise we grow the queue by
      // one - at the end for a forward step, at the front for a backward one -
      // so an episode that was never added still plays. `at` defaults forward.
      if (!validEpisode(data.episode)) return anime;
      const episode: Episode = {
        id: data.episode.id,
        number: data.episode.number,
      };
      const back = data.at === "start";
      const action: ActivityAction = back
        ? "went to the previous track"
        : "skipped";
      const at = indexOfEpisode(anime, episode.id);
      if (at !== -1) {
        if (at === anime.currentIndex) return anime;
        return withActivity(
          { ...anime, currentIndex: at, position: 0, tickAtMs: null, tickBy: null },
          ctx,
          action,
          episode.number
        );
      }
      // A full queue cannot grow; the client shows the "latest episode" note
      // rather than the party silently ignoring the press.
      if (anime.queue.length >= QUEUE_CAP) return anime;
      const queue = back
        ? [episode, ...anime.queue]
        : [...anime.queue, episode];
      return withActivity(
        {
          ...anime,
          queue,
          // Prepending shifts every later slot by one, but we are moving TO
          // the new episode, so its slot (0, or the new last) is what current
          // points at. An idle party starts playing on the step.
          currentIndex: back ? 0 : queue.length - 1,
          position: 0,
          tickAtMs: null,
          tickBy: null,
          playing: anime.currentIndex === null ? true : anime.playing,
        },
        ctx,
        action,
        episode.number
      );
    }
    case "remove": {
      if (!validIndex(data.index, anime.queue)) return anime;
      const removed = anime.queue[data.index].number;
      const queue = anime.queue.filter((_, index) => index !== data.index);
      let currentIndex = anime.currentIndex;
      let playing = anime.playing;
      let position = anime.position;
      // The tick survives queue management that does not touch playback;
      // it only dies with the position reset below - clearing it on every
      // remove disabled drift correction for the whole party over an
      // unrelated queue edit.
      let tickAtMs = anime.tickAtMs;
      let tickBy = anime.tickBy;

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
        { ...anime, queue, currentIndex, playing, position, tickAtMs, tickBy },
        ctx,
        "removed",
        removed
      );
    }
    case "play": {
      if (anime.currentIndex === null || !validPosition(data.position))
        return anime;
      if (anime.playing && anime.position === data.position) return anime;
      return withActivity(
        { ...anime, playing: true, position: data.position, ...tickOf(data, ctx) },
        ctx,
        "played",
        numberAt(anime, anime.currentIndex)
      );
    }
    case "pause": {
      if (anime.currentIndex === null || !validPosition(data.position))
        return anime;
      if (!anime.playing && anime.position === data.position) return anime;
      return withActivity(
        { ...anime, playing: false, position: data.position, ...tickOf(data, ctx) },
        ctx,
        "paused",
        numberAt(anime, anime.currentIndex)
      );
    }
    case "seek": {
      if (anime.currentIndex === null || !validPosition(data.position))
        return anime;
      if (anime.position === data.position) return anime;
      return withActivity(
        { ...anime, position: data.position, ...tickOf(data, ctx) },
        ctx,
        "seeked",
        numberAt(anime, anime.currentIndex)
      );
    }
    default:
      return anime;
  }
}

/**
 * Where a relative seek lands: clamped so "back 10s" near the start hits 0
 * and "forward 10s" near the end stops just short of it (seeking AT the
 * duration fires "ended" and skips the episode, which is not what a nudge
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
 * position write carried no sender clock (a track change) - consumers fall
 * back to the raw position then. rate is always 1: the rate lane of the
 * control law is left to the player wave to opt into. seq is unused by the
 * control law and pinned to 0.
 */
export function stateTick(
  anime: Pick<AnimeState, "playing" | "position" | "tickAtMs">
): { paused: boolean; position: number; atMs: number; rate: number; seq: number } | null {
  if (anime.tickAtMs === null) return null;
  return {
    paused: !anime.playing,
    position: anime.position,
    atMs: anime.tickAtMs,
    rate: 1,
    seq: 0,
  };
}
