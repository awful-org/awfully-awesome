import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  airedEpisodes,
  embedUrl,
  episodeList,
  EPISODES_CAP,
  IMAGE_HOST_PREFIX,
  parseMediaShow,
  parseSearch,
  SEARCH_CAP,
  showIdFromUrl,
  validShowId,
} from "./anilist";

// Real AniList answers, captured with the queries anilist.ts sends. When
// search suddenly finds nothing, re-capture these and diff them first.
const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const media = (rows: unknown[]) => ({ data: { Page: { media: rows } } });

describe("parseSearch", () => {
  it("reads a real search answer, keyed by MyAnimeList id", () => {
    const shows = parseSearch(fixture("search.json"));
    expect(shows.length).toBeGreaterThan(3);
    expect(shows[0]).toEqual({
      id: 47917,
      title: "BOCCHI THE ROCK!",
      image: `${IMAGE_HOST_PREFIX}small/bx130003-HTDmeL4RGeJ4.png`,
    });
    for (const show of shows) expect(validShowId(show.id)).toBe(true);
  });

  it("falls back to the romaji title when there is no English one", () => {
    const shows = parseSearch(fixture("search.json"));
    expect(shows.find((s) => s.id === 58101)?.title).toBe("Hitoribocchi No UFO");
  });

  it("leaves out a real show that has no MyAnimeList id", () => {
    // "Recap Part 2" is on AniList with idMal null: nothing zokoanime plays.
    const titles = parseSearch(fixture("search.json")).map((s) => s.title);
    expect(titles).toContain("BOCCHI THE ROCK! Recap Part 1");
    expect(titles).not.toContain("BOCCHI THE ROCK! Recap Part 2");
  });

  it("drops shows zokoanime cannot play and rows that are not shows", () => {
    expect(
      parseSearch(
        media([
          // On AniList, not on MyAnimeList: no id the embed knows.
          { idMal: null, title: { romaji: "AniList only" } },
          { idMal: "21", title: { romaji: "String id" } },
          { idMal: 22, title: { romaji: "  ", english: null } },
          null,
          "nope",
          { idMal: 23, title: { romaji: "Kept" }, coverImage: null },
        ])
      )
    ).toEqual([{ id: 23, title: "Kept", image: null }]);
  });

  it("keeps only AniList's own cover CDN and nulls everything else", () => {
    const at = (src: unknown) =>
      parseSearch(media([{ idMal: 1, title: { romaji: "T" }, coverImage: { medium: src } }]))[0]
        .image;
    expect(at(`${IMAGE_HOST_PREFIX}small/x.jpg`)).toBe(`${IMAGE_HOST_PREFIX}small/x.jpg`);
    expect(at("https://beacon.example/x.jpg")).toBeNull();
    expect(at("https://s4.anilist.co.evil/file/anilistcdn/media/anime/cover/x.jpg")).toBeNull();
    expect(at("/relative.jpg")).toBeNull();
    expect(at(7)).toBeNull();
  });

  it("dedupes repeated ids and caps the list", () => {
    const rows = Array.from({ length: SEARCH_CAP + 5 }, (_, i) => ({
      idMal: i + 1,
      title: { romaji: `Show ${i}` },
    }));
    expect(parseSearch(media([rows[0], ...rows]))).toHaveLength(SEARCH_CAP);
    expect(parseSearch(media([rows[0], rows[0]]))).toHaveLength(1);
  });

  it("finds nothing in an error answer or a malformed one", () => {
    expect(parseSearch({ errors: [{ message: "x" }], data: null })).toEqual([]);
    expect(parseSearch(null)).toEqual([]);
    expect(parseSearch({ data: { Page: { media: "x" } } })).toEqual([]);
  });
});

describe("airedEpisodes", () => {
  it("counts a finished show by its episode total", () => {
    expect(airedEpisodes(fixture("media-finished.json"))).toBe(12);
  });

  it("counts an airing show up to the episode before the next one to air", () => {
    // One Piece: no total while it airs, episode 1181 next.
    expect(airedEpisodes(fixture("media-airing.json"))).toBe(1180);
  });

  it("prefers what has aired over a planned total", () => {
    expect(
      airedEpisodes({
        data: { Media: { episodes: 24, nextAiringEpisode: { episode: 5 } } },
      })
    ).toBe(4);
  });

  it("says zero for an unknown show, an unaired one, and nonsense", () => {
    expect(airedEpisodes({ data: { Media: null } })).toBe(0);
    expect(
      airedEpisodes({ data: { Media: { episodes: null, status: "NOT_YET_RELEASED" } } })
    ).toBe(0);
    expect(airedEpisodes({ data: { Media: { episodes: -3 } } })).toBe(0);
    expect(airedEpisodes({ data: { Media: { episodes: 2.5 } } })).toBe(0);
    expect(airedEpisodes(null)).toBe(0);
  });

  it("caps a runaway count at EPISODES_CAP", () => {
    expect(airedEpisodes({ data: { Media: { episodes: 10 ** 6 } } })).toBe(
      EPISODES_CAP
    );
  });
});

describe("episodeList", () => {
  it("numbers episodes from 1, in order", () => {
    expect(episodeList(3)).toEqual([{ number: 1 }, { number: 2 }, { number: 3 }]);
    expect(episodeList(0)).toEqual([]);
  });
});

describe("parseMediaShow", () => {
  it("reads the show a MyAnimeList id lookup names", () => {
    expect(parseMediaShow(fixture("media-airing.json"))).toEqual({
      id: 21,
      title: "ONE PIECE",
      image: `${IMAGE_HOST_PREFIX}small/bx21-ELSYx3yMPcKM.jpg`,
    });
    expect(parseMediaShow({ data: { Media: null } })).toBeNull();
  });
});

describe("embedUrl", () => {
  it("addresses the embed by MyAnimeList id, episode and track", () => {
    expect(embedUrl(52991, 3, "jpn")).toBe(
      "https://zokoanime.video/stream/mal/52991/3/sub?autoplay=0&resume=0&asi=0"
    );
    expect(embedUrl(52991, 3, "eng")).toBe(
      "https://zokoanime.video/stream/mal/52991/3/dub?autoplay=0&resume=0&asi=0"
    );
  });
});

describe("showIdFromUrl", () => {
  it("accepts a MyAnimeList show url with or without the trailing name", () => {
    expect(showIdFromUrl("https://myanimelist.net/anime/47917/Bocchi_the_Rock")).toBe(
      47917
    );
    expect(showIdFromUrl("  https://www.myanimelist.net/anime/21?x=1  ")).toBe(21);
  });

  it("accepts a scheme-less url copied from the address bar", () => {
    expect(showIdFromUrl("myanimelist.net/anime/52991/Sousou_no_Frieren")).toBe(52991);
  });

  it("rejects other hosts, other paths, and non-urls", () => {
    expect(showIdFromUrl("naruto")).toBeNull();
    expect(showIdFromUrl("bocchi the rock")).toBeNull();
    expect(showIdFromUrl("https://myanimelist.net.evil.example/anime/1")).toBeNull();
    expect(showIdFromUrl("https://anilist.co/anime/130003")).toBeNull();
    expect(showIdFromUrl("https://myanimelist.net/manga/2")).toBeNull();
    expect(showIdFromUrl("https://myanimelist.net/anime/")).toBeNull();
    expect(showIdFromUrl("https://myanimelist.net/anime/abc")).toBeNull();
    expect(showIdFromUrl("https://myanimelist.net/anime/0")).toBeNull();
  });
});

describe("validShowId", () => {
  it("takes positive 31-bit integers and nothing else", () => {
    expect(validShowId(1)).toBe(true);
    expect(validShowId(2 ** 31 - 1)).toBe(true);
    for (const bad of [0, -1, 1.5, 2 ** 31, "21", null, NaN])
      expect(validShowId(bad)).toBe(false);
  });
});
