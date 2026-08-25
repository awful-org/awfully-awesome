/**
 * Steam via the instance's generic /plugin-proxy: browsers cannot reach
 * Steam directly (no CORS), and the proxy substitutes {{secret:STEAM}}
 * server-side so the API key never ships to clients.
 *
 * Instance requirements (see the repo README):
 *   PLUGIN_PROXY_HOSTS=api.steampowered.com
 *   PLUGIN_PROXY_SECRETS=STEAM@api.steampowered.com=<your steam web api key>
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) || "https://awful.frav.in";

function proxied(upstream: string): string {
  return `${BASE}/plugin-proxy?url=${encodeURIComponent(upstream)}`;
}

export interface OwnedGame {
  appid: number;
  name: string;
}

const idRe = /^[0-9]{17}$/;
const vanityRe = /^[A-Za-z0-9_-]{2,64}$/;

/** A pasted profile can be an id64, a vanity name, or a full profile url. */
export function parseProfileInput(q: string): { steamId?: string; vanity?: string } {
  q = q.trim();
  // People paste urls without the scheme ("steamcommunity.com/id/gaben");
  // new URL() refuses those, and the bare-string fallbacks cannot match a
  // path either - so the most natural paste of all failed.
  if (!/^https?:\/\//i.test(q) && q.includes("/")) {
    q = "https://" + q;
  }
  try {
    const u = new URL(q);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] === "profiles" && idRe.test(parts[1] ?? "")) return { steamId: parts[1] };
    if (parts[0] === "id" && vanityRe.test(parts[1] ?? "")) return { vanity: parts[1] };
    return {};
  } catch {
    if (idRe.test(q)) return { steamId: q };
    if (vanityRe.test(q)) return { vanity: q };
    return {};
  }
}

async function proxyJson<T>(upstream: string): Promise<T> {
  const res = await fetch(proxied(upstream));
  if (res.status === 204) throw new Error("unconfigured");
  if (!res.ok) throw new Error("Steam lookup failed");
  return (await res.json()) as T;
}

export async function resolveSteamId(query: string): Promise<string> {
  const parsed = parseProfileInput(query);
  if (parsed.steamId) return parsed.steamId;
  if (!parsed.vanity) throw new Error("That does not look like a Steam profile");
  const data = await proxyJson<{ response?: { success?: number; steamid?: string } }>(
    "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key={{secret:STEAM}}&vanityurl=" +
      encodeURIComponent(parsed.vanity)
  );
  if (data.response?.success !== 1 || !data.response.steamid) {
    throw new Error("Profile not found");
  }
  return data.response.steamid;
}

export async function fetchOwnedGames(steamId: string): Promise<OwnedGame[]> {
  const data = await proxyJson<{ response?: { games?: OwnedGame[] } }>(
    "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?include_appinfo=1&include_played_free_games=1&key={{secret:STEAM}}&steamid=" +
      encodeURIComponent(steamId)
  );
  const games = data.response?.games ?? [];
  if (games.length === 0) {
    throw new Error("Library is empty or private - set game details to public on Steam");
  }
  return games;
}

/** ~350 appids per update keeps each chunk safely under the 4 KB payload cap. */
export function chunkAppids(games: OwnedGame[], size = 350): number[][] {
  const ids = games.map((g) => g.appid);
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
