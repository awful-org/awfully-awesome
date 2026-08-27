# Waffle Party

Create a shared queue with `/play` followed by a YouTube video or playlist URL.
Everyone who joins the party hears the same selected track and can use its
room-wide controls.

## Use

Start a party with either URL type:

```text
/play https://youtu.be/VIDEO_ID
/play https://www.youtube.com/playlist?list=PLAYLIST_ID
```

Open the queue to add more video or playlist URLs. Party members can select a
numbered track, remove it, skip, seek, pause/play, adjust the local volume, and
choose looping for one track or the entire queue. The queue shows video titles
and becomes scrollable after about ten tracks. Playback and queue actions use
the same icon controls as an in-call player; YouTube's embedded controls are
intentionally blocked so only synchronized Waffle controls can affect a party.

The host can disband the party. A participant may join only one Waffle Party in
the same room at a time; refreshing or leaving removes that participant. If the
host disconnects, members wait five seconds before closing the party and cancel
that close if the host reconnects.

Volume is a per-listener browser preference stored under
`awful:plugin:waffle-party:audio_prefs`; it is never sent to the room. A new
party starts playing when it has a selected track, and a listener joining an
active party is synchronized to the live selected track, position, and playing
state. Browser autoplay policy can still require that listener to press Play.

After closing a populated party, its creator can use the Recreate icon on only
their latest closed party in that room. It opens a new party with the same queue
and selected track, without carrying members or activity forward.

## Playlists

Playlist URLs do not require an API key: the party host's embedded player reads
the playlist and shares up to 200 video IDs with the room. Tracks are shared in
two-video batches so playback can begin before a long playlist has fully joined
the queue. The card shows `Reading playlist…` while YouTube is resolving it and
then reports batch progress.

## Install

Add this repository to `PLUGIN_SOURCES` and redeploy:

```text
PLUGIN_SOURCES=awful-org/awfully-awesome#<tag-or-sha>
```

## Requirements

None. The plugin uses the official visible YouTube embed in each participant's
browser and needs no API key or relay configuration.

It does not extract audio, inject music into voice calls, search YouTube, or
promise frame-accurate synchronization. Browser autoplay rules can require each
participant to press Play once.
