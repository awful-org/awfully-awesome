/**
 * Where a party finds its show and its video, split into pure parsers and
 * thin fetchers.
 *
 * Two services, neither of them behind the instance relay:
 *
 *   catalog  POST https://graphql.anilist.co        JSON, open CORS -> direct
 *   video    https://zokoanime.video/stream/mal/<id>/<episode>/<sub|dub>
 *            an embeddable player page, driven over postMessage
 *
 * zokoanime keeps no catalog of its own: its docs say to look the show up
 * on MyAnimeList and pass that id. AniList is the searchable half, and it
 * carries each show's MyAnimeList id (`idMal`), which is what a party
 * stores. zokoanime documents AniList ids too, but its /stream/anilist/
 * path answers 404 for every show tried, so the MyAnimeList one is the id
 * that actually plays.
 *
 * The relay's proxy is GET only and AniList is GraphQL over POST, which is
 * fine: AniList sends open CORS headers, so each viewer's browser asks it
 * directly and the instance needs no configuration at all.
 */

export interface Show {
  /** The show's MyAnimeList id, which is what zokoanime plays by. */
  id: number;
  title: string;
  image: string | null;
}

/**
 * One episode of the party's show. Its number is its identity: zokoanime
 * addresses an episode as show id plus number, so there is no separate
 * provider id to carry.
 */
export interface Episode {
  number: number;
}

/** Audio language of a stream: "jpn" is subbed, "eng" is dubbed. The values
 *  predate this provider and are what device storage already holds. */
export type Lang = "jpn" | "eng";

/**
 * AniList itself is not answering: a 5xx, a rate limit (429), or no answer
 * at all (status 0). Not a format change, so the card can say "try again
 * later" instead of blaming the plugin.
 */
export class UpstreamDownError extends Error {
  status: number;
  constructor(status: number) {
    super(`AniList answered ${status || "nothing"}`);
    this.name = "UpstreamDownError";
    this.status = status;
  }
}

/** How many search results a card may carry. Card payloads are 16 KB and
 *  every member renders the whole list, so the cap is small on purpose. */
export const SEARCH_CAP = 10;

/**
 * The only origin a poster may come from: AniList serves its covers from
 * this prefix and nothing else (see fixtures/search.json).
 *
 * Pinned because a peer-supplied image url is a beacon: the card renders it
 * into an <img> that every member's browser fetches, and the same url reaches
 * each member's OS media surface, so whatever host is named there learns who
 * is in the party and when.
 */
export const IMAGE_HOST_PREFIX =
  "https://s4.anilist.co/file/anilistcdn/media/anime/cover/";

/** The embed's origin, both for building its url and for checking that a
 *  message really came from it. */
export const PLAYER_ORIGIN = "https://zokoanime.video";

export function validShowId(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v < 2 ** 31;
}

/**
 * `https://myanimelist.net/anime/47917/Bocchi_the_Rock` -> `47917`.
 *
 * A link copied from the address bar usually has no scheme, and without one
 * new URL() throws, so a scheme is added first and the host check below
 * rejects anything that was really a plain search term (`naruto` -> host
 * `naruto`, not myanimelist.net).
 */
export function showIdFromUrl(input: string): number | null {
  const raw = input.trim();
  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "myanimelist.net") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "anime" || !/^[0-9]{1,10}$/.test(parts[1] ?? ""))
      return null;
    const id = Number(parts[1]);
    return validShowId(id) ? id : null;
  } catch {
    return null;
  }
}

/** The embed page for one episode in one audio language.
 *
 * `autoplay=0` because the party, not the embed, decides when to play: the
 * player is told to over postMessage once it says it is ready. `resume=0`
 * because the embed otherwise picks up wherever THIS viewer last left the
 * video, which is not where the party is. `asi=0` keeps intros where they
 * are: an auto-skip on one member's screen is a seek nobody else made. */
export function embedUrl(showId: number, episode: number, lang: Lang): string {
  const track = lang === "eng" ? "dub" : "sub";
  return `${PLAYER_ORIGIN}/stream/mal/${showId}/${episode}/${track}?autoplay=0&resume=0&asi=0`;
}

interface MediaTitle {
  romaji?: unknown;
  english?: unknown;
}

function titleOf(title: MediaTitle | null | undefined): string {
  const pick = [title?.english, title?.romaji].find(
    (t): t is string => typeof t === "string" && t.trim() !== ""
  );
  return pick ? pick.trim().slice(0, 200) : "";
}

function imageOf(cover: { medium?: unknown } | null | undefined): string | null {
  const src = cover?.medium;
  // Anything that is not the provider's own cover CDN is dropped rather
  // than shown: see IMAGE_HOST_PREFIX.
  return typeof src === "string" && src.startsWith(IMAGE_HOST_PREFIX)
    ? src
    : null;
}

interface RawMedia {
  idMal?: unknown;
  title?: MediaTitle | null;
  coverImage?: { medium?: unknown } | null;
  episodes?: unknown;
  status?: unknown;
  nextAiringEpisode?: { episode?: unknown } | null;
}

/** A media row as a Show, or null when it has no MyAnimeList id - such a
 *  show exists on AniList but zokoanime has no way to play it. */
function showOf(media: RawMedia | null | undefined): Show | null {
  if (!media || typeof media !== "object") return null;
  if (!validShowId(media.idMal)) return null;
  const title = titleOf(media.title);
  if (!title) return null;
  return { id: media.idMal, title, image: imageOf(media.coverImage) };
}

export function parseSearch(json: unknown): Show[] {
  const list = (json as { data?: { Page?: { media?: unknown } } } | null)?.data
    ?.Page?.media;
  if (!Array.isArray(list)) return [];
  const out: Show[] = [];
  const seen = new Set<number>();
  for (const raw of list) {
    const show = showOf(raw as RawMedia);
    if (!show || seen.has(show.id)) continue;
    seen.add(show.id);
    out.push(show);
    if (out.length >= SEARCH_CAP) break;
  }
  return out;
}

/** How many episodes one show may contribute. The longest-running shows are
 *  in the low thousands, so this is headroom for a real show and a ceiling
 *  on a count that decided to be a million. */
export const EPISODES_CAP = 2000;

/**
 * How many episodes have aired. A finished show says so in `episodes`; an
 * airing one leaves that null (or names the planned total) and says which
 * episode airs next, so everything before that one is out.
 */
export function airedEpisodes(json: unknown): number {
  const media = (json as { data?: { Media?: RawMedia | null } } | null)?.data
    ?.Media;
  if (!media || typeof media !== "object") return 0;
  const next = media.nextAiringEpisode?.episode;
  const count =
    typeof next === "number" && Number.isInteger(next) && next > 0
      ? next - 1
      : media.episodes;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
    return 0;
  return Math.min(count, EPISODES_CAP);
}

/** The episode list a count stands for: 1 through count, in order. */
export function episodeList(count: number): Episode[] {
  return Array.from({ length: count }, (_, i) => ({ number: i + 1 }));
}

/** The show a media lookup describes, for a pasted MyAnimeList url. */
export function parseMediaShow(json: unknown): Show | null {
  return showOf(
    (json as { data?: { Media?: RawMedia | null } } | null)?.data?.Media
  );
}

/**
 * One in-flight request per key, and the answer kept for the session.
 * Episode counts do not change while a party is watching, and four members
 * opening the same show should be one request, not four. No retries and no
 * backoff: a failure is reported to the caller, which is the surface that
 * can say so, and the key is freed to try again.
 */
function memo<T>(cache: Map<string, T>, inflight: Map<string, Promise<T>>) {
  return (key: string, work: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const value = await work();
      cache.set(key, value);
      return value;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
}

const ENDPOINT = "https://graphql.anilist.co";

async function graphql(
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    // A network failure, or a 5xx that arrived without CORS headers and
    // reads as a blocked request.
    throw new UpstreamDownError(0);
  }
  // AniList answers an unknown id with a 404 that still carries a JSON body
  // naming Media as null: that is an answer, not an outage.
  if (res.status === 429 || res.status >= 500)
    throw new UpstreamDownError(res.status);
  if (!res.ok && res.status !== 404)
    throw new Error(`AniList returned ${res.status}`);
  return res.json();
}

// Only shows that have aired, whole or in part: an announced show has no
// episodes to play, and picking one would leave the party with an empty
// list. Adult entries are left out too: the card is shown to the whole
// room, and AniList's own site hides them unless a viewer opts in.
const SEARCH_QUERY = `query($q:String){Page(perPage:${SEARCH_CAP}){media(search:$q,type:ANIME,status_in:[FINISHED,RELEASING],isAdult:false,sort:[POPULARITY_DESC]){idMal title{romaji english} coverImage{medium}}}}`;

const MEDIA_QUERY =
  "query($id:Int){Media(idMal:$id,type:ANIME){idMal title{romaji english} coverImage{medium} episodes status nextAiringEpisode{episode}}}";

export async function search(query: string): Promise<Show[]> {
  return parseSearch(await graphql(SEARCH_QUERY, { q: query.trim() }));
}

const mediaCache = new Map<string, unknown>();
const mediaInflight = new Map<string, Promise<unknown>>();
const memoMedia = memo(mediaCache, mediaInflight);

/** One media lookup serves both the pasted-url title and the episode count,
 *  so the card and the command asking about the same show share it. */
function media(showId: number): Promise<unknown> {
  return memoMedia(String(showId), () => graphql(MEDIA_QUERY, { id: showId }));
}

/** The show behind a MyAnimeList id, or null when AniList does not know it. */
export async function showById(showId: number): Promise<Show | null> {
  return parseMediaShow(await media(showId));
}

/** Every episode that has aired, in order. */
export async function episodes(showId: number): Promise<Episode[]> {
  return episodeList(airedEpisodes(await media(showId)));
}
