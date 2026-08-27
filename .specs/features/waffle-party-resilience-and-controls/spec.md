# Waffle Party Resilience and Controls Specification

## Problem Statement

Waffle Party currently exposes unsynchronised YouTube controls, loses each listener's
volume after a reload, and has incomplete recovery and exit behavior. A brief relay
disconnect can also end a party immediately, while users cannot leave a watched stream
from its card.

## Goals

- [x] Make party and stream controls predictable, icon-based, and accessible.
- [x] Persist each listener's Waffle Party volume locally.
- [x] Preserve party continuity through a five-second host-disconnect grace period.
- [x] Make party recreation, autoplay, and stream exit available where users expect them.

## Out of Scope

| Feature | Reason |
| --- | --- |
| Persisting queues or party membership across browser sessions | Parties remain room-card state, not user history. |
| Circumventing browser autoplay policies | The client will request playback; browsers may still require user interaction. |
| Global profile-name policy changes | The scope is the plugin-update teardown sender name only. |
| Changing screen-share transport or relay infrastructure | The feature consumes the existing transport callbacks. |

---

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Branch scope | The matching feature branch exists in both `awfully-awesome` and `awful.chat`. | The plugin and host/stream UI live in separate repositories. | y |
| Iframe shield | A transparent, inert overlay intercepts pointer input over the YouTube iframe; Waffle Party's own controls remain reachable above it. | Prevents unsynchronised YouTube controls from changing local playback. | n |
| Icon controls | Replace Waffle Party's playback, seek, queue, removal, leave, disband, and recreation text buttons with existing Lucide icons, tooltips, and accessible labels; leave text inputs, status text, and the loop selector as text. | Matches the in-call control language without removing discoverability. | n |
| Volume preference | Store a validated integer volume in `host.storage` under `audio_prefs`, yielding `awful:plugin:waffle-party:audio_prefs`; missing/corrupt values default to 100. | Uses the existing namespaced storage contract and produces the exact required key. | n |
| Recreate eligibility | Show Recreate only on a closed party whose owner is the current user and whose card is that user's newest Waffle Party card in the same room. | Avoids reviving stale historical parties. | n |
| Recreation shape | Recreate creates a new party with the closed party's original queue and selected track, starts at position 0, and does not copy members, activity, or closed state. Parties with an empty queue have no Recreate control. | Recreates usable content while avoiding a stale participant list or playback position. | n |
| Autoplay | A newly created party starts with shared `playing: true`; all renderers request YouTube playback on initial load and every selected/advanced track. | The owner command is a user gesture and queue changes should continue playback. | n |
| Host departure | A detected host disconnect waits five seconds; a reappearance of the same host DID during that interval cancels closure. A deliberate browser/app teardown follows the same grace period. | Relay drops cannot reliably distinguish a brief outage from an intentional exit. | n |
| Stream exit placement | An actively watched remote transmission receives a red, icon-only Stop watching control in the tile's top-left corner; clicking it stops watching and restores the normal watch card. | Provides the requested direct exit without changing the existing bottom control. | n |

**Open questions:** none - all resolved or logged above.

---

## User Stories

### P1: Protected, familiar party playback controls

**User Story**: As a party listener, I want only shared Waffle Party controls to affect playback so that my local iframe cannot desynchronise the party.

**Why P1**: Unsynchronised iframe controls undermine the main purpose of a shared party.

**Acceptance Criteria**:

1. WHILE a Waffle Party player is rendered, the system SHALL place a transparent inert pointer shield above the embedded YouTube iframe and below Waffle Party controls. <!-- state-driven -->
2. WHEN a user presses the pointer shield, THEN the system SHALL not invoke a playback, navigation, focus, or iframe action. <!-- event-driven -->
3. WHEN Waffle Party renders an actionable playback or party-management control, THEN the system SHALL render the corresponding project icon with an accessible name and tooltip. <!-- event-driven -->

**Independent Test**: Render each player surface, verify the shield catches iframe-targeted clicks, and verify icon buttons send their existing shared actions.

### P1: Durable listener audio preferences

**User Story**: As a listener, I want my Waffle Party volume remembered so that I do not need to reset it every time I open a party.

**Why P1**: Volume is a local preference and should survive component remounts and reloads.

**Acceptance Criteria**:

1. WHEN a Waffle Party player initializes, THEN the system SHALL read `awful:plugin:waffle-party:audio_prefs` and apply its valid stored volume. <!-- event-driven -->
2. WHEN a listener changes Waffle Party volume, THEN the system SHALL persist the validated integer value from 0 through 100 under `awful:plugin:waffle-party:audio_prefs`. <!-- event-driven -->
3. IF the stored preference is absent, malformed, or outside 0 through 100, THEN the system SHALL use volume 100 without failing playback. <!-- unwanted-behavior -->
4. The system SHALL keep volume local to the listener and SHALL not include it in synchronized party state. <!-- ubiquitous -->

**Independent Test**: Seed valid and invalid storage values, mount each renderer, change volume, and confirm the expected local value and storage payload.

### P1: Named party lifecycle activity

**User Story**: As a party member, I want the person who closes or leaves a party identified correctly so that activity history is trustworthy.

**Why P1**: The current teardown path writes the literal name “Anonymous” even for known users.

**Acceptance Criteria**:

1. WHEN the application sends an immediate plugin update during teardown, THEN the system SHALL resolve and include the current user's non-empty profile nickname. <!-- event-driven -->
2. IF the profile nickname cannot be read during teardown, THEN the system SHALL use the latest cached non-empty local profile nickname and SHALL not emit the literal fallback name `Anonymous`. <!-- unwanted-behavior -->
3. WHEN a Waffle Party close or leave activity is reduced, THEN the system SHALL display the sender name carried by its verified update context. <!-- event-driven -->

**Independent Test**: Exercise the immediate-update path with a cached profile name and verify the emitted update and resulting activity use that name.

### P1: Recreate a latest closed party

**User Story**: As the creator of my most recent party, I want to recreate it so that I can resume the same queue without rebuilding it.

**Why P1**: The party card already retains the queue after closure, making recovery low friction.

**Acceptance Criteria**:

1. WHERE a closed card is the current user's newest Waffle Party card in its room, the system SHALL show a Recreate party control. <!-- optional-feature -->
2. WHERE a closed card is not the current user's newest Waffle Party card in its room, the system SHALL not show a Recreate party control. <!-- optional-feature -->
3. WHEN the user activates Recreate party, THEN the system SHALL create one new party with the closed party's non-empty queue and selected track at position 0, with no copied members or activity. <!-- event-driven -->
4. IF a closed party has an empty queue, THEN the system SHALL not render a Recreate party control. <!-- unwanted-behavior -->

**Independent Test**: Evaluate eligibility for newest/non-newest, owned/unowned, and empty-queue cards; recreate a populated queue and verify the new initial state.

### P1: Start and advance party playback automatically

**User Story**: As a party creator and listener, I want the selected YouTube video to begin when the party starts and when the queue advances.

**Why P1**: A shared queue should not require an extra Play action for each track.

**Acceptance Criteria**:

1. WHEN a user creates a Waffle Party with a valid initial video or resolved playlist entry, THEN the system SHALL initialize the party as playing at position 0. <!-- event-driven -->
2. WHEN the selected queue index changes while the party is playing, THEN the system SHALL request playback of the newly selected video from position 0. <!-- event-driven -->
3. IF the browser rejects autoplay, THEN the system SHALL keep the synchronized party state intact and SHALL expose the existing Waffle Party Play control for a user-initiated retry. <!-- unwanted-behavior -->

**Independent Test**: Test reducer initialization and queue transitions, plus player calls for initial and changed video IDs.

### P1: Join the host's live playback position

**User Story**: As a listener joining an active party, I want playback to begin at the host's current track and position so that I immediately hear what the host is hearing.

**Why P1**: A new listener starting at zero is visibly and audibly out of sync with an active party.

**Acceptance Criteria**:

1. WHEN a listener joins an active Waffle Party, THEN the system SHALL select the host's current queue index and send the host's current playback position and playing state to that listener. <!-- event-driven -->
2. WHEN the joining listener receives that synchronization, THEN the system SHALL load the selected video at the received position and request playback only when the synchronized state is playing. <!-- event-driven -->
3. IF the host is unavailable when a listener joins, THEN the system SHALL use the existing deterministic non-joining responder and SHALL send that responder's current playback position and playing state. <!-- unwanted-behavior -->

**Independent Test**: Join a listener while the host is playing a nonzero position and verify the emitted sync payload and the joining player's load/play calls.

### P1: Leave a watched stream from its tile

**User Story**: As a stream viewer, I want a clear way to stop watching from the stream card so that I can return to the normal card state.

**Why P1**: Watching currently lacks a close affordance in the card itself.

**Acceptance Criteria**:

1. WHILE a remote transmission is actively watched, the system SHALL render a red Stop watching icon control in the card's top-left corner. <!-- state-driven -->
2. WHEN the viewer activates that control, THEN the system SHALL stop consuming that transmission and render its normal watch-card state. <!-- event-driven -->
3. WHILE a transmission is not actively watched, the system SHALL not render the tile-level Stop watching control. <!-- state-driven -->

**Independent Test**: Render watched and pending transmission tiles, activate the control, and verify the transport stop action and normal watch affordance.

### P1: Tolerate brief host relay disconnects

**User Story**: As a party member, I want a brief host reconnect not to destroy the party so that relay instability does not end listening sessions.

**Why P1**: Host disconnect events can be transient when relays reconnect.

**Acceptance Criteria**:

1. WHEN a party member detects the host DID disconnect, THEN the system SHALL defer the host-left closure action for 5,000 milliseconds. <!-- event-driven -->
2. IF the host DID is present again before the 5,000-millisecond deadline, THEN the system SHALL cancel the deferred closure action. <!-- unwanted-behavior -->
3. IF the host DID remains absent for the entire 5,000-millisecond deadline, THEN the system SHALL submit exactly one host-left closure action and stop shared playback. <!-- unwanted-behavior -->
4. WHILE a host-disconnect closure is pending, the system SHALL continue to render the existing party state and SHALL not accept duplicate host-left timers. <!-- state-driven -->

**Independent Test**: Use fake timers and changing peer snapshots to prove cancellation on reconnection and exactly-one closure on sustained absence.

---

## Edge Cases

- IF storage is unavailable, THEN the system SHALL keep volume usable at its current in-memory value and SHALL not throw.
- IF more than one party member observes the same sustained host loss, THEN the system SHALL make duplicate closure updates harmless through the existing closed-state reducer guard.
- IF a user changes local volume while both the chat card and call tile mount, THEN the system SHALL converge each local renderer on the newly persisted preference.
- IF a selected video cannot play, THEN the system SHALL leave the synchronized selection unchanged and retain a user-initiated Play control.

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
| --- | --- | --- | --- |
| WAF-01 | Protected controls | T4 | Done |
| WAF-02 | Protected controls | T4 | Done |
| WAF-03 | Protected controls | T5–T7 | Done |
| WAF-04 | Audio preferences | T1/T5/T6 | Done |
| WAF-05 | Audio preferences | T1/T5/T6 | Done |
| WAF-06 | Audio preferences | T1/T5/T6 | Done |
| WAF-07 | Audio preferences | T1 | Done |
| WAF-08 | Named lifecycle | T8 | Done |
| WAF-09 | Named lifecycle | T8 | Done |
| WAF-10 | Named lifecycle | T8 | Done |
| WAF-11 | Recreate party | T5 | Done |
| WAF-12 | Recreate party | T5 | Done |
| WAF-13 | Recreate party | T5 | Done |
| WAF-14 | Recreate party | T5 | Done |
| WAF-15 | Autoplay | T3 | Done |
| WAF-16 | Autoplay | T3/T4 | Done |
| WAF-17 | Autoplay | T3/T4 | Done |
| WAF-18 | Join synchronization | T3/T5/T6 | Done |
| WAF-19 | Join synchronization | T3/T4/T6 | Done |
| WAF-20 | Join synchronization | T3/T5/T6 | Done |
| WAF-21 | Stream exit | T9 | Done |
| WAF-22 | Stream exit | T9 | Done |
| WAF-23 | Stream exit | T9 | Done |
| WAF-24 | Host tolerance | T2/T5 | Done |
| WAF-25 | Host tolerance | T2/T5 | Done |
| WAF-26 | Host tolerance | T2/T5 | Done |
| WAF-27 | Host tolerance | T2/T5 | Done |

**Coverage:** 27 total, 27 mapped to completed tasks, 0 unmapped.

## Success Criteria

- [ ] A party listener cannot operate embedded YouTube controls directly.
- [ ] Local volume is restored after reload from the requested storage key.
- [ ] A host reconnect within five seconds preserves the party; a sustained departure closes it once.
- [ ] A viewer can leave an active stream from its card and see the normal watch state.
