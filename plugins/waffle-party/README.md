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
and becomes scrollable after about ten tracks.

The host can disband the party. A participant may join only one Waffle Party in
the same room at a time; refreshing or leaving removes that participant, while
the host leaving closes the party.

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

Privacy note: track titles resolve through YouTube's public oEmbed endpoint
from each participant's browser, so YouTube sees participants' IPs for queued
titles - the same party the embedded player itself already talks to during
playback.

It does not extract audio, inject music into voice calls, search YouTube, or
promise frame-accurate synchronization. Browser autoplay rules can require each
participant to press Play once.
