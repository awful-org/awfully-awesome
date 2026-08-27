# Waffle Party Resilience and Controls Tasks

**Design**: `.specs/features/waffle-party-resilience-and-controls/design.md`
**Status**: Done

## Test Coverage Matrix

> Generated from the plugin README, fetched-plugin pipeline, frontend Vitest configuration, and spec. Guidelines found: `README.md`, `plugins/waffle-party/README.md`, `awful.chat/frontend/vitest.config.ts`, `awful.chat/frontend/package.json`.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
| --- | --- | --- | --- | --- |
| Plugin domain helpers/reducer | unit | Every branch and all WAF-04–WAF-07, WAF-13–WAF-17, WAF-18–WAF-20, WAF-21–WAF-27 outcomes | `frontend/plugins/waffle-party/*.test.ts` | app: `pnpm test -- plugins/waffle-party/<file>.test.ts` |
| Plugin Svelte UI | typecheck + manual UAT | Each card/tile interaction and iframe shield outcome | `frontend/plugins/waffle-party/*.svelte` | app: `pnpm check` |
| Host transport helper | unit | Named teardown sender and fallback branches | `frontend/src/lib/**/*.test.ts` | app: `pnpm test -- src/lib/<file>.test.ts` |
| Call stream UI | typecheck + manual UAT | Watched/pending states and stop-watch action | `frontend/src/lib/components/VoiceVideoCallView.svelte` | app: `pnpm check` |

## Gate Check Commands

> Run from `awful.chat/frontend`. Before each plugin task gate, refresh only the generated untracked `plugins/waffle-party/` test mirror from the matching source files in `awfully-awesome`; never stage that mirror in the app repository.

| Gate Level | When to Use | Command |
| --- | --- | --- |
| Targeted | One unit test file or discrimination mutation | `pnpm test -- <test-file>` |
| Quick | Plugin/helper task | `pnpm test -- plugins/waffle-party/logic.test.ts plugins/waffle-party/audio-prefs.test.ts plugins/waffle-party/host-departure.test.ts` |
| Full | App integration task | `pnpm test && pnpm check` |
| Build | Phase completion | `pnpm test && pnpm check && pnpm build` |

---

## Execution Plan

### Phase 1: Shared behavior foundation

```
T1 → T2 → T3
```

### Phase 2: Waffle Party player surfaces

```
T3 → T4 → T5 → T6 → T7
```

### Phase 3: Host application integration

```
T8 → T9 → T10
```

---

## Task Breakdown

### T1: Add validated audio preference helper

**Status**: Done

**What**: Create local volume read/write helpers using `audio_prefs`, including malformed and unavailable storage handling.
**Where**: `plugins/waffle-party/audio-prefs.ts`
**Depends on**: None
**Reuses**: `HostApi.storage` namespacing in `awful.chat/frontend/src/lib/plugins/host.ts`
**Requirement**: WAF-04, WAF-05, WAF-06, WAF-07

**Done when**:

- [ ] Valid 0–100 integer values are restored and saved as `audio_prefs`.
- [ ] Missing, malformed, out-of-range, and failed storage use volume 100 without throwing.
- [ ] Unit tests cover every validation branch.

**Tests**: unit in `audio-prefs.test.ts`
**Gate**: targeted, then quick
**Commit**: `feat(waffle-party): persist local audio preferences`

### T2: Add cancellable host-departure grace helper

**Status**: Done

**What**: Create a single-timer helper that closes after five seconds only if the host DID stays absent, and cancels on reappearance.
**Where**: `plugins/waffle-party/host-departure.ts`
**Depends on**: T1
**Reuses**: `HostApi.peers()` and the reducer's closed-state guard
**Requirement**: WAF-21, WAF-22, WAF-23, WAF-24, WAF-25, WAF-26, WAF-27

**Done when**:

- [ ] A host loss starts no more than one 5,000 ms timer.
- [ ] A peer snapshot containing the host cancels the timer.
- [ ] Sustained absence invokes one closure callback; disposal clears timers.
- [ ] Fake-timer tests prove all timing and duplicate-observation cases.

**Tests**: unit in `host-departure.test.ts`
**Gate**: targeted, then quick
**Commit**: `feat(waffle-party): tolerate transient host disconnects`

### T3: Extend shared party state for autoplay and responder sync

**Status**: Done

**What**: Seed newly created playable parties as playing, preserve autoplay across selected/advanced tracks, and authorize the calculated sync responder rather than only the host.
**Where**: `plugins/waffle-party/logic.ts`
**Depends on**: T2
**Reuses**: `initialState`, `reduce`, and `syncResponder`
**Requirement**: WAF-15, WAF-16, WAF-17, WAF-18, WAF-19, WAF-20

**Done when**:

- [ ] Initial video/first resolved playlist entry starts with `playing: true` at position 0.
- [ ] Select, skip, and ended transitions preserve or stop playback exactly as specified.
- [ ] Host and deterministic fallback responder may send valid sync; any other sender cannot.
- [ ] Reducer tests cover host-present and host-absent join synchronization.

**Tests**: unit in `logic.test.ts`
**Gate**: targeted, then quick
**Commit**: `feat(waffle-party): synchronize autoplay and join position`

### T4: Shield the embedded player and request autoplay

**Status**: Done

**What**: Add the inert iframe pointer shield and verify player synchronization requests playback after loading a selected video at its supplied position.
**Where**: `plugins/waffle-party/WafflePlayer.svelte`
**Depends on**: T3
**Reuses**: existing IFrame API `loadVideoById`, `playVideo`, and `controls` mode
**Requirement**: WAF-01, WAF-02, WAF-16, WAF-17, WAF-19

**Done when**:

- [ ] The iframe is covered by a transparent pointer-intercepting element with no click handler.
- [ ] Waffle Party controls render above the shield in consuming surfaces.
- [ ] New video IDs load at synchronized position before playback is requested.
- [ ] `pnpm check` passes and manual UAT confirms iframe buttons cannot be used.

**Tests**: typecheck + manual UAT
**Gate**: build
**Commit**: `feat(waffle-party): shield embedded player controls`

### T5: Upgrade card preferences, recreation, and lifecycle behavior

**Status**: Done

**What**: Wire audio preferences, icon controls, latest closed non-empty recreation, join sync, and host-departure grace into the chat card.
**Where**: `plugins/waffle-party/MusicCard.svelte`
**Depends on**: T1, T2, T3, T4
**Reuses**: `tilePresence`, `syncResponder`, `host.cards()`, and media-session actions
**Requirement**: WAF-03, WAF-04, WAF-05, WAF-06, WAF-11, WAF-12, WAF-13, WAF-14, WAF-18, WAF-20, WAF-21, WAF-22, WAF-23, WAF-24

**Done when**:

- [ ] The card restores/saves local volume and never shares it in party updates.
- [ ] Text action buttons become accessible, tooltip-equipped icons; text inputs and loop selector remain textual.
- [ ] Recreate appears only for the creator's newest closed, non-empty same-room party and creates the specified new-party payload.
- [ ] Joining sends the live renderer's track/index, position, and playing state through the shared sync update.
- [ ] Host departure waits five seconds and cancels on reconnect; non-host departure remains immediate leave.
- [ ] `pnpm check` passes and manual UAT covers card interaction paths.

**Tests**: typecheck + manual UAT
**Gate**: build
**Commit**: `feat(waffle-party): improve party card controls and recovery`

### T6: Upgrade call-tile preferences and controls

**Status**: Done

**What**: Wire persisted local volume, icon controls, join synchronization, and player shielding into the Waffle call tile.
**Where**: `plugins/waffle-party/WaffleCallTile.svelte`
**Depends on**: T1, T3, T4, T5
**Reuses**: `tilePresence`, `syncResponder`, and in-call Lucide controls
**Requirement**: WAF-03, WAF-04, WAF-05, WAF-06, WAF-18, WAF-19, WAF-20

**Done when**:

- [ ] Tile volume restores and persists independently of shared party state.
- [ ] All tile action buttons retain shared behavior with accessible icon controls.
- [ ] A joined listener receives and uses the responder's current position and playing state.
- [ ] `pnpm check` passes and manual UAT covers call-tile controls and direct iframe blocking.

**Tests**: typecheck + manual UAT
**Gate**: build
**Commit**: `feat(waffle-party): align call tile controls and volume`

### T7: Convert widget playback buttons to matching icons

**Status**: Done

**What**: Ensure the compact Waffle Party widget uses the same accessible project icon treatment as the card and tile.
**Where**: `plugins/waffle-party/WaffleWidget.svelte`
**Depends on**: T5, T6
**Reuses**: existing `Play`, `Pause`, `SkipBack`, and `SkipForward` icons
**Requirement**: WAF-03

**Done when**:

- [ ] Every widget action remains accessible by name and invokes the same shared update as before.
- [ ] Styling matches the in-call icon-button language.
- [ ] `pnpm check` passes.

**Tests**: typecheck + manual UAT
**Gate**: build
**Commit**: `style(waffle-party): align widget controls with call icons`

### T8: Resolve immediate update sender names from local profile state

**Status**: Done

**What**: Replace the literal teardown sender fallback with a non-empty cached local display name or deterministic identity label.
**Where**: `awful.chat/frontend/src/lib/transport/transport.svelte.ts`
**Depends on**: T3
**Reuses**: profile state and normal plugin-update signing path
**Requirement**: WAF-08, WAF-09, WAF-10

**Done when**:

- [ ] `sendUpdateImmediately` never assigns the literal `Anonymous` sender name.
- [ ] A loaded profile nickname is used without asynchronous I/O during teardown.
- [ ] Missing profile state uses a stable non-empty identity-derived label.
- [ ] Focused transport test covers profile and fallback paths.

**Tests**: unit in a colocated transport sender-name test
**Gate**: full
**Commit**: `fix(transport): preserve plugin teardown sender names`

### T9: Add the watched-transmission tile exit control

**Status**: Done

**What**: Render a red top-left Stop watching icon button on actively watched remote transmission cards and reuse the current stop-watch action.
**Where**: `awful.chat/frontend/src/lib/components/VoiceVideoCallView.svelte`
**Depends on**: T8
**Reuses**: `stopWatchingTransmission`, `Radio`, `Tip`, and existing red stop-watch styling
**Requirement**: WAF-21, WAF-22, WAF-23

**Done when**:

- [ ] The control appears only on an actively watched remote transmission.
- [ ] Clicking the control stops watching without invoking the tile's focus handler.
- [ ] The normal pending watch card returns after state updates.
- [ ] `pnpm check` passes and manual UAT covers watched and pending states.

**Tests**: typecheck + manual UAT
**Gate**: build
**Commit**: `feat(call): add watched stream exit control`

### T10: Update plugin documentation and run cross-repository UAT

**Status**: Done

**What**: Document local volume persistence, autoplay behavior, recreation, join synchronization, iframe constraints, and the five-second host grace; execute the full acceptance walkthrough.
**Where**: `plugins/waffle-party/README.md`
**Depends on**: T1, T2, T3, T4, T5, T6, T7, T8, T9
**Reuses**: existing Waffle Party Use and Requirements sections
**Requirement**: WAF-01–WAF-27

**Done when**:

- [ ] Documentation matches shipped behavior and browser-autoplay limitation.
- [ ] Full app gate passes after refreshing the generated plugin mirror.
- [ ] Manual two-client UAT records evidence for every acceptance criterion.

**Tests**: build + manual UAT
**Gate**: build
**Commit**: `docs(waffle-party): document resilient party controls`

---

## Phase Execution Map

```text
T1 → T2 → T3 → T4 → T5 → T6 → T7
T1 → T5
T1 → T6
T2 → T5
T3 → T5
T3 → T6
T3 → T8 → T9
T4 → T6
T5 → T7
T1 → T10
T2 → T10
T3 → T10
T4 → T10
T5 → T10
T6 → T10
T7 → T10
T8 → T10
T9 → T10
```

## Task Granularity Check

| Task | Scope | Status |
| --- | --- | --- |
| T1 | One local preference helper | ✅ Granular |
| T2 | One timer helper | ✅ Granular |
| T3 | One shared reducer | ✅ Granular |
| T4 | One player component | ✅ Granular |
| T5 | One card component | ✅ Cohesive UI surface |
| T6 | One tile component | ✅ Cohesive UI surface |
| T7 | One widget component | ✅ Granular |
| T8 | One transport function | ✅ Granular |
| T9 | One stream-card component | ✅ Granular |
| T10 | One documentation surface | ✅ Granular |

## Diagram-Definition Cross-Check

| Task | Depends On | Diagram Shows | Status |
| --- | --- | --- | --- |
| T1 | None | Phase start | ✅ Match |
| T2 | T1 | T1 → T2 | ✅ Match |
| T3 | T2 | T2 → T3 | ✅ Match |
| T4 | T3 | T3 → T4 | ✅ Match |
| T5 | T1, T2, T3, T4 | T1/T2/T3/T4 → T5 | ✅ Match |
| T6 | T1, T3, T4, T5 | T1/T3/T4/T5 → T6 | ✅ Match |
| T7 | T5, T6 | T5/T6 → T7 | ✅ Match |
| T8 | T3 | T3 → T8 | ✅ Match |
| T9 | T8 | T8 → T9 | ✅ Match |
| T10 | T1–T9 | T1–T9 → T10 | ✅ Match |

## Test Co-location Validation

| Task | Code Layer Modified | Matrix Requires | Task Says | Status |
| --- | --- | --- | --- | --- |
| T1 | Plugin helper | unit | unit | ✅ OK |
| T2 | Plugin helper | unit | unit | ✅ OK |
| T3 | Plugin reducer | unit | unit | ✅ OK |
| T4 | Plugin Svelte UI | typecheck + UAT | none + build | ✅ OK |
| T5 | Plugin Svelte UI | typecheck + UAT | none + build | ✅ OK |
| T6 | Plugin Svelte UI | typecheck + UAT | none + build | ✅ OK |
| T7 | Plugin Svelte UI | typecheck + UAT | none + build | ✅ OK |
| T8 | Transport helper | unit | unit | ✅ OK |
| T9 | Call Svelte UI | typecheck + UAT | none + build | ✅ OK |
| T10 | Documentation | build + UAT | none + build | ✅ OK |
