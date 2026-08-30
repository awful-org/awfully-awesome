import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import MusicCard from "./MusicCard.svelte";
import WaffleCallTile from "./WaffleCallTile.svelte";
import WaffleWidget from "./WaffleWidget.svelte";
import {
  initialState,
  playlistIdFromUrl,
  reduce,
  videoIdFromUrl,
  type MusicState,
} from "./logic";

export default definePlugin({
  manifest,
  card: MusicCard,
  widget: WaffleWidget,
  // In a call the party is a stream tile, not a chat card: the plugin shows
  // up in the grid like a screen share, everyone renders YouTube locally,
  // and only queue/playback state syncs. PURE predicate: every client
  // shows/hides the tile on the same folded state.
  callTile: WaffleCallTile,
  // The pinned strip follows the newest party YOU are in, across rooms.
  // (Pins are one-per-plugin by construction; the old singletonWidget flag
  // is deprecated and gone.)
  widgetMine: (cardState: unknown, selfDid: string) => {
    const s = cardState as MusicState | undefined;
    return !!s && !s.closed && s.members.has(selfDid);
  },
  callTileActive: (cardState: unknown) => {
    const s = cardState as MusicState | undefined;
    return !!s && !s.closed && s.queue.length > 0;
  },
  // The host renders these in the transmissions-style audience chip.
  callTileViewers: (cardState: unknown) => {
    const s = cardState as MusicState | undefined;
    return s ? [...s.members.values()] : [];
  },
  initialState,
  reduce,
  commands: {
    play: async (args: string, host: HostApi) => {
      const playlistId = playlistIdFromUrl(args.trim());
      const videoId = playlistId ? null : videoIdFromUrl(args.trim());
      if (!videoId && !playlistId) {
        console.warn("[waffle-party] format: /play YouTube video or playlist URL");
        return;
      }
      const cards = await host.cards();
      await Promise.all(
        cards
          .filter((card) => card.senderDid === host.selfDid())
          .map((card) => host.sendUpdate(card.id, { action: "close" }))
      );
      await host.sendCard({ videoId, playlistId, ownerDid: host.selfDid() });
    },
  },
});
