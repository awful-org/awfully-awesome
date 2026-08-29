import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import LoopButton, {
  loopButtonClass,
  loopLabelFor,
  queueButtonClass,
} from "./LoopButton.svelte";

describe("party control states", () => {
  it.each([
    ["off", "Loop Off"],
    ["track", "Loop Track"],
    ["queue", "Loop Queue"],
  ] as const)("labels %s loop mode", (mode, label) => {
    expect(loopLabelFor(mode)).toBe(label);
    const { body } = render(LoopButton, {
      props: { mode, onclick: () => {} },
    });
    expect(body).toContain(`aria-label="${label}"`);
    // The app's tooltip, not the browser's. This used to assert the native
    // `title` and so passed happily while the loop button was the last
    // control still popping an unstyled OS tooltip in the middle of the app.
    expect(body).not.toContain("title=");
  });

  it("keeps the off loop muted and active loops green", () => {
    expect(loopButtonClass("off")).toBe("border-border hover:bg-muted");
    for (const mode of ["track", "queue"] as const) {
      expect(loopButtonClass(mode)).toContain("border-green-500/50");
      expect(loopButtonClass(mode)).toContain("text-green-500");
      expect(loopButtonClass(mode)).toContain("hover:bg-green-500/10");
    }
  });

  it("uses muted queue hover until the queue is active", () => {
    expect(queueButtonClass(false)).toBe("border-border hover:bg-muted");
    expect(queueButtonClass(true)).toContain("bg-green-500/10");
    expect(queueButtonClass(true)).toContain("text-green-500");
    expect(queueButtonClass(true)).toContain("hover:bg-green-500/20");
  });
});
