/**
 * anidb.app, the provider ani-cli 5.x reads, split into pure parsers and
 * thin fetchers.
 *
 * Two of the four steps have no CORS headers and must go through the
 * instance's generic /plugin-proxy; the other two are open and are fetched
 * straight from the viewer's browser. Which is which is a property of the
 * upstream, not a preference, so it is written down here once:
 *
 *   search  GET /browse?q=...                        HTML, no CORS -> proxy
 *   episodes GET /api/frontend/anime/<n>/episodes     JSON, open    -> direct
 *   languages GET /api/frontend/episode/<n>/languages JSON, open    -> direct
 *   embed   GET /embed/<token>                        HTML, no CORS -> proxy
 *
 * Instance requirements (see README.md):
 *   PLUGIN_PROXY_HOSTS=anidb.app,hls.anidb.app
 *
 * Asked for per request, never hoisted into a module-level const: the host
 * reads its api origin from /config.json after load, so there is nothing to
 * inline, and a build-time read would put one instance's address into every
 * instance's bundle.
 */
import { proxyUrl } from "$lib/plugins/api";

export interface Show {
  id: string;
  title: string;
  image: string | null;
}

export interface Episode {
  id: number;
  number: number;
}

/** Audio language of a stream: "jpn" is subbed, "eng" is dubbed. */
export type Lang = "jpn" | "eng";

/** A 204 from the proxy: this instance did not allowlist anidb.app. */
export class NotConfiguredError extends Error {
  constructor(message = "this instance is not configured for anidb.app") {
    super(message);
    this.name = "NotConfiguredError";
  }
}

/** How many search results a card may carry. Card payloads are 16 KB and
 *  every member renders the whole list, so the cap is small on purpose. */
export const SEARCH_CAP = 10;

/**
 * The only origin a poster may come from. anidb.app's browse page serves its
 * posters from this CDN and nothing else (see fixtures/browse.html), so the
 * prefix is a fact about the provider rather than a preference.
 *
 * Pinned because a peer-supplied image url is a beacon: the card renders it
 * into an <img> that every member's browser fetches, and the same url reaches
 * each member's OS media surface, so whatever host is named there learns who
 * is in the party and when.
 */
export const IMAGE_HOST_PREFIX = "https://cdn.xlsbox.com/";

const SHOW_ID_RE = /^[a-z0-9-]+-[0-9]+$/;

export function validShowId(v: unknown): v is string {
  return typeof v === "string" && v.length <= 128 && SHOW_ID_RE.test(v);
}

/** `https://anidb.app/anime/bocchi-the-rock-729` -> `bocchi-the-rock-729`. */
export function showIdFromUrl(input: string): string | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "anidb.app") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "anime") return null;
    const id = parts[1] ?? null;
    return validShowId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * The numeric id the frontend API wants, which is the tail of the slug:
 * `bocchi-the-rock-729` -> `729`. Titles carry digits of their own
 * ("re-zero-2"), so it is the part after the LAST dash, never a search for
 * the first run of digits.
 */
export function numericShowId(id: string): string {
  return id.slice(id.lastIndexOf("-") + 1);
}

const ENTITIES: Record<string, string> = {
  "&#039;": "'",
  "&#39;": "'",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  // Last: unescaping it first would turn "&amp;quot;" into a quote.
  "&amp;": "&",
};

function unescapeHtml(text: string): string {
  return text.replace(
    /&#0?39;|&quot;|&lt;|&gt;|&amp;/g,
    (m) => ENTITIES[m] ?? m
  );
}

/**
 * The browse page's anime cards.
 *
 * Scraped, like ani-cli's own search: anidb.app publishes no search API.
 * The shape matched is the card ANCHOR - href, the anime-card class, and
 * the title attribute - which is markup the page cannot render without,
 * rather than the decorative classes around it.
 */
const CARD_RE =
  /<a\s+href="https:\/\/anidb\.app\/anime\/([a-z0-9-]+)"[^>]*class="[^"]*anime-card[^"]*"[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
const IMG_RE = /<img[^>]+src="([^"]+)"/;

export function parseSearch(html: string): Show[] {
  const out: Show[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(CARD_RE)) {
    const [, id, rawTitle, body] = match;
    if (!validShowId(id) || seen.has(id)) continue;
    const title = unescapeHtml(rawTitle).trim().slice(0, 200);
    if (!title) continue;
    const src = IMG_RE.exec(body)?.[1] ?? "";
    // Anything that is not the provider's own poster CDN is dropped rather
    // than shown: relative placeholders resolve against awful.chat's origin,
    // and any other host is one this scraped page got to name.
    const image = src.startsWith(IMAGE_HOST_PREFIX) ? src : null;
    seen.add(id);
    out.push({ id, title, image });
    if (out.length >= SEARCH_CAP) break;
  }
  return out;
}

/**
 * The HLS master playlist an embed page names. Only hls.anidb.app is
 * accepted: the embed page is scraped HTML, so the url in it is upstream
 * text, and an unchecked one is an arbitrary host the player would load.
 */
const FILE_RE = /file:\s*'([^']+)'/;

export function parseEmbed(html: string): string | null {
  const url = FILE_RE.exec(html)?.[1];
  if (!url || !url.startsWith("https://hls.anidb.app/")) return null;
  return url;
}

function isLang(v: unknown): v is Lang {
  return v === "jpn" || v === "eng";
}

export function parseLanguages(
  json: unknown
): { code: Lang; embedUrl: string }[] {
  const list = (json as { languages?: unknown } | null)?.languages;
  if (!Array.isArray(list)) return [];
  const out: { code: Lang; embedUrl: string }[] = [];
  const seen = new Set<Lang>();
  for (const raw of list) {
    const row = raw as { code?: unknown; embed_url?: unknown } | null;
    if (!row || typeof row !== "object") continue;
    if (!isLang(row.code) || seen.has(row.code)) continue;
    if (
      typeof row.embed_url !== "string" ||
      !row.embed_url.startsWith("https://anidb.app/embed/")
    )
      continue;
    seen.add(row.code);
    out.push({ code: row.code, embedUrl: row.embed_url });
  }
  return out;
}

/** How many episodes one show may contribute. The longest thing anidb.app
 *  lists is in the low thousands, so this is headroom for a real show and a
 *  ceiling on a response that decided to be a million rows long. */
export const EPISODES_CAP = 2000;

export function parseEpisodes(json: unknown): Episode[] {
  const list = (json as { episodes?: unknown } | null)?.episodes;
  if (!Array.isArray(list)) return [];
  const out: Episode[] = [];
  const seen = new Set<number>();
  for (const raw of list) {
    const row = raw as { id?: unknown; number?: unknown } | null;
    if (!row || typeof row !== "object") continue;
    const { id, number } = row;
    if (
      typeof id !== "number" ||
      !Number.isInteger(id) ||
      id <= 0 ||
      id >= 2 ** 31
    )
      continue;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0)
      continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, number });
  }
  // Specials and recaps come back interleaved; the queue is built in
  // episode order, so the sort belongs here and not in every caller.
  // Sorted before the cap, so a long-running show keeps its first 2000
  // episodes rather than whichever 2000 the upstream happened to list first.
  return out.sort((a, b) => a.number - b.number).slice(0, EPISODES_CAP);
}

/**
 * One in-flight request per key, and the answer kept for the session.
 * Episode lists and language lists do not change while a party is watching,
 * and four members opening the same episode picker should be one request,
 * not four. No retries and no backoff: a failure is reported to the caller,
 * which is the surface that can say so, and the key is freed to try again.
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

async function proxied(upstream: string): Promise<string> {
  const res = await fetch(proxyUrl(upstream));
  // 204 is the proxy saying the host is not allowlisted - a configuration
  // fact the card can state, not a transient failure to retry.
  if (res.status === 204) throw new NotConfiguredError();
  if (!res.ok) throw new Error(`anidb.app returned ${res.status}`);
  return res.text();
}

async function directJson(upstream: string): Promise<unknown> {
  const res = await fetch(upstream);
  if (!res.ok) throw new Error(`anidb.app returned ${res.status}`);
  return res.json();
}

/** Search, through the proxy: the browse page carries no CORS headers. */
export async function search(query: string): Promise<Show[]> {
  const q = encodeURIComponent(query.trim()).replace(/%20/g, "+");
  return parseSearch(await proxied(`https://anidb.app/browse?q=${q}`));
}

const episodeCache = new Map<string, Episode[]>();
const episodeInflight = new Map<string, Promise<Episode[]>>();
const memoEpisodes = memo(episodeCache, episodeInflight);

/** Episodes, fetched directly: this endpoint sends open CORS headers, so
 *  the lookup costs the instance relay nothing. */
export function episodes(showId: string): Promise<Episode[]> {
  return memoEpisodes(showId, async () =>
    parseEpisodes(
      await directJson(
        `https://anidb.app/api/frontend/anime/${encodeURIComponent(
          numericShowId(showId)
        )}/episodes`
      )
    )
  );
}

const langCache = new Map<string, { code: Lang; embedUrl: string }[]>();
const langInflight = new Map<string, Promise<{ code: Lang; embedUrl: string }[]>>();
const memoLanguages = memo(langCache, langInflight);

/** Which audio languages an episode has, direct: also open CORS. An
 *  episode may be sub only, dub only, or both. */
export function languages(
  episodeId: number
): Promise<{ code: Lang; embedUrl: string }[]> {
  return memoLanguages(String(episodeId), async () =>
    parseLanguages(
      await directJson(
        `https://anidb.app/api/frontend/episode/${encodeURIComponent(
          String(episodeId)
        )}/languages`
      )
    )
  );
}

const masterCache = new Map<string, { url: string; lang: Lang } | null>();
const masterInflight = new Map<
  string,
  Promise<{ url: string; lang: Lang } | null>
>();
const memoMaster = memo(masterCache, masterInflight);

/**
 * The HLS master playlist for an episode, in the viewer's preferred audio
 * language when that exists and the other one when it does not - a dub-only
 * episode should still play for somebody who asked for subs, labelled with
 * what they actually got rather than what they wanted.
 *
 * Keyed by the PREFERRED language, not the resolved one: it is the input,
 * and a second viewer asking the same question deserves the same answer.
 */
export function masterUrl(
  episodeId: number,
  preferred: Lang
): Promise<{ url: string; lang: Lang } | null> {
  return memoMaster(`${episodeId}:${preferred}`, async () => {
    const langs = await languages(episodeId);
    if (!langs.length) return null;
    const chosen = langs.find((l) => l.code === preferred) ?? langs[0];
    const url = parseEmbed(await proxied(chosen.embedUrl));
    return url ? { url, lang: chosen.code } : null;
  });
}
