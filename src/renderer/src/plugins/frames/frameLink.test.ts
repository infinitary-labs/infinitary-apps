import { afterEach, describe, expect, it, vi } from "vitest";
import { type FrameLinkSteps, noteDroppedLinkMessage, openFrameLink } from "./frameLink";

/**
 * A card frame's link, step by step: each step that does not open it
 * leaves one quiet line on the console saying why, and the one that does
 * says so too (FI3-1093).
 */

const PR = "https://github.com/octo/meterlab/pull/58";

function steps(overrides: Partial<FrameLinkSteps> = {}): FrameLinkSteps {
  return {
    admitted: () => true,
    whenFocused: (then) => then(),
    focusedOn: () => 'textarea "Task prompt"',
    open: vi.fn(async () => undefined),
    ...overrides,
  };
}

function lines(): string[] {
  return (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
    String(call[0]),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openFrameLink", () => {
  it("opens an address a card may open from the card on screen, once its frame holds focus", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const open = vi.fn(async () => undefined);
    openFrameLink(PR, steps({ open }));
    expect(open).toHaveBeenCalledWith(PR);
    expect(lines()).toEqual([`[infinitary] link ${PR}: opening it in the browser`]);
  });

  it("says why when the address is not one a card may open", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const open = vi.fn(async () => undefined);
    openFrameLink("file:///etc/hosts", steps({ open }));
    expect(open).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      "[infinitary] link file:///etc/hosts: not opened, it is not an address a card may open",
    ]);
  });

  it("says why when its card is not the one on screen", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const open = vi.fn(async () => undefined);
    openFrameLink(PR, steps({ admitted: () => false, open }));
    expect(open).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      `[infinitary] link ${PR}: not opened, its card is not the one on screen`,
    ]);
  });

  it("says why, and where focus was, when its frame did not hold the window's focus", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const open = vi.fn(async () => undefined);
    openFrameLink(PR, steps({ whenFocused: (_then, otherwise) => otherwise(), open }));
    expect(open).not.toHaveBeenCalled();
    expect(lines()).toEqual([
      `[infinitary] link ${PR}: not opened, its frame did not hold the window's focus (focus was on textarea "Task prompt")`,
    ]);
  });

  it("says why when the system could not open it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const failed = Promise.reject(new Error("no browser"));
    openFrameLink(PR, steps({ open: () => failed }));
    await failed.catch(() => {});
    await Promise.resolve();
    expect(lines()).toEqual([
      `[infinitary] link ${PR}: opening it in the browser`,
      `[infinitary] link ${PR}: not opened, the system could not open it: no browser`,
    ]);
  });
});

describe("noteDroppedLinkMessage", () => {
  it("names a dropped link message with its address, and nothing else", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    noteDroppedLinkMessage({ fm: 2, type: "link", href: PR }, "its frame is gone");
    noteDroppedLinkMessage({ fm: 2, type: "link" }, "its message is not one the bridge sends");
    noteDroppedLinkMessage({ fm: 2, type: "resize", height: 1 }, "its frame is gone");
    noteDroppedLinkMessage("noise", "its frame is gone");
    expect(lines()).toEqual([
      `[infinitary] link ${PR}: not opened, its frame is gone`,
      "[infinitary] link null: not opened, its message is not one the bridge sends",
    ]);
  });
});
