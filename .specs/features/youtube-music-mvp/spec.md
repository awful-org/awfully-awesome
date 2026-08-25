# YouTube Music MVP Specification

## Problem Statement

Room participants need a lightweight way to choose and listen to YouTube videos together without an API key, server-side audio extraction, or a voice-call media integration. The plugin must synchronize the shared queue and playback intent while every participant plays the official YouTube embed locally.

## Goals

- [ ] Let a room participant create a shared YouTube music session from a supported URL.
- [ ] Let room participants manage a persistent shared queue and shared playback intent.
- [ ] Use the official YouTube IFrame Player API without a YouTube Data API key or relay configuration.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Extracting, downloading, or relaying YouTube audio | It is incompatible with the intended official-player integration and YouTube policy. |
| Injecting music into awful.chat voice calls | The public plugin host API does not expose voice/media transport. |
| Frame-perfect playback synchronization | The plugin host does not provide a shared clock or media transport. |
| YouTube search, metadata lookup, playlists, and recommendations | They introduce separate API, quota, and policy scope. |
| Slash commands that append to an existing card | The current host API does not expose room cards to command handlers. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Plugin distribution | One external `youtube-music` plugin in `awfully-awesome/plugins/` | This is the repository intended for third-party awful.chat plugins. | y |
| Playback model | Every participant loads and hears their own official YouTube embed | It needs no key and avoids audio extraction or voice transport work. | y |
| Player visibility | Show an unobscured player of at least 200 by 200 pixels; make the queue panel collapsible, not the player | YouTube requires an embedded player viewport of at least 200 by 200 pixels and forbids obscuring player controls. | y |
| Queue authority | Any room participant can add, remove, skip, pause, resume, and seek | The host API exposes room peers, not active voice-call membership. | y |
| Activity log | Persist a chronological log of accepted add, remove, skip, play, pause, and seek actions | It makes room-wide DJ actions visible after reload and to late joiners. | y |
| Card theme | Use awful.chat's existing semantic theme tokens for the surrounding card and controls | It matches the site without altering the official embedded-player UI. | y |
| Playback start | Each participant explicitly enables local playback when their browser requires a user gesture | Browsers can block unmuted scripted playback. | y |
| Synchronization | Persist the current item and explicit play, pause, skip, and seek actions; do not claim clock-accurate synchronization | No shared clock exists on the plugin host surface. | y |
| Unsupported URL behavior | Reject it locally and show an inline validation message without sending a card or update | Prevents invalid shared state. | y |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: Create and play a shared session ⭐ MVP

**User Story**: As a room participant, I want to post a YouTube URL as a shared music session so that everyone can listen through their own YouTube player.

**Why P1**: This creates the keyless, policy-compatible basis for the feature.

**Acceptance Criteria**:

1. WHEN a participant sends `/play` followed by a supported YouTube watch, short, embed, or youtu.be URL containing a video identifier THEN the plugin SHALL post one `youtube-music` card whose initial queue contains that video identifier.
2. IF `/play` has no supported YouTube video identifier THEN the plugin SHALL show a local format error and SHALL not post a card.
3. WHEN a music card renders THEN the plugin SHALL render an official YouTube embedded player with a visible viewport of at least 200 by 200 pixels for the selected queue item.
4. WHEN the embedded player becomes ready THEN the plugin SHALL load the selected queue item without requiring a YouTube Data API key or plugin relay configuration.
5. IF a browser blocks scripted unmuted playback THEN the plugin SHALL show a local action that lets that participant start playback from a user gesture.

**Independent Test**: Run `/play https://youtu.be/M7lc1UVf-VE`, verify one card has a visible player and one queue item, then verify an invalid URL does not post a card.

### P1: Collaborate on the queue ⭐ MVP

**User Story**: As a room participant, I want to add, remove, and advance tracks so that the group can choose what plays next.

**Why P1**: A single embedded video does not satisfy the music-queue use case.

**Acceptance Criteria**:

1. WHEN a participant submits a supported YouTube URL through a music card THEN the plugin SHALL append one queue entry through a persisted plugin update.
2. WHEN a participant removes a queued entry THEN the plugin SHALL remove that entry through a persisted plugin update and SHALL select the next remaining entry when the removed entry was selected.
3. WHEN a participant skips the selected entry THEN the plugin SHALL select the next queue entry and SHALL stop playback when no next entry exists.
4. IF an add or remove update contains an invalid video identifier or queue index THEN the reducer SHALL leave the shared queue unchanged.
5. WHILE a room participant reloads or joins after queue updates were sent THEN the plugin SHALL rebuild the same queue and selected entry by replaying persisted updates in host order.

**Independent Test**: Create a session, add two valid IDs, remove the selected item, and reload another participant to verify the same remaining queue and selection.

### P1: Make DJ actions visible ⭐ MVP

**User Story**: As a room participant, I want to see who changed the shared queue so that collaborative controls remain understandable.

**Why P1**: Room-wide authority needs an auditable shared history.

**Acceptance Criteria**:

1. WHEN a room participant adds, removes, skips, plays, pauses, or seeks through a music card THEN the plugin SHALL append one persisted activity-log entry containing the host-verified sender name, action, and affected queue item when applicable.
2. WHILE a participant reloads or joins after accepted music actions were sent THEN the plugin SHALL rebuild the same chronological activity log from persisted updates in host order.
3. IF a received update is invalid or does not change shared music state THEN the plugin SHALL not append an activity-log entry.
4. The plugin SHALL render room-wide controls and activity-log styling with existing awful.chat semantic theme tokens.

**Independent Test**: Add and skip tracks from two peers, reload a third peer, and verify the same ordered log names the verified senders and actions.

### P1: Share playback intent ⭐ MVP

**User Story**: As a room participant, I want play, pause, seek, and skip actions reflected in the room so that listeners follow the same track and approximate position.

**Why P1**: The queue needs shared controls to feel collaborative.

**Acceptance Criteria**:

1. WHEN a participant plays, pauses, skips, or seeks using the card controls THEN the plugin SHALL send one persisted update describing that action.
2. WHEN the reducer receives a valid playback update THEN the plugin SHALL store the selected queue entry, intended playing state, and non-negative seek position in shared card state.
3. WHEN a participant receives a valid playback update THEN the local player SHALL load or seek to the selected item and apply the intended playing or paused state after the player is ready.
4. IF a playback update references an absent queue entry or a negative, non-finite seek position THEN the reducer SHALL leave shared playback state unchanged.
5. The plugin SHALL describe shared playback as best-effort and SHALL not claim synchronized audio timing across browsers.

**Independent Test**: Use two clients on the same room; play, pause, seek, and skip from one card, then verify the other card selects the same item and applies each control after local playback is enabled.

### P2: Keep the card compact

**User Story**: As a room participant, I want to collapse the queue details so that the card does not dominate chat while retaining the required player.

**Why P2**: It addresses the desired compact experience without hiding or obscuring the official player.

**Acceptance Criteria**:

1. WHEN a participant toggles queue details THEN the plugin SHALL collapse or expand only the queue controls and entries while keeping the player visible and usable.
2. WHILE queue details are collapsed THEN the plugin SHALL show the selected entry and playback controls.

**Independent Test**: Toggle queue details and verify the queue hides while the embedded player and controls remain visible.

## Edge Cases

- IF an update would remove the last queue entry THEN the plugin SHALL retain an empty queue with no selected entry and intended playback paused.
- IF the YouTube IFrame API fails to load or reports an unrecoverable player error THEN the plugin SHALL show a local error and SHALL preserve the shared queue state.
- IF the same valid URL is added more than once THEN the plugin SHALL retain each entry as a separate requested queue item.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| YM-01 | P1: Create and play a shared session | Tasks | Implementing |
| YM-02 | P1: Create and play a shared session | Tasks | Pending |
| YM-03 | P1: Create and play a shared session | Tasks | Pending |
| YM-04 | P1: Collaborate on the queue | Tasks | Implementing |
| YM-05 | P1: Collaborate on the queue | Tasks | Implementing |
| YM-06 | P1: Make DJ actions visible | Tasks | Implementing |
| YM-07 | P1: Make DJ actions visible | Tasks | Implementing |
| YM-08 | P1: Share playback intent | Tasks | Implementing |
| YM-09 | P1: Share playback intent | Tasks | Implementing |
| YM-10 | P2: Keep the card compact | Tasks | Pending |

**Coverage:** 10 total, 0 mapped to tasks, 10 unmapped pending design.

## Success Criteria

- [ ] A room participant can create a shared session with `/play <supported YouTube URL>` and no API key.
- [ ] Two participants converge on the same queue and selected track after persisted updates replay.
- [ ] The plugin sends no extracted media bytes and requires no relay environment variables.
