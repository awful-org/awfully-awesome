import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import AnimeCard from "./AnimeCard.svelte";
import AnimeCallTile from "./AnimeCallTile.svelte";
import AnimeWidget from "./AnimeWidget.svelte";
import { NotConfiguredError, search, showIdFromUrl } from "./anidb";
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
        console.warn(
          "[anime-party] format: /anime search terms or anidb.app show URL"
        );
        return;
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

      // A pasted show URL skips search entirely. The title is the slug for
      // now; the card wave can resolve a nicer one.
      const showId = showIdFromUrl(typed);
      if (showId) {
        await host.sendCard({
          show: { id: showId, title: showId, image: null },
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
        if (err instanceof NotConfiguredError) {
          // Not a failure to retry: the instance did not allowlist
          // anidb.app, and the card is where a user can read that.
          await host.sendCard({
            query,
            results: [],
            notConfigured: true,
            ownerDid,
          });
          return;
        }
        console.warn("[anime-party] search failed", err);
        await host.sendCard({ query, results: [], ownerDid });
      }
    },
  },
});
