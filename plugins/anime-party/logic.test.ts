import { describe, expect, it } from "vitest";
import {
  ADD_BATCH,
  initialState,
  QUEUE_CAP,
  reduce,
  SEARCH_CAP,
  seekTarget,
  stateTick,
  syncResponder,
  syncResponderFor,
  type AnimeState,
} from "./logic";
import { IMAGE_HOST_PREFIX, type Episode, type Show } from "./anidb";

const ctx = (name = "Alice") => ({
  senderDid: `did:${name}`,
  senderName: name,
  updateId: "update-1",
  lamport: 1,
  ephemeral: false,
});

const show: Show = {
  id: "bocchi-the-rock-729",
  title: "Bocchi the Rock!",
  image: "https://cdn.xlsbox.com/poster/small/1782735600/729.jpg",
};
const other: Show = {
  id: "hitoribocchi-no-marumaru-seikatsu-2248",
  title: "Hitoribocchi no Marumaru Seikatsu",
  image: null,
};

const ep = (n: number): Episode => ({ id: 43599 + n, number: n });

function update(state: AnimeState, data: unknown, name = "Alice") {
  return reduce(state, { data }, ctx(name));
}

/**
 * A party as one is actually created: with an owner, on a picked show.
 *
 * An ownerless card is not a party with no host, it is a party nobody can
 * be shown to own - and it used to wave every action through, which is what
 * the "names no owner" block below covers.
 */
function party(data: Record<string, unknown> = {}): AnimeState {
  return initialState({ show, ownerDid: "did:Alice", ...data });
}

/** The same party, seeded with a queue the way `add` would have. */
function watching(numbers: number[], data: Record<string, unknown> = {}) {
  const seeded = party(data);
  return update(seeded, { action: "add", episodes: numbers.map(ep) });
}

describe("initialState", () => {
  it("starts an unpicked party from a search", () => {
    const state = initialState({
      query: "bocchi",
      results: [show, other],
      ownerDid: "did:Alice",
    });
    expect(state.query).toBe("bocchi");
    expect(state.results).toEqual([show, other]);
    expect(state.show).toBeNull();
    expect(state.queue).toEqual([]);
    expect(state.currentIndex).toBeNull();
    expect(state.playing).toBe(false);
    expect(state.notConfigured).toBe(false);
    expect(state.members).toEqual(new Map([["did:Alice", "Host"]]));
  });

  it("starts a picked party from a pasted show url and drops the candidates", () => {
    const state = initialState({
      show,
      results: [other],
      ownerDid: "did:Alice",
    });
    expect(state.show).toEqual(show);
    // Once a show is picked the candidate list is dead weight everywhere.
    expect(state.results).toEqual([]);
  });

  it("carries the not-configured flag the command sets on a 204", () => {
    expect(
      initialState({ query: "bocchi", results: [], notConfigured: true, ownerDid: "did:A" })
        .notConfigured
    ).toBe(true);
    expect(party({ notConfigured: "yes" }).notConfigured).toBe(false);
  });

  it("validates every field of a forged payload", () => {
    const state = initialState({
      query: "x".repeat(500),
      ownerDid: "did:Alice",
      results: [
        { id: "Bad-Case-1", title: "t", image: null }, // id not a slug
        { id: "no-digits", title: "t", image: null },
        { id: "ok-1", title: "", image: null }, // empty title
        { id: "ok-2", title: "x".repeat(300), image: null }, // title too long
        { id: "ok-3", title: "t", image: "/img/placeholder.svg" }, // relative
        { id: "ok-4", title: "t", image: "http://insecure/a.jpg" },
        { id: "ok-5", title: "t", image: 7 },
        // https, but not the provider's poster CDN: a url every member's
        // browser and OS media surface would fetch is a beacon, so the host
        // is pinned rather than merely required to be secure.
        { id: "ok-6", title: "t", image: "https://beacon.example/a.jpg" },
        { id: "ok-7", title: "t", image: "https://cdn.xlsbox.com.evil/a.jpg" },
        null,
        "nope",
        { id: "good-1", title: "Good", image: `${IMAGE_HOST_PREFIX}a.jpg` },
        { id: "good-1", title: "Dupe", image: null },
      ],
      show: { id: "not a slug", title: "t", image: null },
    });
    expect(state.query).toBe(""); // over the 100 char cap
    expect(state.show).toBeNull();
    expect(state.results).toEqual([
      { id: "good-1", title: "Good", image: `${IMAGE_HOST_PREFIX}a.jpg` },
    ]);
  });

  it("caps a forged results list at SEARCH_CAP", () => {
    const results = Array.from({ length: SEARCH_CAP + 20 }, (_, i) => ({
      id: `show-${i}`,
      title: "T",
      image: null,
    }));
    expect(initialState({ results, ownerDid: "did:A" }).results).toHaveLength(
      SEARCH_CAP
    );
  });
});

describe("search", () => {
  it("replaces the query and results while nothing is picked", () => {
    const state = update(
      initialState({ query: "boc", results: [], ownerDid: "did:Alice" }),
      { action: "search", query: "bocchi", results: [show, other] }
    );
    expect(state.query).toBe("bocchi");
    expect(state.results).toEqual([show, other]);
    expect(state.activity.at(-1)).toEqual({
      senderName: "Alice",
      action: "searched",
      episode: null,
    });
  });

  it("is refused once a show is picked", () => {
    const picked = party();
    expect(
      update(picked, { action: "search", query: "something else", results: [other] })
    ).toBe(picked);
  });

  it("refuses an empty or oversized query", () => {
    const open = initialState({ ownerDid: "did:Alice" });
    expect(update(open, { action: "search", query: "", results: [] })).toBe(open);
    expect(
      update(open, { action: "search", query: "x".repeat(101), results: [] })
    ).toBe(open);
  });

  it("is refused from a stranger", () => {
    const open = initialState({ ownerDid: "did:Alice" });
    expect(
      update(open, { action: "search", query: "bocchi", results: [show] }, "Mallory")
    ).toBe(open);
  });
});

describe("pick-show", () => {
  it("picks a candidate and clears the rest", () => {
    const open = initialState({
      query: "bocchi",
      results: [show, other],
      ownerDid: "did:Alice",
    });
    const picked = update(open, { action: "pick-show", show: other });
    expect(picked.show).toEqual(other);
    expect(picked.results).toEqual([]);
    expect(picked.activity.at(-1)).toEqual({
      senderName: "Alice",
      action: "picked",
      episode: null,
    });
  });

  it("can be re-picked until something is queued, never after", () => {
    const once = update(initialState({ ownerDid: "did:Alice" }), {
      action: "pick-show",
      show,
    });
    const twice = update(once, { action: "pick-show", show: other });
    expect(twice.show).toEqual(other);

    const queued = update(twice, { action: "add", episodes: [ep(1)] });
    expect(update(queued, { action: "pick-show", show })).toBe(queued);
  });

  it("refuses a forged show", () => {
    const open = initialState({ ownerDid: "did:Alice" });
    expect(
      update(open, { action: "pick-show", show: { id: "nope", title: "t", image: null } })
    ).toBe(open);
    expect(update(open, { action: "pick-show", show: null })).toBe(open);
  });
});

describe("add", () => {
  it("queues episodes and starts an idle party on the first one", () => {
    const state = update(party(), {
      action: "add",
      episodes: [ep(1), ep(2), ep(3)],
    });
    expect(state.queue).toEqual([ep(1), ep(2), ep(3)]);
    expect(state.currentIndex).toBe(0);
    expect(state.playing).toBe(true);
    expect(state.activity.at(-1)).toEqual({
      senderName: "Alice",
      action: "added",
      episode: 1,
    });
  });

  it("appends to a playing party without disturbing it", () => {
    const playing = watching([1, 2]);
    const more = update(playing, { action: "add", episodes: [ep(3)] });
    expect(more.queue).toHaveLength(3);
    expect(more.currentIndex).toBe(0);
  });

  it("starts the party on the first episode that actually landed", () => {
    // Everything the sender offered is already queued except one, and the
    // party is idle: it must start on what arrived, not on slot 0.
    const seeded = { ...watching([1, 2]), currentIndex: null, playing: false };
    const state = update(seeded, {
      action: "add",
      episodes: [ep(1), ep(2), ep(3)],
    });
    expect(state.queue).toHaveLength(3);
    expect(state.currentIndex).toBe(2);
    expect(state.playing).toBe(true);
  });

  it("ignores ids already in the queue instead of rejecting the batch", () => {
    const state = update(watching([1, 2]), {
      action: "add",
      episodes: [ep(1), ep(2), ep(3), ep(3)],
    });
    expect(state.queue.map((e) => e.number)).toEqual([1, 2, 3]);
  });

  it("is a no-op when everything offered is a duplicate", () => {
    const playing = watching([1, 2]);
    expect(update(playing, { action: "add", episodes: [ep(1), ep(2)] })).toBe(
      playing
    );
  });

  it("requires a picked show", () => {
    const open = initialState({ query: "bocchi", ownerDid: "did:Alice" });
    expect(update(open, { action: "add", episodes: [ep(1)] })).toBe(open);
  });

  it("drops malformed episodes and non-array payloads", () => {
    const base = party();
    const state = update(base, {
      action: "add",
      episodes: [
        { id: 0, number: 1 },
        { id: -1, number: 1 },
        { id: 2 ** 31, number: 1 },
        { id: 1.5, number: 1 },
        { id: 5, number: -1 },
        { id: 6, number: 1.5 },
        { id: "7", number: 1 },
        null,
        ep(9),
      ],
    });
    expect(state.queue).toEqual([ep(9)]);
    expect(update(base, { action: "add", episodes: "all of them" })).toBe(base);
  });

  it("takes at most ADD_BATCH episodes from one update", () => {
    const many = Array.from({ length: ADD_BATCH + 20 }, (_, i) => ep(i + 1));
    const state = update(party(), { action: "add", episodes: many });
    expect(state.queue).toHaveLength(ADD_BATCH);
    expect(state.queue.at(-1)).toEqual(ep(ADD_BATCH));
  });

  it("never grows the queue past QUEUE_CAP", () => {
    const full = {
      ...party(),
      queue: Array.from({ length: QUEUE_CAP }, (_, i) => ep(i + 1)),
      currentIndex: 0,
      playing: true,
    } as AnimeState;
    expect(update(full, { action: "add", episodes: [ep(999)] })).toBe(full);

    const nearlyFull = {
      ...full,
      queue: full.queue.slice(0, QUEUE_CAP - 1),
    } as AnimeState;
    const topped = update(nearlyFull, {
      action: "add",
      episodes: [ep(900), ep(901)],
    });
    expect(topped.queue).toHaveLength(QUEUE_CAP);
    expect(topped.queue.at(-1)).toEqual(ep(900));
  });

  it("is refused from a stranger who never joined", () => {
    const base = party();
    expect(update(base, { action: "add", episodes: [ep(1)] }, "Mallory")).toBe(
      base
    );
  });
});

describe("anime reducer", () => {
  it("records the verified actor on a member's action", () => {
    const state = update(
      update(watching([1]), { action: "join" }, "Bruno"),
      { action: "add", episodes: [ep(2)] },
      "Bruno"
    );
    expect(state.queue.map((e) => e.number)).toEqual([1, 2]);
    expect(state.activity.slice(-2)).toEqual([
      { senderName: "Bruno", action: "joined", episode: null },
      { senderName: "Bruno", action: "added", episode: 2 },
    ]);
  });

  it("removes the selected entry and selects the remaining entry", () => {
    const seated = {
      ...watching([1, 2]),
      position: 25,
    } as AnimeState;
    const withCarla = {
      ...seated,
      members: new Map([...seated.members, ["did:Carla", "Carla"]]),
    } as AnimeState;
    const state = update(withCarla, { action: "remove", index: 0 }, "Carla");
    expect(state.queue.map((e) => e.number)).toEqual([2]);
    expect(state.currentIndex).toBe(0);
    expect(state.position).toBe(0);
    expect(state.activity.at(-1)).toEqual({
      senderName: "Carla",
      action: "removed",
      episode: 1,
    });
  });

  it("stops playback when the final entry is removed", () => {
    const state = update(watching([1]), { action: "remove", index: 0 });
    expect(state.queue).toEqual([]);
    expect(state.currentIndex).toBeNull();
    expect(state.playing).toBe(false);
  });

  it("steps forward to a new episode, growing the queue at the end", () => {
    const next = update(watching([1]), {
      action: "step",
      episode: ep(2),
      at: "end",
    });
    expect(next.queue.map((e) => e.number)).toEqual([1, 2]);
    expect(next.currentIndex).toBe(1);
    expect(next.playing).toBe(true);
    expect(next.position).toBe(0);
  });

  it("steps to an already-queued episode instead of duplicating it", () => {
    const moved = update(watching([1, 2]), {
      action: "step",
      episode: ep(2),
      at: "end",
    });
    expect(moved.queue.map((e) => e.number)).toEqual([1, 2]);
    expect(moved.currentIndex).toBe(1);
  });

  it("steps backward to an earlier episode, growing the queue at the front", () => {
    const prev = update(watching([2]), {
      action: "step",
      episode: ep(1),
      at: "start",
    });
    expect(prev.queue.map((e) => e.number)).toEqual([1, 2]);
    expect(prev.currentIndex).toBe(0);
    expect(prev.position).toBe(0);
  });

  it("starts an idle party playing on a step", () => {
    const started = update(party(), {
      action: "step",
      episode: ep(1),
      at: "end",
    });
    expect(started.currentIndex).toBe(0);
    expect(started.playing).toBe(true);
  });

  it("ignores a step past the queue cap and a malformed or foreign one", () => {
    const full = {
      ...party(),
      queue: Array.from({ length: QUEUE_CAP }, (_, i) => ep(i + 1)),
      currentIndex: 0,
    } as AnimeState;
    expect(
      update(full, { action: "step", episode: ep(QUEUE_CAP + 1), at: "end" })
    ).toBe(full);
    const s = watching([1]);
    expect(
      update(s, { action: "step", episode: { id: -1, number: 2 }, at: "end" })
    ).toBe(s);
    expect(
      update(s, { action: "step", episode: ep(2), at: "end" }, "Stranger")
    ).toBe(s);
  });

  it("persists valid playback intent and rejects invalid positions", () => {
    const started = update(watching([1]), { action: "play", position: 12 });
    expect(started.playing).toBe(true);
    expect(started.position).toBe(12);
    const seated = {
      ...started,
      members: new Map([...started.members, ["did:Dana", "Dana"]]),
    } as AnimeState;
    const paused = update(seated, { action: "pause", position: 18 }, "Dana");
    expect(paused.playing).toBe(false);
    expect(paused.position).toBe(18);
    expect(paused.activity.at(-1)).toEqual({
      senderName: "Dana",
      action: "paused",
      episode: 1,
    });
    expect(update(paused, { action: "seek", position: -1 })).toBe(paused);
    expect(update(paused, { action: "seek", position: Number.NaN })).toBe(paused);
  });

  it("selects a numbered queue entry and closes a prior party", () => {
    const selected = update(watching([1, 2]), { action: "select", index: 1 });
    expect(selected.currentIndex).toBe(1);
    expect(selected.position).toBe(0);
    expect(selected.activity.at(-1)?.episode).toBe(2);
    expect(update(selected, { action: "close" }).closed).toBe(true);
  });

  it("removes a disconnected listener and closes when the host disconnects", () => {
    const owner = "Host";
    const member = "Bruno";
    const joined = update(
      initialState({ show, ownerDid: "did:Host" }),
      { action: "join" },
      member
    );
    const pruned = update(joined, { action: "prune", did: "did:Bruno" }, owner);
    expect(pruned.members.has("did:Bruno")).toBe(false);

    const closed = update(joined, { action: "host-left" }, member);
    expect(closed.closed).toBe(true);
    expect(closed.playing).toBe(false);
  });

});

describe("syncResponder", () => {
  it("never picks the newest member and prefers the owner", () => {
    let s = initialState({ show, ownerDid: "did:Owner" });
    s = update(s, { action: "join" }, "Owner");
    expect(syncResponder(s)).toBeNull(); // alone: nobody to sync you

    s = update(s, { action: "join" }, "Bob");
    // Bob just joined: the owner answers, never Bob himself.
    expect(syncResponder(s)).toBe("did:Owner");

    s = update(s, { action: "join" }, "Carol");
    expect(syncResponder(s)).toBe("did:Owner");
  });

  it("falls back to the longest-standing member when the owner is gone", () => {
    let s = initialState({ show, ownerDid: "did:Owner" });
    s = update(s, { action: "join" }, "Owner");
    s = update(s, { action: "join" }, "Bob");
    s = update(s, { action: "join" }, "Carol");
    // Owner leaves: the reducer forbids an owner "leave", so simulate the
    // members map the fold would hold without them.
    const members = new Map(s.members);
    members.delete("did:Owner");
    expect(syncResponder({ ...s, members })).toBe("did:Bob");
  });
});

describe("join synchronization", () => {
  const seeded = () => {
    let s = update(
      initialState({ show, ownerDid: "did:Host" }),
      { action: "add", episodes: [ep(1)] },
      "Host"
    );
    s = update(s, { action: "join" }, "Bruno");
    return s;
  };

  it("accepts a host sync at the live position", () => {
    const synced = update(
      seeded(),
      { action: "sync", index: 0, position: 42, playing: true },
      "Host"
    );
    expect(synced.position).toBe(42);
    expect(synced.playing).toBe(true);
  });

  it("accepts the fallback responder but not another listener", () => {
    let state = update(seeded(), { action: "join" }, "Carol");
    state = {
      ...state,
      members: new Map([
        ["did:Bruno", "Bruno"],
        ["did:Carol", "Carol"],
      ]),
    };
    expect(
      update(state, { action: "sync", index: 0, position: 33, playing: true }, "Bruno")
        .position
    ).toBe(33);
    expect(
      update(state, { action: "sync", index: 0, position: 99, playing: true }, "Carol")
    ).toBe(state);
  });

  it("tracks an authenticated resync request and its targeted host response", () => {
    let state = update(
      seeded(),
      { action: "resync", requestId: "request-123", requesterDid: "did:Bruno" },
      "Bruno"
    );
    expect(state.syncRequest).toEqual({
      id: "request-123",
      requesterDid: "did:Bruno",
    });
    expect(state.activity.at(-1)).toEqual({
      senderName: "Bruno",
      action: "sync requested",
      episode: 1,
    });

    state = update(
      state,
      {
        action: "sync",
        index: 0,
        position: 91,
        duration: 1420,
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
      duration: 1420,
    });
  });

  it("rejects a resync request that impersonates another member", () => {
    const state = seeded();
    expect(
      update(
        state,
        { action: "resync", requestId: "request-123", requesterDid: "did:Host" },
        "Bruno"
      )
    ).toBe(state);
  });
});

describe("host refresh resync", () => {
  const seeded = () => {
    let s = watching([1]);
    s = update(s, { action: "join" }, "Bob");
    return s;
  };

  it("lets a non-owner answer the owner's own resync request", () => {
    let s = update(seeded(), {
      action: "resync",
      requestId: "owner-refresh-1",
      requesterDid: "did:Alice",
    });
    expect(syncResponderFor(s, "did:Alice")).toBe("did:Bob");
    s = update(
      s,
      {
        action: "sync",
        index: 0,
        position: 123,
        playing: true,
        atMs: 1700000000000,
        requestId: "owner-refresh-1",
        targetDid: "did:Alice",
      },
      "Bob"
    );
    expect(s.position).toBe(123);
    expect(s.syncResponse?.targetDid).toBe("did:Alice");
  });

  it("still refuses a sync from a member who is not the responder", () => {
    let s = update(seeded(), { action: "join" }, "Carol");
    s = update(s, {
      action: "resync",
      requestId: "owner-refresh-2",
      requesterDid: "did:Alice",
    });
    // Owner excluded from their own request, so the responder is Bob;
    // Carol cannot impersonate him.
    const fromCarol = update(
      s,
      {
        action: "sync",
        index: 0,
        position: 55,
        playing: true,
        atMs: 1700000000000,
        requestId: "owner-refresh-2",
        targetDid: "did:Alice",
      },
      "Carol"
    );
    expect(fromCarol.position).not.toBe(55);
  });
});

describe("a card that names no owner is inert, not unowned", () => {
  // cardData is peer-supplied. Two gates used to read "if there is an owner,
  // check the sender against it", which behaves as "skip the check when
  // there is not" - so a forged card omitting ownerDid let any peer disband
  // the party and mutate its queue.
  const forged = () => initialState({ show });

  it("has no owner and no members, and is born closed", () => {
    expect(forged().ownerDid).toBe("");
    expect(forged().members.size).toBe(0);
    expect(forged().closed).toBe(true);
  });

  it("cannot be disbanded by a passer-by", () => {
    const after = update(forged(), { action: "close" }, "Mallory");
    expect(after.closed).toBe(true); // born closed
    // What matters is that Mallory did not do it: the state is untouched.
    expect(after).toEqual(forged());
  });

  it("cannot have its queue mutated by a passer-by", () => {
    expect(
      update(forged(), { action: "add", episodes: [ep(1)] }, "Mallory").queue
    ).toEqual([]);
  });

  it("cannot be joined into existence", () => {
    expect(update(forged(), { action: "join" }, "Mallory").members.size).toBe(0);
  });
});

describe("a properly owned party still works", () => {
  it("seats the owner as a member", () => {
    expect(party().closed).toBe(false);
    expect(party().members.has("did:Alice")).toBe(true);
  });

  it("lets the owner disband it and nobody else", () => {
    expect(update(party(), { action: "close" }, "Alice").closed).toBe(true);
    expect(update(party(), { action: "close" }, "Mallory").closed).toBe(false);
  });

  it("lets a member queue an episode once they have joined", () => {
    const joined = update(party(), { action: "join" }, "Bob");
    expect(
      update(joined, { action: "add", episodes: [ep(4)] }, "Bob").queue
    ).toEqual([ep(4)]);
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

describe("watch ticks", () => {
  const base = () => update(watching([1, 2]), { action: "join" }, "Owner");

  it("stores the sender clock and author on a position-bearing action", () => {
    const s = update(base(), {
      action: "seek",
      position: 42,
      atMs: 1_700_000_000_000,
    });
    expect(s.position).toBe(42);
    expect(s.tickAtMs).toBe(1_700_000_000_000);
    expect(s.tickBy).toBe("did:Alice");
    expect(stateTick(s)).toEqual({
      paused: !s.playing,
      position: 42,
      atMs: 1_700_000_000_000,
      rate: 1,
      seq: 0,
    });
  });

  it("treats a missing or absurd atMs as no tick", () => {
    for (const atMs of [undefined, "soon", -5, 1e14, Number.NaN]) {
      const s = update(base(), { action: "seek", position: 9, atMs });
      expect(s.position).toBe(9);
      expect(s.tickAtMs).toBeNull();
      expect(stateTick(s)).toBeNull();
    }
  });

  it("carries the tick on play, pause and sync too", () => {
    for (const data of [
      { action: "play", position: 5, atMs: 1_700_000_000_000 },
      { action: "pause", position: 5, atMs: 1_700_000_000_000 },
    ]) {
      const s = update(base(), data);
      expect(s.tickAtMs).toBe(1_700_000_000_000);
      expect(s.tickBy).toBe("did:Alice");
    }
    // sync needs a responder, which needs a second member (the newest
    // member is the joiner being synced and never responds).
    const twoMembers = update(base(), { action: "join" }, "Bruno");
    const synced = update(twoMembers, {
      action: "sync",
      index: 0,
      position: 5,
      playing: true,
      atMs: 1_700_000_000_000,
    });
    expect(synced.tickAtMs).toBe(1_700_000_000_000);
    expect(synced.tickBy).toBe("did:Alice");
  });

  it("keeps the tick when a remove does not touch the playing episode", () => {
    const s = update(base(), {
      action: "seek",
      position: 42,
      atMs: 1_700_000_000_000,
    });
    const after = update(s, { action: "remove", index: 1 });
    expect(after.queue).toHaveLength(1);
    expect(after.tickAtMs).toBe(1_700_000_000_000);
    // ...and clears it when the CURRENT episode is removed (position resets).
    const s2 = update(s, { action: "remove", index: 0 });
    expect(s2.position).toBe(0);
    expect(s2.tickAtMs).toBeNull();
  });

  it("clears the tick on a track change - position 0 has no sender clock", () => {
    const ticked = update(base(), {
      action: "seek",
      position: 42,
      atMs: 1_700_000_000_000,
    });
    const skipped = update(ticked, {
      action: "step",
      episode: ep(3),
      at: "end",
    });
    expect(skipped.tickAtMs).toBeNull();
    expect(skipped.tickBy).toBeNull();
  });
});

