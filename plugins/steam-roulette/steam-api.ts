/**
 * Client for the relay's /steam proxy (browsers cannot reach Steam directly,
 * no CORS). The instance needs STEAM_API_KEY set on the relay; without it
 * the proxy answers 204 and this module reports that as `unconfigured`.
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) || "https://awful.frav.in";

export interface OwnedGame {
  appid: number;
  name: string;
}

export async function resolveSteamId(query: string): Promise<string> {
  const res = await fetch(`${BASE}/steam/resolve?q=${encodeURIComponent(query)}`);
  if (res.status === 204) throw new Error("unconfigured");
  if (res.status === 404) throw new Error("Profile not found");
  if (!res.ok) throw new Error("Steam lookup failed");
  const data = (await res.json()) as { steamId?: string };
  if (!data.steamId) throw new Error("Steam lookup failed");
  return data.steamId;
}

export async function fetchOwnedGames(steamId: string): Promise<OwnedGame[]> {
  const res = await fetch(`${BASE}/steam/games?steamid=${encodeURIComponent(steamId)}`);
  if (res.status === 204) throw new Error("unconfigured");
  if (!res.ok) throw new Error("Steam library fetch failed");
  const data = (await res.json()) as { games?: OwnedGame[]; private?: boolean };
  if (data.private || !data.games?.length) {
    throw new Error("Library is empty or private - set game details to public on Steam");
  }
  return data.games;
}

/** ~350 appids per update keeps each chunk safely under the 4 KB payload cap. */
export function chunkAppids(games: OwnedGame[], size = 350): number[][] {
  const ids = games.map((g) => g.appid);
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
