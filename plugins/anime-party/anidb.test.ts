import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  numericShowId,
  parseEmbed,
  parseEpisodes,
  parseLanguages,
  parseSearch,
  showIdFromUrl,
  validShowId,
  EPISODES_CAP,
  IMAGE_HOST_PREFIX,
  SEARCH_CAP,
} from "./anidb";

/**
 * The fixtures are real captures from 2026-09-02, trimmed but never
 * rewritten. Search and the embed page are scraped HTML - the same exposure
 * ani-cli has - so the parsers are pinned to markup that actually shipped
 * rather than to markup this test invented.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const browse = fixture("browse.html");
const embed = fixture("embed.html");
const eps = JSON.parse(fixture("eps.json"));
const lang = JSON.parse(fixture("lang.json"));

describe("parseSearch", () => {
  it("reads the anime cards of a real browse page", () => {
    const shows = parseSearch(browse);
    expect(shows).toHaveLength(2);
    expect(shows[0]).toEqual({
      id: "bocchi-the-rock-729",
      title: "Bocchi the Rock!",
      image: "https://cdn.xlsbox.com/poster/small/1782735600/729.jpg",
    });
    expect(shows[1].id).toBe("hitoribocchi-no-marumaru-seikatsu-2248");
    expect(shows[1].title).toBe("Hitoribocchi no Marumaru Seikatsu");
  });

  it("unescapes the entities a title attribute carries", () => {
    const shows = parseSearch(
      `<a href="https://anidb.app/anime/kaguya-sama-1" class="anime-card block group" title="Kaguya&#039;s &quot;war&quot; &amp; love"><img src="https://x/a.jpg"></a>`
    );
    expect(shows[0].title).toBe(`Kaguya's "war" & love`);
  });

  it("keeps only the provider's poster CDN and nulls everything else", () => {
    const card = (id: string, src: string) =>
      `<a href="https://anidb.app/anime/${id}" class="anime-card block group" title="T"><img src="${src}" alt="T"></a>`;
    const shows = parseSearch(
      card("a-1", "/img/placeholder.svg") +
        card("b-2", "http://insecure.example/a.jpg") +
        // https is not enough. An image url is a beacon every member's
        // browser fetches, so any host but the poster CDN is dropped - and
        // a lookalike that only starts the same way is another host.
        card("c-3", "https://cdn.example/a.jpg") +
        card("d-4", "https://cdn.xlsbox.com.evil.example/a.jpg") +
        card("e-5", `${IMAGE_HOST_PREFIX}poster/small/1/1.jpg`)
    );
    expect(shows.map((s) => s.image)).toEqual([
      null,
      null,
      null,
      null,
      `${IMAGE_HOST_PREFIX}poster/small/1/1.jpg`,
    ]);
  });

  it("dedupes repeated ids and caps the list", () => {
    const card = (id: string) =>
      `<a href="https://anidb.app/anime/${id}" class="anime-card block group" title="T"><img src="https://x/a.jpg"></a>`;
    const dupes = parseSearch(card("show-1").repeat(4));
    expect(dupes).toHaveLength(1);

    const many = parseSearch(
      Array.from({ length: SEARCH_CAP + 5 }, (_, i) => card(`show-${i}`)).join("")
    );
    expect(many).toHaveLength(SEARCH_CAP);
    expect(many.at(-1)!.id).toBe(`show-${SEARCH_CAP - 1}`);
  });

  it("finds nothing in a page with no cards", () => {
    expect(parseSearch("<html><body>no results</body></html>")).toEqual([]);
    expect(parseSearch("")).toEqual([]);
  });
});

describe("parseEmbed", () => {
  it("reads the master playlist out of a real embed page", () => {
    expect(parseEmbed(embed)).toBe(
      "https://hls.anidb.app/stream/FPIdYkXg99QOUwOxEwP0qSyEqC0BuQ9kR6wBxTcy7YD4KrHRh3YT3HQnnhFjzyxZ/master.m3u8"
    );
  });

  it("refuses a file: url pointing anywhere but hls.anidb.app", () => {
    expect(parseEmbed("file: 'https://evil.example/master.m3u8'")).toBeNull();
    expect(
      parseEmbed("file: 'http://hls.anidb.app/stream/x/master.m3u8'")
    ).toBeNull();
    expect(
      parseEmbed("file: 'https://hls.anidb.app.evil.example/x.m3u8'")
    ).toBeNull();
  });

  it("returns null when the page names no file at all", () => {
    expect(parseEmbed("<html><body>gone</body></html>")).toBeNull();
  });
});

describe("parseEpisodes", () => {
  it("reads a real episode list in order", () => {
    const list = parseEpisodes(eps);
    expect(list).toHaveLength(12);
    expect(list[0]).toEqual({ id: 43600, number: 1 });
    expect(list.at(-1)).toEqual({ id: 43611, number: 12 });
    expect(list.map((e) => e.number)).toEqual(
      [...list.map((e) => e.number)].sort((a, b) => a - b)
    );
  });

  it("sorts by episode number rather than trusting arrival order", () => {
    expect(
      parseEpisodes({
        episodes: [
          { id: 3, number: 2 },
          { id: 1, number: 0 },
          { id: 2, number: 1 },
        ],
      }).map((e) => e.id)
    ).toEqual([1, 2, 3]);
  });

  it("drops malformed rows and whole malformed payloads", () => {
    expect(
      parseEpisodes({
        episodes: [
          { id: 1, number: 1 },
          { id: 0, number: 2 },
          { id: -5, number: 3 },
          { id: 2 ** 31, number: 4 },
          { id: 1.5, number: 5 },
          { id: "7", number: 6 },
          { id: 8, number: -1 },
          { id: 9, number: 1.5 },
          { id: 10 },
          null,
          "nope",
          { id: 1, number: 99 }, // duplicate id
        ],
      })
    ).toEqual([{ id: 1, number: 1 }]);

    for (const bad of [null, undefined, {}, { episodes: null }, [], "x", 7]) {
      expect(parseEpisodes(bad)).toEqual([]);
    }
  });

  it("caps a long list at EPISODES_CAP, keeping the lowest numbers", () => {
    // Reversed on the way in, so a cap applied before the sort would keep
    // the tail of the show instead of its start.
    const episodes = Array.from({ length: EPISODES_CAP + 500 }, (_, i) => ({
      id: EPISODES_CAP + 500 - i,
      number: EPISODES_CAP + 500 - i,
    }));
    const list = parseEpisodes({ episodes });
    expect(list).toHaveLength(EPISODES_CAP);
    expect(list[0].number).toBe(1);
    expect(list.at(-1)?.number).toBe(EPISODES_CAP);
  });
});

describe("parseLanguages", () => {
  it("reads a real language list", () => {
    expect(parseLanguages(lang)).toEqual([
      {
        code: "jpn",
        embedUrl:
          "https://anidb.app/embed/Zo76z9HvqrjvR3O00x6B2B_1VGxs9B5gse1JmG76lSfUDzFWk3UU3mD0UsIDDG9G",
      },
    ]);
  });

  it("keeps both codes when an episode is subbed and dubbed", () => {
    expect(
      parseLanguages({
        languages: [
          { code: "jpn", name: "Japanese", embed_url: "https://anidb.app/embed/a" },
          { code: "eng", name: "English", embed_url: "https://anidb.app/embed/b" },
        ],
      }).map((l) => l.code)
    ).toEqual(["jpn", "eng"]);
  });

  it("drops unknown codes, foreign embed hosts, and malformed payloads", () => {
    expect(
      parseLanguages({
        languages: [
          { code: "spa", embed_url: "https://anidb.app/embed/a" },
          { code: "jpn", embed_url: "https://evil.example/embed/a" },
          { code: "eng", embed_url: "http://anidb.app/embed/a" },
          { code: "jpn" },
          null,
          { code: "eng", embed_url: "https://anidb.app/embed/ok" },
          { code: "eng", embed_url: "https://anidb.app/embed/dupe" },
        ],
      })
    ).toEqual([{ code: "eng", embedUrl: "https://anidb.app/embed/ok" }]);

    for (const bad of [null, undefined, {}, { languages: 3 }, "x"]) {
      expect(parseLanguages(bad)).toEqual([]);
    }
  });
});

describe("showIdFromUrl", () => {
  it("accepts an anidb show url with or without a trailing path", () => {
    expect(showIdFromUrl("https://anidb.app/anime/bocchi-the-rock-729")).toBe(
      "bocchi-the-rock-729"
    );
    expect(
      showIdFromUrl("https://www.anidb.app/anime/bocchi-the-rock-729/episodes")
    ).toBe("bocchi-the-rock-729");
    expect(showIdFromUrl("  https://anidb.app/anime/re-zero-2?x=1  ")).toBe(
      "re-zero-2"
    );
  });

  it("accepts a scheme-less url copied from the address bar", () => {
    expect(showIdFromUrl("anidb.app/anime/bocchi-the-rock-729")).toBe(
      "bocchi-the-rock-729"
    );
    expect(showIdFromUrl("www.anidb.app/anime/re-zero-2/episodes")).toBe(
      "re-zero-2"
    );
  });

  it("rejects other hosts, other paths, and non-urls", () => {
    expect(showIdFromUrl("https://example.com/anime/bocchi-the-rock-729")).toBeNull();
    expect(showIdFromUrl("https://anidb.app.evil.example/anime/x-1")).toBeNull();
    expect(showIdFromUrl("https://anidb.app/browse?q=bocchi")).toBeNull();
    expect(showIdFromUrl("https://anidb.app/anime/")).toBeNull();
    expect(showIdFromUrl("https://anidb.app/anime/NoDigits")).toBeNull();
    expect(showIdFromUrl("bocchi the rock")).toBeNull();
    // A bare word becomes host "naruto" once a scheme is added, not anidb.app.
    expect(showIdFromUrl("naruto")).toBeNull();
    expect(showIdFromUrl("anidb.app/browse?q=x")).toBeNull();
    expect(showIdFromUrl("")).toBeNull();
  });
});

describe("validShowId", () => {
  it("takes lowercase slugs ending in digits and nothing else", () => {
    expect(validShowId("bocchi-the-rock-729")).toBe(true);
    expect(validShowId("re-zero-2")).toBe(true);
    expect(validShowId("Bocchi-729")).toBe(false);
    expect(validShowId("bocchi")).toBe(false);
    expect(validShowId("../../etc-1")).toBe(false);
    expect(validShowId("a-" + "1".repeat(200))).toBe(false);
    expect(validShowId(729)).toBe(false);
    expect(validShowId(null)).toBe(false);
  });
});

describe("numericShowId", () => {
  it("takes the tail after the LAST dash, not the first digits", () => {
    expect(numericShowId("bocchi-the-rock-729")).toBe("729");
    expect(numericShowId("re-zero-2")).toBe("2");
    expect(numericShowId("hitoribocchi-no-marumaru-seikatsu-2248")).toBe("2248");
  });
});
