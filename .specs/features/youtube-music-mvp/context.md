# YouTube Music MVP Context

**Gathered:** 2026-08-24
**Spec:** `.specs/features/youtube-music-mvp/spec.md`
**Status:** Ready for design

---

## Feature Boundary

A keyless shared YouTube queue that plays official embeds locally, synchronizes queue and playback intent through persisted room updates, and records visible room-wide DJ actions.

---

## Implementation Decisions

### Collaboration

- Every chat-room participant may add, remove, skip, play, pause, and seek.
- “Anyone in the call” maps to room participants because the plugin host does not expose active call membership.
- Accepted actions produce a persisted activity-log entry with the host-verified sender name.

### Player presentation

- The official YouTube player remains visible and unobscured at the required minimum size.
- The queue panel is collapsible by default to keep the card compact.
- The surrounding card uses awful.chat semantic theme tokens. The YouTube player UI is not restyled or covered.

### Playback behavior

- Each participant plays the embed locally.
- Browsers that require a user gesture show an explicit local enable-playback action.
- Queue and explicit playback actions replay deterministically. Time-accurate multi-browser synchronization is deferred.

### Agent's Discretion

- Use the smallest component structure that safely loads and controls the IFrame Player API.
- Use a compact, chronological activity-log presentation.

### Declined / Undiscussed Gray Areas → Assumptions

- DJ-only permissions are deferred because the MVP is explicitly collaborative.
- Search, playlists, and metadata APIs are deferred to keep the integration keyless.

## Specific References

No visual reference was supplied. Match the existing awful.chat plugin-card style and semantic theme tokens.

## Deferred Ideas

- DJ-only or role-based room controls.
- Frame-accurate playback reconciliation.
- YouTube search and playlist import.
