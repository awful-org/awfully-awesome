# Validation: Waffle Party Resilience and Controls — PASS

**Result**: PASS

## Gate results

- `pnpm test`: 37 files / 298 tests passed.
- `pnpm check`: passed with 0 errors and 0 warnings.
- `pnpm build`: passed. Vite emitted existing non-blocking dynamic-import and
  chunk-size advisories; the plugin also has existing Svelte build advisories
  that do not appear in `pnpm check`.

## Acceptance evidence

| Area | Evidence | Result |
| --- | --- | --- |
| Iframe shield and icon controls | `plugins/waffle-party/WafflePlayer.svelte:226` renders the inert overlay; `plugins/waffle-party/MusicCard.svelte:155` recreates a new payload and the surrounding controls have labelled icon buttons. | PASS |
| Local volume | `plugins/waffle-party/audio-prefs.ts:18` reads the namespaced preference helper and `plugins/waffle-party/audio-prefs.ts:27` writes only valid values. `plugins/waffle-party/audio-prefs.test.ts:15` asserts the exact fallback value of 100; `plugins/waffle-party/audio-prefs.test.ts:28` asserts the persisted key and values. | PASS |
| Named teardown update | `../awful.chat/frontend/src/lib/transport/plugin-sender-name.ts:10` rejects empty and Anonymous cached names; `../awful.chat/frontend/src/lib/transport/plugin-sender-name.test.ts:20` asserts deterministic non-Anonymous fallbacks. | PASS |
| Recreate latest populated party | `plugins/waffle-party/MusicCard.svelte:244` limits recreation to the current user's latest closed non-empty card; `plugins/waffle-party/MusicCard.svelte:155` sends only queue, selected index, and owner. `plugins/waffle-party/logic.test.ts:84` asserts recreated state selects the requested queue item at position zero and starts playing. | PASS |
| Autoplay and join sync | `plugins/waffle-party/logic.test.ts:68` asserts a new initial video is playing at zero; `plugins/waffle-party/MusicCard.svelte:176` sends the renderer's index, current time, and playing state. | PASS |
| Stream exit | `../awful.chat/frontend/src/lib/components/VoiceVideoCallView.svelte:1023` gates the watched state and `../awful.chat/frontend/src/lib/components/VoiceVideoCallView.svelte:1132` renders the red stop-watching control, stopping propagation before calling the existing action. | PASS |
| Host grace | `plugins/waffle-party/host-departure.test.ts:11` proves no close at 4,999 ms and exactly one at 5,000 ms; `plugins/waffle-party/host-departure.test.ts:18` proves reconnect cancels the close. `plugins/waffle-party/MusicCard.svelte:267` observes reconnect snapshots on every member. | PASS |

## Discrimination sensor

An isolated `/tmp/waffle-sensor-app` git worktree was used and then removed;
the real worktree status matched its baseline after cleanup.

| Mutant | Narrow command | Verdict |
| --- | --- | --- |
| Change default volume from 100 to 0 | `pnpm test -- plugins/waffle-party/audio-prefs.test.ts` | Killed: exact 100 assertion failed. The initial mutant survived because the test imported the implementation constant; the assertion was strengthened and the repeat killed it. |
| Change host grace from 5,000 ms to 0 | `pnpm test -- plugins/waffle-party/host-departure.test.ts` | Killed: closure happened before 4,999 ms. |
| Disable initial autoplay | `pnpm test -- plugins/waffle-party/logic.test.ts` | Killed: initial and recreated-state autoplay assertions failed. |
| Restore `Anonymous` immediate fallback | `pnpm test -- src/lib/transport/plugin-sender-name.test.ts` | Killed: deterministic `Unknown` assertion failed. |

## Quality and UAT scope

Only the plugin surfaces, host transport helper, and stream-card control required
by the specification changed. The implementation follows the repository's
existing Svelte/Lucide and HostApi patterns. Two-client browser UAT was not run
because this non-interactive workspace has no authenticated relay/client pair;
the rendered UI paths were typechecked and the stateful behaviors are covered
by the tests above.
