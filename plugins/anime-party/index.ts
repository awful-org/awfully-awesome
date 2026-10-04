import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import AnimeCard from "./AnimeCard.svelte";
import AnimeCallTile from "./AnimeCallTile.svelte";
import AnimeWidget from "./AnimeWidget.svelte";
import { search, showById, showIdFromUrl } from "./anilist";
import { initialState, QUERY_CAP, reduce, type AnimeState } from "./logic";

export default definePlugin({
  manifest,
  card: AnimeCard,
  widget: AnimeWidget,
  callTile: AnimeCallTile,
  // The pinned strip follows the newest party YOU are in, across rooms.
  widgetMine: (cardState: unknown, selfDid: string) => {
    const s = cardState as AnimeState | undefined;
    return !!s && !s.closed && s.members.has(selfDid);
  },
  // In a call the party is a stream tile, not a chat card: everyone renders
  // the video locally and only queue/playback state syncs. PURE predicate:
  // every client shows/hides the tile on the same folded state.
  callTileActive: (cardState: unknown) => {
    const s = cardState as AnimeState | undefined;
    return !!s && !s.closed && s.queue.length > 0;
  },
  // The host renders these in the transmissions-style audience chip.
  callTileViewers: (cardState: unknown) => {
    const s = cardState as AnimeState | undefined;
    return s ? [...s.members.values()] : [];
  },
  initialState,
  reduce,
  commands: {
    anime: async (args: string, host: HostApi) => {
      const typed = args.trim();
      if (!typed) {
        // Thrown, so the host says it to the person who typed it.
        throw new Error("Search for a show, or paste its MyAnimeList link: /anime frieren");
      }
      const ownerDid = host.selfDid();
      // One party per person per room: starting a new one disbands the
      // sender's own previous cards rather than leaving members split
      // between two parties that each think they are the one.
      const cards = await host.cards();
      await Promise.all(
        cards
          .filter((card) => card.senderDid === ownerDid)
          .map((card) => host.sendUpdate(card.id, { action: "close" }))
      );

      // A pasted show URL skips search entirely. The url carries only the
      // id, so the title and cover come from one AniList lookup; if that
      // fails the party still starts, named by the id rather than not at all.
      const showId = showIdFromUrl(typed);
      if (showId) {
        const show = await showById(showId).catch(() => null);
        await host.sendCard({
          show: show ?? {
            id: showId,
            title: `MyAnimeList #${showId}`,
            image: null,
          },
          ownerDid,
        });
        return;
      }

      // initialState drops a query over the cap, and a card whose query did
      // not survive is a card that cannot say what was searched for. Cut it
      // to the length the reducer accepts. A pasted url is resolved above,
      // in full, before this ever runs.
      const query = typed.slice(0, QUERY_CAP);

      try {
        const results = await search(query);
        await host.sendCard({ query, results, ownerDid });
      } catch (err) {
        // The card still goes out, with no results: its own search box is
        // where the party retries.
        console.warn("[anime-party] search failed", err);
        await host.sendCard({ query, results: [], ownerDid });
        // The card shows no results either way; only the searcher needs to
        // know these are missing because the search broke, not because
        // nothing matched. Hosts before the error note do without.
        if (typeof host.showError === "function") {
          host.showError("The AniList search failed, so the party has no results yet. Try again in a moment, or paste the show's MyAnimeList link.");
        }
      }
    },
  },
});
