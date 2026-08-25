<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { commonGames, isComplete, type RouletteState } from "./logic";
  import { chunkAppids, fetchIsMultiplayer, fetchOwnedGames, resolveSteamId } from "./steam-api";

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
  }

  let { card, cardState, host }: Props = $props();
  const state = $derived(cardState as RouletteState);

  let profileInput = $state("");
  let linking = $state(false);
  let spinningSend = $state(false);
  let error = $state<string | null>(null);
  /** appid -> name, from libraries fetched on THIS device. Every common game
   *  is in your own library by definition, so linking once names them all. */
  let names = $state<Record<string, string>>({});

  const NAMES_KEY = "steam-names";
  $effect(() => {
    void host.storage.get(NAMES_KEY).then((v) => {
      if (v && typeof v === "object") names = { ...(v as Record<string, string>), ...names };
    });
  });

  const common = $derived(commonGames(state));

  /** appid -> is-multiplayer, resolved lazily once a common set exists. */
  let mpFlags = $state<Record<string, boolean>>({});
  let mpChecked = $state(0);
  let mpBusy = $state(false);
  let multiplayerOnly = $state(true);

  const MP_KEY = "mp-flags";
  $effect(() => {
    void host.storage.get(MP_KEY).then((v) => {
      if (v && typeof v === "object")
        mpFlags = { ...(v as Record<string, boolean>), ...mpFlags };
    });
  });

  /** Plain let ON PURPOSE: the trickle effect reads mpBusy, which it also
   *  writes - so a failed fetch that reset mpBusy re-ran the effect
   *  IMMEDIATELY, retried the same appid, got 429 again, and hammered the
   *  proxy in a tight loop forever. One failure now parks the trickle for
   *  the rest of this mount; the next page load resumes where the
   *  persisted cache left off. */
  let mpStopped = false;

  // Resolve multiplayer flags for the common set, cached forever per app.
  // Paced UNDER the relay's /plugin-proxy limit of 10 req/min per IP - the
  // old 350ms (~170/min) guaranteed 429s from our own relay after ten apps.
  $effect(() => {
    const ids = common;
    if (mpStopped || !multiplayerOnly || ids.length === 0 || state.spun || mpBusy)
      return;
    const missing = ids.filter((id) => !(String(id) in mpFlags));
    if (missing.length === 0) return;
    mpBusy = true;
    void (async () => {
      for (const id of missing) {
        let flag: boolean;
        try {
          flag = await fetchIsMultiplayer(id);
        } catch {
          mpStopped = true; // unconfigured host or rate limited: park it
          break;
        }
        // Persist EVERY flag as it lands. The whole backlog takes minutes
        // at this pace, and saving only at the end meant any reload or
        // room switch threw the progress away - every visit refetched the
        // same games from scratch, forever.
        mpFlags = { ...mpFlags, [String(id)]: flag };
        void host.storage.set(MP_KEY, mpFlags);
        mpChecked += 1;
        await new Promise((r) => setTimeout(r, 7000));
      }
      mpBusy = false;
    })();
  });

  const mpKnown = $derived(common.filter((id) => String(id) in mpFlags));
  const mpPool = $derived(common.filter((id) => mpFlags[String(id)] === true));
  const pool = $derived(
    multiplayerOnly && mpPool.length > 0 ? mpPool : common
  );
  const linkedMembers = $derived(
    [...state.libraries.values()].map((lib) => ({
      name: lib.name,
      done: isComplete(lib),
      count: isComplete(lib)
        ? [...lib.parts.values()].reduce((n, p) => n + p.length, 0)
        : null,
    }))
  );
  const iLinked = $derived(state.libraries.has(host.selfDid()));

  // Slot-machine highlight easing onto the (already deterministic) winner.
  // Rolls over the pool the spin ACTUALLY drew from (state.pool, e.g. the
  // multiplayer-only subset), not the full common set.
  const rollPool = $derived(state.pool.length >= 2 ? state.pool : common);
  let rolling = $state(false);
  let rollIndex = $state(0);
  let sawUnspun = false;
  /** Plain let ON PURPOSE: the animation effect reads $state it also writes
   *  (rolling), so it re-runs when the roll ends - guarding the restart with
   *  reactive state re-triggered the roll forever, and only a refresh
   *  (fresh mount, sawUnspun false) ever showed the winner. */
  let animPlayed = false;
  const reducedMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  $effect(() => {
    if (!state.spun || state.winnerAppid === null) {
      sawUnspun = true;
      animPlayed = false;
      return;
    }
    if (animPlayed || !sawUnspun || reducedMotion || rollPool.length < 2) return;
    const target = rollPool.indexOf(state.winnerAppid);
    if (target === -1) return;
    animPlayed = true;
    rolling = true;
    // Fixed duration, NOT steps-per-game: two laps over a real common set
    // (hundreds of games) took minutes, which read as "the spin never
    // stops" and everyone refreshed to see the saved winner.
    const DURATION = 3000;
    const start = performance.now();
    const tick = () => {
      const t = (performance.now() - start) / DURATION;
      if (t >= 1) {
        rollIndex = target;
        rolling = false;
        return;
      }
      rollIndex = (rollIndex + 1) % rollPool.length;
      setTimeout(tick, 40 + t * 180);
    };
    tick();
  });

  async function link() {
    if (linking || !profileInput.trim()) return;
    linking = true;
    error = null;
    try {
      const steamId = await resolveSteamId(profileInput.trim());
      const games = await fetchOwnedGames(steamId);
      const nameMap: Record<string, string> = { ...names };
      for (const g of games) nameMap[String(g.appid)] = g.name;
      names = nameMap;
      void host.storage.set(NAMES_KEY, nameMap);
      const chunks = chunkAppids(games);
      for (let i = 0; i < chunks.length; i++) {
        await host.sendUpdate(card.id, {
          action: "library",
          steamId,
          part: i + 1,
          of: chunks.length,
          appids: chunks[i],
        });
      }
      profileInput = "";
    } catch (err) {
      error =
        err instanceof Error && err.message === "unconfigured"
          ? "This instance is not set up for Steam (needs PLUGIN_PROXY_HOSTS + PLUGIN_PROXY_SECRETS)"
          : err instanceof Error
            ? err.message
            : "Something went wrong";
    } finally {
      linking = false;
    }
  }

  async function spin() {
    if (spinningSend || state.spun || common.length === 0) return;
    spinningSend = true;
    try {
      await host.sendUpdate(card.id, { action: "spin", pool });
    } catch (err) {
      console.error("[steam-roulette] spin failed:", err);
    } finally {
      spinningSend = false;
    }
  }

  let respinSend = $state(false);
  async function respin() {
    if (respinSend || !state.spun) return;
    respinSend = true;
    try {
      await host.sendUpdate(card.id, { action: "respin" });
    } catch (err) {
      console.error("[steam-roulette] respin failed:", err);
    } finally {
      respinSend = false;
    }
  }

  function nameFor(appid: number): string {
    return names[String(appid)] ?? `App ${appid}`;
  }
</script>

<!-- w-full: the host frame sets the default card size. -->
<div class="flex w-full flex-col gap-3 font-mono">
  <div class="text-sm font-semibold">Steam roulette</div>

  {#if !state.spun}
    <div class="flex flex-col gap-1 text-xs text-muted-foreground">
      {#each linkedMembers as m (m.name)}
        <div>
          {m.name}:
          {#if m.done}{m.count} games{:else}linking...{/if}
        </div>
      {:else}
        <div>Nobody linked a library yet.</div>
      {/each}
    </div>

    {#if !iLinked}
      <a
        href="https://steamcommunity.com/my"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs text-primary hover:underline"
      >
        Open my Steam profile
      </a>
      <p class="-mt-2 text-[10px] text-muted-foreground">
        Copy the address it lands on and paste it below.
      </p>
      <div class="flex gap-1.5">
        <input
          bind:value={profileInput}
          placeholder="Steam profile url or name"
          onkeydown={(e) => {
            if (e.key === "Enter") link();
          }}
          class="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button size="sm" class="text-xs" onclick={link} disabled={linking}>
          {linking ? "Linking..." : "Link"}
        </Button>
      </div>
      {#if error}
        <p class="text-xs text-destructive">{error}</p>
      {/if}
    {/if}

    {#if common.length > 0}
      <div class="text-xs">
        <span class="text-primary font-semibold">{common.length}</span>
        games in common{#if mpKnown.length === common.length},
          <span class="text-primary font-semibold">{mpPool.length}</span>
          multiplayer{:else}
          <span class="text-muted-foreground">
            (checking multiplayer {mpKnown.length}/{common.length}...)</span
          >{/if}
      </div>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
        <input type="checkbox" bind:checked={multiplayerOnly} class="accent-current" />
        multiplayer only{#if multiplayerOnly && mpPool.length === 0 && mpKnown.length === common.length}
          <span class="text-destructive">(none found, spinning over all)</span>{/if}
      </label>
      <Button size="sm" onclick={spin} disabled={spinningSend}>
        {spinningSend ? "Spinning..." : `Spin (${pool.length} in the pot)`}
      </Button>
    {:else if linkedMembers.filter((m) => m.done).length >= 2}
      <div class="text-xs text-destructive">No games in common. Tragic.</div>
    {/if}
  {:else if state.winnerAppid !== null}
    {#if rolling}
      <div class="text-xs text-muted-foreground">
        {state.spinnerName} is spinning...
      </div>
      <div class="flex flex-col gap-0.5 text-xs">
        {#each rollPool.slice(Math.max(0, rollIndex - 2), rollIndex + 3) as appid (appid)}
          <div class={appid === rollPool[rollIndex] ? "text-primary font-bold" : "text-muted-foreground"}>
            {nameFor(appid)}
          </div>
        {/each}
      </div>
    {:else}
      <a
        href={`https://store.steampowered.com/app/${state.winnerAppid}`}
        target="_blank"
        rel="noopener noreferrer"
        class="block max-w-sm overflow-hidden rounded-md border border-border hover:border-primary/60 transition-colors"
      >
        <img
          src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${state.winnerAppid}/header.jpg`}
          alt={nameFor(state.winnerAppid)}
          class="w-full"
          loading="lazy"
        />
      </a>
      <a
        href={`https://store.steampowered.com/app/${state.winnerAppid}`}
        target="_blank"
        rel="noopener noreferrer"
        class="text-sm font-bold text-primary hover:underline"
      >
        {nameFor(state.winnerAppid)}
      </a>
      <div class="text-xs text-muted-foreground">
        Spun by {state.spinnerName} - {state.potSize} games were in the pot
      </div>
      <Button
        size="sm"
        variant="outline"
        class="text-xs"
        onclick={respin}
        disabled={respinSend}
      >
        {respinSend ? "Resetting..." : "Spin again"}
      </Button>
    {/if}
  {/if}
</div>
