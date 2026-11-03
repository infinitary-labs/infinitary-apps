import { DEFAULT_SAVED_KEYMAP } from "@shared/keymap";
import { frameMountUrl } from "@shared/plugins/frameDocument";
import { inject } from "vitest";
import "../helpers/browserProvided";
import { InstalledKeymap } from "../../src/main/keyboard";
import type { Answers } from "./bridge";

/**
 * The answers a fresh home gives the window (docs/testing.md, "The browser
 * layer"): the core's own, read from a real core booted once per run
 * (tests/helpers/browserFreshHome.ts), and the desktop shell's, given by the shell's own
 * code where it has a part that runs in a page. A test passes them to
 * `fakeBridge` and replaces only the answers its story changes.
 */
export function freshHome(): Answers {
  // The shell's installed keys, as main holds them for a home that changed none.
  const keymap = new InstalledKeymap({
    keymap: () => ({ saved: DEFAULT_SAVED_KEYMAP, unreadable: false }),
    setKeymap: () => {},
    subscribe: () => () => {},
  });
  let mounts = 0;
  const { plain, asked } = inject("freshHome");
  const askedAnswers = Object.fromEntries(
    Object.entries(asked).map(([channel, byRequest]) => [
      channel,
      (...request: unknown[]) => {
        const key = JSON.stringify(request);
        if (!(key in byRequest))
          throw new Error(
            `The fresh home read ${channel} only for ${Object.keys(byRequest).join(", ")}, not ${key}; add it to ASKED in tests/helpers/browserFreshHome.ts or answer it in the test`,
          );
        return byRequest[key];
      },
    ]),
  );
  return {
    ...(plain as Answers),
    ...(askedAnswers as Answers),
    "inf:keyboard:keymap": () => keymap.current(),
    "inf:keyboard:panels": (panels) => keymap.setPanels(panels),
    "inf:devices:this-mac": { role: "home", left: null },
    "inf:voice:recognizer": { where: "window" },
    // A frame's document is served over the shell's own scheme, which a page
    // cannot load: the frame mounts and stays empty, as a frame that is still loading.
    "inf:frames:mount": () => {
      mounts += 1;
      const mountId = `browser-${mounts}`;
      return { mountId, url: frameMountUrl(mountId) };
    },
    "inf:frames:unmount": { ok: true },
    // What the window tells the core at startup, accepted as the core accepts it.
    "inf:plugins:personal:mounts": { ok: true },
  };
}
