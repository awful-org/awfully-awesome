import { describe, expect, it } from "vitest";
import {
  initialState,
  syncResponder,
  playlistIdFromUrl,
  QUEUE_CAP,
  reduce,
  videoIdFromUrl,
  type MusicState,
  seekTarget,
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

/**
 * A party as one is actually created: with an owner.
 *
 * These fixtures used to omit ownerDid, which is not a shape any creation
 * path produces - both pass selfDid - and it quietly leaned on the hole
 * these tests now cover: an ownerless card waved every action through.
 */
function party(data: Record<string, unknown> = {}): MusicState {
  return initialState({ videoId: first, ownerDid: "did:Alice", ...data });
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
    expect(party()).toEqual({
      queue: [first],
      currentIndex: 0,
      playing: true,
      position: 0,
      activity: [],
      activitySeq: 0,
      loop: "off",
      closed: false,
      ownerDid: "did:Alice",
      members: new Map([["did:Alice", "Host"]]),
      playlistRequests: [],
    });
    expect(party({ videoId: "invalid" }).queue).toEqual([]);
  });

  it("seeds a recreated queue at its selected track", () => {
    const state = party({ queue: [first, second], currentIndex: 1 });
    expect(state.queue).toEqual([first, second]);
    expect(state.currentIndex).toBe(1);
    expect(state.position).toBe(0);
    expect(state.playing).toBe(true);
  });

  it("adds a valid entry and records the verified actor", () => {
    const state = update(
      update(party(), { action: "join" }, "Bruno"),
      { action: "add", videoId: second },
      "Bruno"
    );
    expect(state.queue).toEqual([first, second]);
    expect(state.activity).toEqual([
      { senderName: "Bruno", action: "joined", videoId: null },
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
    const original = party();
    expect(update(original, { action: "add", videoId: "invalid" })).toBe(
      original
    );
  });

  it("removes the selected entry and selects the remaining entry", () => {
    const state = update(
      {
        ...party(),
        queue: [first, second],
        playing: true,
        position: 25,
        members: new Map([...party().members, ["did:Carla", "Carla"]]),
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
    const state = update(party(), {
      action: "remove",
      index: 0,
    });
    expect(state.queue).toEqual([]);
    expect(state.currentIndex).toBeNull();
    expect(state.playing).toBe(false);
  });

  it("skips to the next track and stops after the final track when looping is off", () => {
    const queued = {
      ...party(),
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

  it("restarts or wraps the final track when the selected loop mode requires it", () => {
    const last = {
      ...party(),
      queue: [first, second],
      currentIndex: 1,
      playing: true,
      position: 42,
    };
    const trackLoop = update({ ...last, loop: "track" }, { action: "skip" });
    expect(trackLoop.currentIndex).toBe(1);
    expect(trackLoop.position).toBe(0);
    expect(trackLoop.playing).toBe(true);

    const queueLoop = update({ ...last, loop: "queue" }, { action: "skip" });
    expect(queueLoop.currentIndex).toBe(0);
    expect(queueLoop.position).toBe(0);
    expect(queueLoop.playing).toBe(true);
  });

  it("goes to the previous track and respects queue and track looping", () => {
    const secondTrack = {
      ...party(),
      queue: [first, second],
      currentIndex: 1,
      playing: true,
      position: 42,
    };
    const previous = update(secondTrack, { action: "previous" });
    expect(previous.currentIndex).toBe(0);
    expect(previous.position).toBe(0);

    const firstTrack = { ...secondTrack, currentIndex: 0 };
    const queueLoop = update({ ...firstTrack, loop: "queue" }, { action: "previous" });
    expect(queueLoop.currentIndex).toBe(1);
    expect(queueLoop.position).toBe(0);

    const trackLoop = update({ ...firstTrack, loop: "track" }, { action: "previous" });
    expect(trackLoop.currentIndex).toBe(0);
    expect(trackLoop.position).toBe(0);
  });

  it("persists valid playback intent and rejects invalid positions", () => {
    const started = update(party(), {
      action: "play",
      position: 12,
    });
    expect(started.playing).toBe(true);
    expect(started.position).toBe(12);
    const seated = {
      ...started,
      members: new Map([...started.members, ["did:Dana", "Dana"]]),
    };
    const paused = update(seated, { action: "pause", position: 18 }, "Dana");
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
      ...party(),
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

  it("starts playback when a playlist resolves its first entry", () => {
    const state = update(
      initialState({ playlistId: "PL1234567890", ownerDid: "did:Host" }),
      { action: "resolve-playlist", playlistId: "PL1234567890", videoIds: [first], done: true },
      "Host"
    );
    expect(state.currentIndex).toBe(0);
    expect(state.position).toBe(0);
    expect(state.playing).toBe(true);
  });

  it("loops a track or queue when an ended update targets the current item", () => {
    const track = {
      ...party(),
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

  it("rejects adds once the queue is at QUEUE_CAP", () => {
    const base = update(
      initialState({ videoId: first, ownerDid: "did:Host" }),
      { action: "join" },
      "Host"
    ) as MusicState;
    const full = {
      ...base,
      queue: Array.from({ length: QUEUE_CAP }, (_, i) => `vid${i}`),
    } as MusicState;
    expect(update(full, { action: "add", videoId: second }, "Host")).toBe(full);
    expect(
      update(full, { action: "add-playlist", playlistId: "PL1234567890" }, "Host")
    ).toBe(full);
  });

  it("a full queue retires the pending playlist request instead of looping", () => {
    const base = update(
      initialState({ videoId: first, ownerDid: "did:Host" }),
      { action: "join" },
      "Host"
    ) as MusicState;
    const full = {
      ...base,
      queue: Array.from({ length: QUEUE_CAP }, (_, i) => `vid${i}`),
      playlistRequests: ["PL1234567890"],
    } as MusicState;
    const next = update(
      full,
      {
        action: "resolve-playlist",
        playlistId: "PL1234567890",
        videoIds: [second],
        done: false,
      },
      "Host"
    ) as MusicState;
    expect(next.queue).toHaveLength(QUEUE_CAP);
    expect(next.playlistRequests).toEqual([]);
  });

  it("trims a resolve batch to the room left and retires the request", () => {
    const base = update(
      initialState({ videoId: first, ownerDid: "did:Host" }),
      { action: "join" },
      "Host"
    ) as MusicState;
    const nearlyFull = {
      ...base,
      queue: Array.from({ length: QUEUE_CAP - 1 }, (_, i) => `vid${i}`),
      playlistRequests: ["PL1234567890"],
    } as MusicState;
    const next = update(
      nearlyFull,
      {
        action: "resolve-playlist",
        playlistId: "PL1234567890",
        videoIds: [first, second],
        done: false,
      },
      "Host"
    ) as MusicState;
    expect(next.queue).toHaveLength(QUEUE_CAP);
    expect(next.queue[QUEUE_CAP - 1]).toBe(first);
    expect(next.playlistRequests).toEqual([]);
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

describe("join synchronization", () => {
  it("accepts a host sync at the live position", () => {
    let state = initialState({ videoId: first, ownerDid: "did:Host" });
    state = update(state, { action: "join" }, "Host");
    state = update(state, { action: "join" }, "Bruno");
    const synced = update(state, { action: "sync", index: 0, position: 42, playing: true }, "Host");
    expect(synced.position).toBe(42);
    expect(synced.playing).toBe(true);
  });

  it("accepts the fallback responder but not another listener", () => {
    let state = initialState({ videoId: first, ownerDid: "did:Host" });
    state = update(state, { action: "join" }, "Host");
    state = update(state, { action: "join" }, "Bob");
    state = update(state, { action: "join" }, "Carol");
    state = { ...state, members: new Map([["did:Bob", "Bob"], ["did:Carol", "Carol"]]) };
    expect(update(state, { action: "sync", index: 0, position: 33, playing: true }, "Bob").position).toBe(33);
    expect(update(state, { action: "sync", index: 0, position: 99, playing: true }, "Carol")).toBe(state);
  });

  it("tracks an authenticated resync request and its targeted host response", () => {
    let state = initialState({ videoId: first, ownerDid: "did:Host" });
    state = update(state, { action: "join" }, "Host");
    state = update(state, { action: "join" }, "Bruno");
    state = update(
      state,
      {
        action: "resync",
        requestId: "request-123",
        requesterDid: "did:Bruno",
      },
      "Bruno"
    );
    expect(state.syncRequest).toEqual({
      id: "request-123",
      requesterDid: "did:Bruno",
    });

    state = update(
      state,
      {
        action: "sync",
        index: 0,
        position: 91,
        duration: 205,
        playing: true,
        requestId: "request-123",
        targetDid: "did:Bruno",
      },
      "Host"
    );
    expect(state.position).toBe(91);
    expect(state.syncRequest).toBeUndefined();
    expect(state.syncResponse).toEqual({
      id: "request-123",
      targetDid: "did:Bruno",
      duration: 205,
    });
  });

  it("rejects a resync request that impersonates another member", () => {
    let state = initialState({ videoId: first, ownerDid: "did:Host" });
    state = update(state, { action: "join" }, "Host");
    state = update(state, { action: "join" }, "Bruno");
    expect(
      update(
        state,
        {
          action: "resync",
          requestId: "request-123",
          requesterDid: "did:Host",
        },
        "Bruno"
      )
    ).toBe(state);
  });
});

describe("a card that names no owner is inert, not unowned", () => {
  // cardData is peer-supplied. Two gates used to read "if there is an owner,
  // check the sender against it", which behaves as "skip the check when
  // there is not" - so a forged card omitting ownerDid let any peer disband
  // the party and mutate its queue.
  const forged = () => initialState({ videoId: first });

  it("has no owner and no members", () => {
    expect(forged().ownerDid).toBe("");
    expect(forged().members.size).toBe(0);
  });

  it("cannot be disbanded by a passer-by", () => {
    const after = update(forged(), { action: "close" }, "Mallory");
    expect(after.closed).toBe(true); // born closed
    // What matters is that Mallory did not do it: the state is untouched.
    expect(after).toEqual(forged());
  });

  it("cannot have its queue mutated by a passer-by", () => {
    const after = update(forged(), { action: "add", videoId: second }, "Mallory");
    expect(after.queue).toEqual(forged().queue);
  });

  it("cannot be joined into existence", () => {
    const after = update(forged(), { action: "join" }, "Mallory");
    expect(after.members.size).toBe(0);
  });
});

describe("a properly owned party still works", () => {
  const owned = () =>
    initialState({ videoId: first, ownerDid: "did:Alice" });

  it("seats the owner as a member", () => {
    expect(owned().closed).toBe(false);
    expect(owned().members.has("did:Alice")).toBe(true);
  });

  it("lets the owner disband it", () => {
    expect(update(owned(), { action: "close" }, "Alice").closed).toBe(true);
  });

  it("does not let anybody else disband it", () => {
    expect(update(owned(), { action: "close" }, "Mallory").closed).toBe(false);
  });

  it("lets a member queue a track once they have joined", () => {
    const joined = update(owned(), { action: "join" }, "Bob");
    const after = update(joined, { action: "add", videoId: second }, "Bob");
    expect(after.queue).toContain(second);
  });

  it("still turns away a stranger who never joined", () => {
    const after = update(owned(), { action: "add", videoId: second }, "Mallory");
    expect(after.queue).not.toContain(second);
  });
});

describe("seekTarget", () => {
  it("clamps a rewind at zero and a nudge at one second before the end", () => {
    expect(seekTarget(4, -10, 300)).toBe(0);
    expect(seekTarget(295, 10, 300)).toBe(299);
    expect(seekTarget(100, 10, 300)).toBe(110);
    expect(seekTarget(100, -10, 300)).toBe(90);
  });

  it("does not cap when the duration is unknown", () => {
    expect(seekTarget(100, 10, 0)).toBe(110);
  });
});
