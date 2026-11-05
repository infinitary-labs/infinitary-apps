import { afterEach, describe, expect, it, vi } from "vitest";
import { useShellStore } from "./store";
import { resetShell } from "./storeTestKit";

/** The look (./appearance.ts): how its saves are told and applied. */

describe("appearance saves", () => {
  const SAVED = {
    theme: "dark",
    size: 100,
    washStrength: 0,
    showCrewModelNames: true,
  } as const;

  function arrange(write: (appearance: Record<string, unknown>) => Promise<unknown>) {
    const sent: Record<string, unknown>[] = [];
    const wash: string[] = [];
    vi.stubGlobal("document", {
      documentElement: {
        style: { setProperty: (_name: string, value: string) => wash.push(value) },
      },
    });
    vi.stubGlobal("window", {
      infinitary: {
        settings: {
          getAppearance: async () => SAVED,
          setAppearance: (appearance: Record<string, unknown>) => {
            sent.push(appearance);
            return write(appearance);
          },
        },
      },
    });
    useShellStore.getState().applyAppearance(SAVED);
    return { sent, wash };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    resetShell();
  });

  it("says why a theme was refused beside Theme and shows the saved theme again", async () => {
    arrange(async () => {
      throw new Error("Could not save this setting: Locked.");
    });
    useShellStore.getState().setTheme("light");
    // The choice shows at once, as before.
    expect(useShellStore.getState().theme).toBe("light");
    await vi.waitFor(() =>
      expect(useShellStore.getState().appearanceError).toEqual({
        choice: "theme",
        message: "Could not save this setting: Locked.",
      }),
    );
    expect(useShellStore.getState().theme).toBe("dark");
  });

  it("writes the next choice over the saved look, and a saved write clears the refusal", async () => {
    let refuse = true;
    const { sent, wash } = arrange(async (appearance) => {
      if (refuse) {
        refuse = false;
        throw new Error("Could not save this setting: Locked.");
      }
      return appearance;
    });
    useShellStore.getState().setTheme("light");
    useShellStore.getState().setWashStrength(40);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // The refused light theme is never carried into the wash's write.
    expect(sent[1]).toMatchObject({ theme: "dark", washStrength: 40 });
    await vi.waitFor(() => expect(useShellStore.getState().appearanceError).toBeNull());
    expect(useShellStore.getState()).toMatchObject({ theme: "dark", washStrength: 40 });
    expect(wash.at(-1)).toBe("40%");
  });

  it("lets a push behind the window's own write give way to that write's answer", async () => {
    let answer!: (appearance: unknown) => void;
    arrange(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    useShellStore.getState().setShowCrewModelNames(false);
    await vi.waitFor(() => expect(answer).toBeDefined());
    // An echo of an older look while the write is unanswered changes nothing shown.
    useShellStore.getState().applyAppearance(SAVED);
    expect(useShellStore.getState().showCrewModelNames).toBe(false);
    answer({ ...SAVED, showCrewModelNames: false });
    await vi.waitFor(() => expect(useShellStore.getState().showCrewModelNames).toBe(false));
    useShellStore.getState().applyAppearance({ ...SAVED, theme: "light" });
    expect(useShellStore.getState()).toMatchObject({ theme: "light", showCrewModelNames: true });
  });
});
