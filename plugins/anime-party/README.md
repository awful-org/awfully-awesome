# Anime Party

Watch an episode together. Start one with:

```text
/anime-party One Piece
```

## Use

`/anime-party <title>` looks the title up on AniList for a proper title,
episode count, and cover art. If AniList has no match, is slow, or is
unreachable, the party opens anyway, with the typed title and no cover
image. The lookup never blocks or delays the party.

The party appears as a chat card and as a click-to-join tile in a call,
like a screen share. A member joins with one click; nothing plays until
they do.

Each participant opens their own copy of the current episode with the file
picker in the player. Every participant opens their own file, and no file
bytes ever cross the room - the plugin only keeps every open player at the
same position and paused-or-playing state, the same way Syncplay does.

The host controls playback: play, pause, seek, and moving to the next
episode. Those controls reach every other member within about a second. A
member who joins after playback already started gets a one-time sync
instead of waiting for the next heartbeat. Everyone else watches and picks
their own file; only the host drives transport.

Moving to episode N+1 clears everyone's loaded file. Nobody's file for the
next episode is known to anyone but them, so every participant opens it
again.

The host can close the party. If the host's connection drops, other
members wait 15 seconds for it to return before the party closes; a call
renegotiation that briefly drops and restores the connection does not
trigger this.

Volume is a per-listener browser preference, stored under
`awful:plugin:anime-party:volume`. It stays on that device and is never
sent to the room.

## Files and subtitles

Chromium cannot play the **Matroska (.mkv) container** at all, so an .mkv
file is refused before it is even tried. A filename hinting at HEVC,
H.265, or 10-bit color gets a warning instead of a refusal: only the
browser's own decode attempt can say for certain whether it works, and
those encodes are unreliable.

Subtitles baked into a video container are not exposed to a browser at
all - there is no way around this. Pick a separate subtitle file instead.
It must be **WebVTT (.vtt)**, the only subtitle format a browser's native
`<track>` element reads. An .srt or .ass file shows nothing.

## Install

Add this repository to `PLUGIN_SOURCES` and redeploy:

```text
PLUGIN_SOURCES=awful-org/awfully-awesome#<tag-or-sha>
```

## Requirements

None for the operator. AniList's public GraphQL API answers directly from
each participant's browser, so the plugin needs no API key and no relay
configuration.

It does need the app to ship `$lib/plugins/watch`, the shared clock-sync
library this plugin builds on. That library lands with
[awful.chat#29](https://github.com/awful-org/awful.chat/pull/29). An
instance built before it does not have the library, and this plugin does
not work there.

See [docs/anidb-watch-party.md](https://github.com/awful-org/awful.chat/blob/main/docs/anidb-watch-party.md)
in the app repo for why AniDB, not AniList, was the first metadata source
considered, and why it was rejected.

Privacy note: an AniList lookup sends the typed title to AniList from the
searching participant's own browser, the same way loading the cover image
does. No file, filename, or playback position is ever sent anywhere but
the room's own members.

It does not extract audio, search AniList as you type, or verify that two
participants actually opened the same release. Sync is close, not
frame-accurate: two different releases of the same episode - different
cuts, different pre-roll - can sit seconds apart, and nothing detects
that. Browser autoplay policy can still require a member to press Play
once.
