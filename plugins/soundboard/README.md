# Soundboard

Run `/soundboard` to open a private nine-slot soundboard, and pin it to a
sidebar slot (the dotted "+ pin" boxes) to play sounds from anywhere - each
sound's emoji becomes its one-tap button in the strip. The panel appears
only on your device and never becomes a room message. Import an MP3, choose a
segment from 0.25 through 5 seconds, preview it locally, set its volume, name it,
and save it with an emoji. Saved sounds can be renamed or have their volume
and emoji adjusted later.
Clicking a saved tile mixes the clip into your outgoing P2P call audio, so the
people in the call hear it as audio from you. It still plays while your
microphone is muted; it is disabled while you are deafened or outside a call.

## Limits and privacy

- Nine sounds per identity on each device.
- MP3 imports only, at most 8 MiB and two minutes long.
- Mono or stereo sources; saved clips are normalized to mono 48 kHz WAV.
- Saved clips are between 0.25 and 5 seconds.
- Sound bytes live in IndexedDB and do not sync to paired devices.
- Imports, playback and deletion send no plugin updates, files or chat messages.
- Starting a sound stops your currently playing sound.

## Install

Add this repository to the instance and redeploy:

```text
PLUGIN_SOURCES=awful-org/awfully-awesome#<tag-or-sha>
```

The host must include the private local-card and call-audio plugin capabilities
introduced with the soundboard feature.

## Instance requirements

None. The plugin uses browser-local storage and the existing P2P voice call.
