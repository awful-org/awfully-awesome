<script lang="ts">
  import { onMount } from "svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { Message } from "$lib/transport/transport.svelte";
  import WafflePlayer from "./WafflePlayer.svelte";
  import { playlistIdFromUrl, videoIdFromUrl, type MusicState } from "./logic";
  import { tilePresence, registerPositionSource } from "./tile-presence.svelte";

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
  }
  let { card, cardState, host }: Props = $props();
  const music = $derived(cardState as MusicState);
  let queueOpen = $state(false);
  let url = $state("");
  let error = $state("");
  let player: WafflePlayer | null = null;
  let localPosition = $state(music.position);
  let duration = $state(0);
  let syncedJoinCount = 0;
  let titles = $state<Record<string, string>>({});
  let volume = $state(100);
  let pending = $state<string | null>(null);
  let playerLoading = $state(true);
  let selfDid = $state(host.selfDid());
  const mountedAt = Date.now();
  let departureSent = false;
  const current = $derived(
    music.currentIndex === null ? null : music.queue[music.currentIndex]
  );
  const joined = $derived(music.members.has(selfDid));
  const pendingPlaylist = $derived(music.playlistRequests[0] ?? null);
  const listeners = $derived(
    Array.from(music.members.entries()).map(([did, name]) =>
      did === music.ownerDid ? card.senderName : name
    )
  );

  async function send(data: unknown, label?: string) {
    if (label) pending = label;
    try {
      await host.sendUpdate(card.id, data);
    } finally {
      if (label && pending === label) pending = null;
    }
  }
  // While THIS card renders the player, it is the live position source for
  // playerless surfaces (the sidebar widget).
  $effect(() => {
    if (tilePresence.count > 0 || !joined) return;
    return registerPositionSource(() => player?.currentTime() ?? localPosition);
  });

  function departureAction(): { action: "close" | "leave" } | null {
    // The call tile is rendering the party: this card unmounting (scrolled
    // away, view switched) is NOT the user leaving. Closing here is what
    // froze the party the moment the owner joined a call.
    if (tilePresence.count > 0) return null;
    if (departureSent || music.closed || !joined) return null;
    departureSent = true;
    return { action: selfDid === music.ownerDid ? "close" : "leave" };
  }
  async function togglePlayback() {
    const position = player?.currentTime() ?? localPosition;
    await send(
      { action: music.playing ? "pause" : "play", position },
      music.playing ? "Pausing…" : "Starting…"
    );
  }
  async function ended() {
    if (music.currentIndex !== null)
      await send({ action: "ended", index: music.currentIndex });
  }
  async function join() {
    pending = "Joining party…";
    try {
      const cards = await host.cards();
      await Promise.all(
        cards
          .filter((item) => item.id !== card.id)
          .map((item) => host.sendUpdate(item.id, { action: "leave" }))
      );
      await host.sendUpdate(card.id, { action: "join" });
    } finally {
      pending = null;
    }
  }
  $effect(() => {
    const latest = music.activity.at(-1);
    if (
      // The tile is the renderer: it owns the join-sync too, and this
      // card's player is not even mounted to read a position from.
      tilePresence.count > 0 ||
      selfDid !== music.ownerDid ||
      latest?.action !== "joined" ||
      music.activity.length === syncedJoinCount ||
      music.currentIndex === null
    )
      return;
    syncedJoinCount = music.activity.length;
    void send({
      action: "sync",
      index: music.currentIndex,
      position: player?.currentTime() ?? localPosition,
      playing: music.playing,
    });
  });
  async function add() {
    const playlistId = playlistIdFromUrl(url.trim());
    if (playlistId) {
      error = "";
      url = "";
      await send({ action: "add-playlist", playlistId }, "Adding playlist…");
      return;
    }
    const videoId = videoIdFromUrl(url.trim());
    if (!videoId) {
      error = "Paste a supported YouTube video or playlist URL.";
      return;
    }
    error = "";
    url = "";
    await send({ action: "add", videoId }, "Adding track…");
  }
  const link = (id: string) => `https://www.youtube.com/watch?v=${id}`;
  async function resolveTitle(videoId: string) {
    if (titles[videoId]) return;
    titles[videoId] = "Loading title…";
    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(link(videoId))}&format=json`
      );
      const data = (await response.json()) as { title?: unknown };
      titles[videoId] =
        typeof data.title === "string" ? data.title : "YouTube video";
    } catch {
      titles[videoId] = "YouTube video";
    }
  }
  $effect(() => {
    for (const videoId of music.queue) void resolveTitle(videoId);
  });
  $effect(() => {
    current;
    playerLoading = true;
  });
  async function resolvePlaylist(videoIds: string[]) {
    if (!pendingPlaylist || selfDid !== music.ownerDid) return;
    const batches = Array.from(
      { length: Math.ceil(videoIds.length / 2) },
      (_, index) => videoIds.slice(index * 2, index * 2 + 2)
    );
    for (const [index, batch] of batches.entries()) {
      await send(
        {
          action: "resolve-playlist",
          playlistId: pendingPlaylist,
          videoIds: batch,
          done: index === batches.length - 1,
        },
        `Adding playlist tracks (${Math.min((index + 1) * 2, videoIds.length)}/${videoIds.length})…`
      );
    }
  }
  onMount(() => {
    const identityTimer = window.setInterval(() => {
      selfDid = host.selfDid();
    }, 250);
    const unsubscribe = host.onPeerDisconnect((peer) => {
      if (music.closed || !music.members.has(peer.did)) return;
      if (peer.did === music.ownerDid) void send({ action: "host-left" });
      else if (selfDid === music.ownerDid)
        void send({ action: "prune", did: peer.did });
    });
    const unsubscribeBeforeDisconnect = host.onBeforeDisconnect(() => {
      const action = departureAction();
      if (action) host.sendUpdateImmediately(card.id, action);
    });
    const pruneTimer = window.setInterval(() => {
      if (
        Date.now() - mountedAt < 15_000 ||
        music.closed ||
        selfDid !== music.ownerDid
      )
        return;
      const connected = new Set([
        selfDid,
        ...host.peers().map((peer) => peer.did),
      ]);
      for (const did of music.members.keys()) {
        if (did !== music.ownerDid && !connected.has(did))
          void send({ action: "prune", did });
      }
    }, 5_000);
    return () => {
      window.clearInterval(identityTimer);
      window.clearInterval(pruneTimer);
      unsubscribe();
      unsubscribeBeforeDisconnect();
      const action = departureAction();
      if (action) void send(action);
    };
  });
</script>

<div
  class="max-w-md space-y-3 rounded-lg border border-border bg-card p-3 text-card-foreground"
>
  <div class="flex items-center justify-between">
    <strong class="font-mono text-sm">Waffle Party</strong
    >{#if !music.closed}<span class="text-xs text-muted-foreground"
        >{music.members.size} listening</span
      >{/if}
  </div>
  {#if music.closed}<p class="py-8 text-center text-sm text-muted-foreground">
      The party is over.. heh..~
    </p>{:else if joined && (current || pendingPlaylist)}<div class="space-y-1">
      {#if tilePresence.count > 0}
        <!-- ONE renderer at a time: while the call tile plays the party,
             this card is just a pointer to it. No second player, no muted
             shadow instance, no split lifecycle. -->
        <p
          class="rounded bg-primary/10 px-2 py-2 text-center font-mono text-xs text-primary"
        >
          ▶ Rendering in the call
        </p>
      {:else}
      <WafflePlayer
        bind:this={player}
        videoId={current}
        playlistId={current ? null : pendingPlaylist}
        playing={current ? music.playing : false}
        position={music.position}
        {volume}
        onPosition={(value) => (localPosition = value)}
        onDuration={(value) => (duration = value)}
        onEnded={ended}
        onReady={() => (playerLoading = false)}
        onPlayable={() => (playerLoading = false)}
        onError={() => (playerLoading = false)}
        onPlaylist={selfDid === music.ownerDid ? resolvePlaylist : undefined}
      />{#if playerLoading}<p class="text-center text-xs text-muted-foreground">
          Loading player…
        </p>{/if}
      {/if}
    </div>{:else if !joined}<p
      class="py-5 text-center text-sm text-muted-foreground"
    >
      Join this party to listen together :3
    </p>{:else if joined && pendingPlaylist}<p
      class="text-sm text-muted-foreground"
    >
      Loading playlist…
    </p>{:else}<p class="text-sm text-muted-foreground">
      The queue is empty.
    </p>{/if}
  {#if pending}<p
      class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
      role="status"
    >
      {pending}
    </p>{/if}
  {#if pendingPlaylist && !pending}<p
      class="rounded bg-muted px-2 py-1 text-xs text-muted-foreground"
      role="status"
    >
      Reading playlist…
    </p>{/if}
  {#if !music.closed && joined}<div class="space-y-2">
      <!-- Playback control lives on whichever surface RENDERS: while the
           call tile plays, the card keeps only queue management. -->
      {#if tilePresence.count === 0}
      <input
        class="w-full"
        type="range"
        min="0"
        max={duration || 0}
        step="1"
        bind:value={localPosition}
        disabled={duration <= 0}
        onchange={() => send({ action: "seek", position: localPosition })}
        aria-label="Seek video"
      />
      {/if}
      <div class="flex flex-wrap gap-2 text-xs">
        {#if tilePresence.count === 0}
        <button
          class="rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-60"
          disabled={pending !== null}
          onclick={togglePlayback}>{music.playing ? "Pause" : "Play"}</button
        >
        <button
          class="rounded border border-border px-3 py-2 disabled:opacity-60"
          disabled={pending !== null}
          onclick={() =>
            send(
              { action: "seek", position: Math.max(0, localPosition - 10) },
              "Seeking…"
            )}>−10s</button
        >
        <button
          class="rounded border border-border px-3 py-2 disabled:opacity-60"
          disabled={pending !== null}
          onclick={() =>
            send({ action: "seek", position: localPosition + 10 }, "Seeking…")}
          >+10s</button
        >
        <button
          class="rounded border border-border px-3 py-2 disabled:opacity-60"
          disabled={pending !== null}
          onclick={() => send({ action: "skip" }, "Skipping…")}>Skip</button
        >
        {/if}
        <button
          class="rounded border border-border px-3 py-2"
          onclick={() => (queueOpen = !queueOpen)}
          >{queueOpen ? "Hide queue" : "Show queue"}</button
        >
        {#if selfDid === music.ownerDid}<button
            class="rounded border border-destructive px-3 py-2 text-destructive disabled:opacity-60"
            disabled={pending !== null}
            onclick={() => send({ action: "close" }, "Disbanding party…")}
            >Disband party</button
          >{/if}
        <select
          class="rounded border border-border bg-background px-2"
          value={music.loop}
          onchange={(event) =>
            send({
              action: "loop",
              mode: (event.currentTarget as HTMLSelectElement).value,
            })}
          ><option value="off">No loop</option><option value="track"
            >Loop video</option
          ><option value="queue">Loop queue</option></select
        >
        {#if tilePresence.count === 0}
        <label class="flex items-center gap-1"
          >Vol <input
            type="range"
            min="0"
            max="100"
            bind:value={volume}
          /></label
        >
        {/if}
      </div>
    </div>
    {#if queueOpen}
      <div class="space-y-2">
        <div class="flex gap-2">
          <input
            class="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
            disabled={pending !== null}
            bind:value={url}
            placeholder="YouTube video or playlist URL"
          /><button
            class="rounded border border-border px-2 text-xs disabled:opacity-60"
            disabled={pending !== null}
            onclick={add}>Add</button
          >
        </div>
        {#if error}<p class="text-xs text-destructive">{error}</p>{/if}
        <div
          class="queue-list max-h-52 space-y-1 overflow-y-scroll pr-1"
          style="max-height: 13rem; overflow-y: scroll; scrollbar-gutter: stable;"
        >
          {#each music.queue as videoId, index (index)}<div
              class="flex items-center justify-between gap-2 text-xs"
            >
              <button
                class="min-w-0 flex-1 truncate text-left text-primary underline disabled:opacity-60"
                disabled={pending !== null}
                onclick={() =>
                  send({ action: "select", index }, "Changing track…")}
                >#{index + 1} {titles[videoId] ?? "Loading title…"}</button
              ><button
                class="shrink-0 text-destructive disabled:opacity-60"
                disabled={pending !== null}
                onclick={() =>
                  send({ action: "remove", index }, "Removing track…")}
                >Remove</button
              >
            </div>{/each}
        </div>
      </div>
    {/if}{/if}{#if !music.closed && !joined}<button
      class="rounded bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-60"
      disabled={pending !== null}
      onclick={join}
      >{pending === "Joining party…" ? "Joining…" : "Join party"}</button
    >{:else if !music.closed && joined && selfDid !== music.ownerDid}<button
      class="rounded border border-border px-3 py-2 text-xs disabled:opacity-60"
      disabled={pending !== null}
      onclick={() => send({ action: "leave" }, "Leaving party…")}
      >Leave party</button
    >{/if}
  <div
    class="grid {music.closed
      ? 'grid-cols-1'
      : 'grid-cols-2'} gap-3 border-t border-border pt-2 text-xs text-muted-foreground"
  >
    <div>
      <div class="mb-1 font-medium text-card-foreground">Activity</div>
      {#each music.activity.slice(-4) as event, index (`${event.senderName}-${index}`)}<div
        >
          {event.senderName}
          {event.action}{#if event.videoId}&nbsp;<a
              class="text-primary underline"
              href={link(event.videoId)}
              target="_blank"
              rel="noreferrer">{titles[event.videoId] ?? "Loading title…"}</a
            >{/if}
        </div>{/each}
    </div>
    {#if !music.closed}<div>
        <div class="mb-1 font-medium text-card-foreground">Party members</div>
        {#each listeners as listener (listener)}<div class="truncate">
            {listener}
          </div>{/each}
      </div>{/if}
  </div>
</div>

<style>
  .queue-list {
    scrollbar-color: hsl(var(--muted-foreground) / 0.7) transparent;
    scrollbar-width: thin;
  }

  .queue-list::-webkit-scrollbar {
    width: 8px;
  }

  .queue-list::-webkit-scrollbar-thumb {
    background: hsl(var(--muted-foreground) / 0.7);
    border-radius: 999px;
  }
</style>
