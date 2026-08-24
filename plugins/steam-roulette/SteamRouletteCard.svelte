<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { commonGames, isComplete, type RouletteState } from "./logic";
  import { chunkAppids, fetchOwnedGames, resolveSteamId, type OwnedGame } from "./steam-api";

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
  let rolling = $state(false);
  let rollIndex = $state(0);
  let sawUnspun = false;
  const reducedMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  $effect(() => {
    if (!state.spun || state.winnerAppid === null) {
      sawUnspun = true;
      return;
    }
    if (!sawUnspun || reducedMotion || common.length < 2) return;
    const target = common.indexOf(state.winnerAppid);
    if (target === -1 || rolling) return;
    rolling = true;
    const total = common.length * 2 + target;
    let step = 0;
    const tick = () => {
      rollIndex = step % common.length;
      step += 1;
      if (step <= total) setTimeout(tick, 40 + (step / total) * 160);
      else rolling = false;
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
          ? "This instance has no STEAM_API_KEY configured"
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
      await host.sendUpdate(card.id, { action: "spin" });
    } catch (err) {
      console.error("[steam-roulette] spin failed:", err);
    } finally {
      spinningSend = false;
    }
  }

  function nameFor(appid: number): string {
    return names[String(appid)] ?? `App ${appid}`;
  }
</script>

<div class="flex max-w-sm flex-col gap-3 font-mono">
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
        games in common
      </div>
      <Button size="sm" onclick={spin} disabled={spinningSend}>
        {spinningSend ? "Spinning..." : "Spin the roulette"}
      </Button>
    {:else if linkedMembers.filter((m) => m.done).length >= 2}
      <div class="text-xs text-destructive">No games in common. Tragic.</div>
    {/if}
  {:else if state.winnerAppid !== null}
    {#if rolling}
      <div class="flex flex-col gap-0.5 text-xs">
        {#each common.slice(Math.max(0, rollIndex - 2), rollIndex + 3) as appid (appid)}
          <div class={appid === common[rollIndex] ? "text-primary font-bold" : "text-muted-foreground"}>
            {nameFor(appid)}
          </div>
        {/each}
      </div>
    {:else}
      <a
        href={`https://store.steampowered.com/app/${state.winnerAppid}`}
        target="_blank"
        rel="noopener noreferrer"
        class="block overflow-hidden rounded-md border border-border hover:border-primary/60 transition-colors"
      >
        <img
          src={`https://cdn.cloudflare.steamstatic.com/steam/apps/${state.winnerAppid}/header.jpg`}
          alt={nameFor(state.winnerAppid)}
          class="w-full"
          loading="lazy"
        />
      </a>
      <div class="text-sm font-bold text-primary">{nameFor(state.winnerAppid)}</div>
      <div class="text-xs text-muted-foreground">
        Spun by {state.spinnerName} - {common.length} games were in the pot
      </div>
    {/if}
  {/if}
</div>
