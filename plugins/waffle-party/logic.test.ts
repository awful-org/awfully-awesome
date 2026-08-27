import { describe, expect, it } from "vitest";
import {
  initialState,
  syncResponder,
  playlistIdFromUrl,
  reduce,
  videoIdFromUrl,
  type MusicState,
} from "./logic";

const ctx = (name = "Alice") => ({
  senderDid: `did:${name}`,
  senderName: name,
  updateId: "update-1",
  lamport: 1,
  ephemeral: false,
});

const first = "M7lc1UVf-VE";
const second = "dQw4w9WgXcQ";

function update(state: MusicState, data: unknown, name = "Alice") {
  return reduce(state, { data }, ctx(name));
}

describe("videoIdFromUrl", () => {
  it("accepts supported YouTube URL forms", () => {
    expect(videoIdFromUrl(`https://www.youtube.com/watch?v=${first}`)).toBe(
      first
    );
    expect(videoIdFromUrl(`https://youtu.be/${first}?feature=share`)).toBe(
      first
    );
    expect(videoIdFromUrl(`https://youtube.com/shorts/${first}`)).toBe(first);
    expect(videoIdFromUrl(`https://music.youtube.com/embed/${first}`)).toBe(
      first
    );
  });

  it("rejects missing, malformed, and unsupported video URLs", () => {
    expect(videoIdFromUrl("not a url")).toBeNull();
    expect(
      videoIdFromUrl("https://example.com/watch?v=M7lc1UVf-VE")
    ).toBeNull();
    expect(videoIdFromUrl("https://youtube.com/watch?v=short")).toBeNull();
    expect(videoIdFromUrl("https://youtube.com/watch")).toBeNull();
  });
});

describe("playlistIdFromUrl", () => {
  it("accepts a playlist URL without accepting unrelated list parameters", () => {
    expect(
      playlistIdFromUrl("https://www.youtube.com/playlist?list=PL1234567890")
    ).toBe("PL1234567890");
    expect(
      playlistIdFromUrl(
        "https://www.youtube.com/watch?v=M7lc1UVf-VE&list=PL1234567890"
      )
    ).toBe("PL1234567890");
    expect(
      playlistIdFromUrl("https://example.com/?list=PL1234567890")
    ).toBeNull();
  });
});

describe("music reducer", () => {
  it("seeds one selected queue item from card data", () => {
    expect(initialState({ videoId: first })).toEqual({
      queue: [first],
      currentIndex: 0,
      playing: false,
      position: 0,
      activity: [],
      activitySeq: 0,
      loop: "off",
      closed: false,
      ownerDid: "",
      members: new Map(),
      playlistRequests: [],
    });
    expect(initialState({ videoId: "invalid" }).queue).toEqual([]);
  });

  it("adds a valid entry and records the verified actor", () => {
    const state = update(
      initialState({ videoId: first }),
      { action: "add", videoId: second },
      "Bruno"
    );
    expect(state.queue).toEqual([first, second]);
    expect(state.activity).toEqual([
      { senderName: "Bruno", action: "added", videoId: second },
    ]);
  });

  it("adds a resolved playlist to the queue only when the host resolves it", () => {
    const playlistId = "PL1234567890";
    const owner = "Host";
    const party = update(
      initialState({ videoId: first, ownerDid: "did:Host" }),
      { action: "add-playlist", playlistId },
      owner
    );
    expect(party.playlistRequests).toEqual([playlistId]);

    const firstBatch = update(
      party,
      {
        action: "resolve-playlist",
        playlistId,
        videoIds: [second],
        done: false,
      },
      owner
    );
    expect(firstBatch.queue).toEqual([first, second]);
    expect(firstBatch.playlistRequests).toEqual([playlistId]);

    const resolved = update(
      firstBatch,
      { action: "resolve-playlist", playlistId, videoIds: [first], done: true },
      owner
    );
    expect(resolved.queue).toEqual([first, second, first]);
    expect(resolved.playlistRequests).toEqual([]);

    expect(
      update(
        party,
        {
          action: "resolve-playlist",
          playlistId,
          videoIds: [second],
          done: true,
        },
        "Bruno"
      )
    ).toBe(party);
  });

  it("rejects invalid adds without changing state or activity", () => {
    const original = initialState({ videoId: first });
    expect(update(original, { action: "add", videoId: "invalid" })).toBe(
      original
    );
  });

  it("removes the selected entry and selects the remaining entry", () => {
    const state = update(
      {
        ...initialState({ videoId: first }),
        queue: [first, second],
        playing: true,
        position: 25,
      },
      { action: "remove", index: 0 },
      "Carla"
    );
    expect(state.queue).toEqual([second]);
    expect(state.currentIndex).toBe(0);
    expect(state.position).toBe(0);
    expect(state.activity.at(-1)).toEqual({
      senderName: "Carla",
      action: "removed",
      videoId: first,
    });
  });

  it("stops playback when the final entry is removed", () => {
    const state = update(initialState({ videoId: first }), {
      action: "remove",
      index: 0,
    });
    expect(state.queue).toEqual([]);
    expect(state.currentIndex).toBeNull();
    expect(state.playing).toBe(false);
  });

  it("skips to the next track and stops after the final track", () => {
    const queued = {
      ...initialState({ videoId: first }),
      queue: [first, second],
      playing: true,
    };
    const next = update(queued, { action: "skip" });
    expect(next.currentIndex).toBe(1);
    expect(next.playing).toBe(true);
    expect(next.position).toBe(0);
    const ended = update(next, { action: "skip" });
    expect(ended.currentIndex).toBeNull();
    expect(ended.playing).toBe(false);
  });

  it("persists valid playback intent and rejects invalid positions", () => {
    const started = update(initialState({ videoId: first }), {
      action: "play",
      position: 12,
    });
    expect(started.playing).toBe(true);
    expect(started.position).toBe(12);
    const paused = update(started, { action: "pause", position: 18 }, "Dana");
    expect(paused.playing).toBe(false);
    expect(paused.position).toBe(18);
    expect(paused.activity.at(-1)).toEqual({
      senderName: "Dana",
      action: "paused",
      videoId: first,
    });
    expect(update(paused, { action: "seek", position: -1 })).toBe(paused);
    expect(update(paused, { action: "seek", position: Number.NaN })).toBe(
      paused
    );
  });

  it("selects a numbered queue entry and closes a prior party", () => {
    const queued = {
      ...initialState({ videoId: first }),
      queue: [first, second],
    };
    const selected = update(queued, { action: "select", index: 1 });
    expect(selected.currentIndex).toBe(1);
    expect(selected.position).toBe(0);
    expect(update(selected, { action: "close" }).closed).toBe(true);
  });

  it("removes a disconnected listener and closes when the host disconnects", () => {
    const owner = "Host";
    const member = "Bruno";
    const party = update(
      initialState({ videoId: first, ownerDid: "did:Host" }),
      { action: "join" },
      member
    );
    const pruned = update(party, { action: "prune", did: "did:Bruno" }, owner);
    expect(pruned.members.has("did:Bruno")).toBe(false);

    const closed = update(party, { action: "host-left" }, member);
    expect(closed.closed).toBe(true);
    expect(closed.playing).toBe(false);
  });

  it("loops a track or queue when an ended update targets the current item", () => {
    const track = {
      ...initialState({ videoId: first }),
      playing: true,
      loop: "track" as const,
      position: 80,
    };
    expect(update(track, { action: "ended", index: 0 }).currentIndex).toBe(0);
    const queue = {
      ...track,
      queue: [first, second],
      currentIndex: 1,
      loop: "queue" as const,
    };
    expect(update(queue, { action: "ended", index: 1 }).currentIndex).toBe(0);
  });
});

describe("syncResponder", () => {
  it("never picks the newest member and prefers the owner", () => {
    let s = initialState({ videoId: first, ownerDid: "did:Owner" });
    s = update(s, { action: "join" }, "Owner") as MusicState;
    expect(syncResponder(s)).toBeNull(); // alone: nobody to sync you

    s = update(s, { action: "join" }, "Bob") as MusicState;
    // Bob just joined: the owner answers, never Bob himself.
    expect(syncResponder(s)).toBe("did:Owner");

    s = update(s, { action: "join" }, "Carol") as MusicState;
    expect(syncResponder(s)).toBe("did:Owner");
  });

  it("falls back to the longest-standing member when the owner is gone", () => {
    let s = initialState({ videoId: first, ownerDid: "did:Owner" });
    s = update(s, { action: "join" }, "Owner") as MusicState;
    s = update(s, { action: "join" }, "Bob") as MusicState;
    s = update(s, { action: "join" }, "Carol") as MusicState;
    // Owner leaves: reducer forbids owner "leave", so simulate the members
    // map the fold would hold without them.
    const members = new Map(s.members);
    members.delete("did:Owner");
    const withoutOwner = { ...s, members } as MusicState;
    expect(syncResponder(withoutOwner)).toBe("did:Bob");
  });
});
