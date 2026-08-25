# YouTube Music MVP Tasks

**Design**: `.specs/features/youtube-music-mvp/design.md`
**Status**: In Progress

## Test Coverage Matrix

> Generated from the awful.chat Vitest configuration and existing external-plugin tests. Guidelines found: `README.md`, `plugins/steam-roulette/*.test.ts`, and `../awful.chat/frontend/vitest.config.ts`.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Plugin reducer and URL parser | unit | Every P1 state transition, rejected payload, and listed state edge case | `plugins/youtube-music/logic.test.ts` | `pnpm test -- plugins/youtube-music/logic.test.ts` |
| Plugin manifest and command wiring | none | Typecheck and manual slash-command verification | `plugins/youtube-music/index.ts` | `pnpm check` |
| Svelte player and card components | none | Typecheck plus two-browser UAT for each P1 UI flow | `plugins/youtube-music/*.svelte` | `pnpm check` |
| Operator documentation | none | README names commands, requirements, and limitations | `plugins/youtube-music/README.md` | `pnpm check` |

## Gate Check Commands

> Generated from `../awful.chat/frontend/package.json` and its Vitest configuration. Run from `../awful.chat/frontend` after fetching this external plugin with `PLUGIN_SOURCES=../../awfully-awesome node scripts/fetch-plugins.mjs`.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Targeted | Reducer test and discrimination sensor | `pnpm test -- plugins/youtube-music/logic.test.ts` |
| Quick | Reducer task | `pnpm test -- plugins/youtube-music/logic.test.ts` |
| Full | User-facing behavior task | `pnpm test && pnpm check` |
| Build | Final task and feature validation | `pnpm test && pnpm check && pnpm build` |

## Execution Plan

### Phase 1: Shared state

```
T1
```

### Phase 2: Plugin delivery

```
T2 → T3
T4
```

### Phase 3: Card integration

```
T3 → T5 ← T4
```

### Phase 4: Operator handoff

```
T6
```

## Task Breakdown

### T1: Add deterministic music state

**Status**: Done

**What**: Create the URL parser and pure queue, playback, and activity-log reducer with specification-derived unit tests.
**Where**: `plugins/youtube-music/logic.ts`
**Depends on**: None
**Reuses**: `plugins/steam-roulette/logic.ts`
**Requirement**: YM-01, YM-04, YM-05, YM-06, YM-07, YM-08, YM-09

**Done when**:

- [x] Supported URL forms create a video ID and unsupported inputs return no ID.
- [x] Valid action updates produce the exact queue, playback state, and verified-sender activity entry in the specification.
- [x] Invalid values and removal of the final entry leave valid, replayable state.
- [x] The targeted test gate passes with at least 12 new assertions.

**Tests**: unit
**Gate**: quick
**Commit**: `feat(youtube-music): add shared music reducer`

### T2: Add plugin metadata

**What**: Add the eagerly loaded manifest for the external plugin.
**Where**: `plugins/youtube-music/manifest.ts`
**Depends on**: T1
**Reuses**: `plugins/steam-roulette/manifest.ts`
**Requirement**: YM-01

**Done when**:

- [ ] The manifest ID matches `youtube-music` and advertises `/play`.
- [ ] The manifest uses API version 1 and has no heavy imports.
- [ ] The full gate passes.

**Tests**: none
**Gate**: full
**Commit**: `feat(youtube-music): add plugin manifest`

### T3: Register the play command

**What**: Register the card, reducer, and `/play` command that validates a URL before posting an initial queue card.
**Where**: `plugins/youtube-music/index.ts`
**Depends on**: T2
**Reuses**: `plugins/steam-roulette/index.ts`
**Requirement**: YM-01, YM-02

**Done when**:

- [ ] A valid `/play` command sends one card with one video ID.
- [ ] An invalid command sends no card and reports a local format error.
- [ ] The full gate passes.

**Tests**: none
**Gate**: full
**Commit**: `feat(youtube-music): register play command`

### T4: Add the visible YouTube player

**What**: Create a visible, locally controlled official IFrame Player API component.
**Where**: `plugins/youtube-music/YoutubePlayer.svelte`
**Depends on**: T3
**Reuses**: Svelte 5 component conventions in `plugins/steam-roulette/SteamRouletteCard.svelte`
**Requirement**: YM-02, YM-03, YM-08, YM-09

**Done when**:

- [ ] The component reserves a visible player viewport of at least 200 by 200 pixels.
- [ ] State changes load or seek the selected video and apply intended playback locally.
- [ ] API and autoplay failures render local feedback without changing shared state.
- [ ] The full gate passes.

**Tests**: none
**Gate**: full
**Commit**: `feat(youtube-music): add embedded player`

### T5: Add room DJ controls

**What**: Create the themed music card with collapsible queue, room-wide controls, and the shared activity log.
**Where**: `plugins/youtube-music/MusicCard.svelte`
**Depends on**: T4
**Reuses**: `plugins/steam-roulette/SteamRouletteCard.svelte`
**Requirement**: YM-04, YM-05, YM-06, YM-07, YM-10

**Done when**:

- [ ] Any room participant can add, remove, skip, play, pause, and seek using persisted updates.
- [ ] Queue details collapse without hiding the player or primary playback controls.
- [ ] The card renders chronological sender-attributed activity with semantic theme tokens.
- [ ] The full gate passes and the two-browser UAT is documented as pending manual execution.

**Tests**: none
**Gate**: full
**Commit**: `feat(youtube-music): add room dj controls`

### T6: Document installation and behavior

**What**: Add the required plugin README describing commands, keyless setup, visible-player rule, and known limits.
**Where**: `plugins/youtube-music/README.md`
**Depends on**: T5
**Reuses**: `plugins/steam-roulette/README.md`
**Requirement**: YM-01, YM-10

**Done when**:

- [ ] The README documents installation through `PLUGIN_SOURCES`, `/play`, card controls, and no instance requirements.
- [ ] The README explicitly excludes extracted audio, voice-call injection, and frame-accurate synchronization.
- [ ] The build gate passes.

**Tests**: none
**Gate**: build
**Commit**: `docs(youtube-music): document plugin usage`

## Phase Execution Map

```
Phase 1: T1 → T2 → T3 → T4 → T5 → T6
```

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 | One reducer module with its co-located unit test | ✅ Granular |
| T2 | One manifest | ✅ Granular |
| T3 | One plugin definition | ✅ Granular |
| T4 | One Svelte component | ✅ Granular |
| T5 | One Svelte component | ✅ Granular |
| T6 | One README | ✅ Granular |

## Diagram-Definition Cross-Check

| Task | Depends On | Diagram Shows | Status |
| --- | --- | --- | --- |
| T1 | None | None | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T2 | T2 → T3 | ✅ Match |
| T4 | T3 | T3 → T4 | ✅ Match |
| T5 | T4 | T4 → T5 | ✅ Match |
| T6 | T5 | T5 → T6 | ✅ Match |

## Test Co-location Validation

| Task | Code Layer | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Reducer/parser | unit | unit | ✅ OK |
| T2 | Manifest | none | none | ✅ OK |
| T3 | Plugin definition | none | none | ✅ OK |
| T4 | Svelte player | none | none | ✅ OK |
| T5 | Svelte card | none | none | ✅ OK |
| T6 | Documentation | none | none | ✅ OK |
