import { describe, expect, it } from "vitest";
import { cardTypefaceUrl } from "../cardPictures";
import { PRODUCTION_CSP } from "../csp";
import {
  FORBIDDEN_SANDBOX_TOKENS,
  FRAME_ALLOW,
  FRAME_CSP,
  FRAME_FOCUS_BLINK_FEATURE,
  FRAME_FONT_SOURCE,
  FRAME_IMAGE_SOURCE,
  FRAME_SANDBOX,
  FRAME_SANDBOX_TOKENS,
  frameCsp,
  NETWORK_CSP_DIRECTIVES,
  panelFrameCsp,
  panelScriptSources,
  SRCDOC_FONT_SOURCE,
  SRCDOC_FRAME_CSP,
  STRUCTURALLY_IMPOSSIBLE,
} from "./containment";
import { frameFontUrl } from "./frameDocument";
import { FRAME_BRIDGE_SHA256 } from "./frameScript";
import { type PluginManifestInput, parsePluginManifest, retiredGrantWords } from "./manifest";

/**
 * One assertion per entry of the "structurally impossible" ledger (D6).
 * These are the things the relaxed capability posture must leave exactly
 * as impossible as before; a change here is a change to the trust boundary.
 */

const base: PluginManifestInput = {
  id: "probe",
  name: "Probe",
  version: "0.0.1",
  contributes: {},
  capabilities: {},
};

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) map.set(name, sources);
  }
  return map;
}

describe("the plugin frame boundary", () => {
  it("sandboxes with allow-scripts alone", () => {
    expect([...FRAME_SANDBOX_TOKENS]).toEqual(["allow-scripts"]);
    expect(FRAME_SANDBOX).toBe("allow-scripts");
    for (const token of FORBIDDEN_SANDBOX_TOKENS) {
      expect(FRAME_SANDBOX.split(" ")).not.toContain(token);
    }
  });

  it("lets a frame's policy only take away, and takes away focus without the captain's gesture", () => {
    // `allow` is a permissions policy: `<feature> <allowlist>` per directive.
    // Every directive is 'none', so the attribute grants a frame nothing it
    // would not have, and focus without a gesture is the one it takes away.
    const policy = FRAME_ALLOW.split(";").map((directive) => directive.trim().split(/\s+/));
    expect(policy.map(([feature]) => feature)).toEqual(["focus-without-user-activation"]);
    for (const [, ...allowlist] of policy) expect(allowlist).toEqual(["'none'"]);
    // The policy is honoured only with Chromium's feature on (src/main/app.ts).
    expect(FRAME_FOCUS_BLINK_FEATURE).toBe("BlockingFocusWithoutUserActivation");
  });

  it("keeps the frame CSP at default-src 'none'; the only network-shaped directives are fonts from the host's own scheme and inline images", () => {
    for (const [csp, fonts] of [
      [FRAME_CSP, FRAME_FONT_SOURCE],
      [frameCsp(["sha256-template"]), FRAME_FONT_SOURCE],
      [SRCDOC_FRAME_CSP, SRCDOC_FONT_SOURCE],
    ] as const) {
      const frame = directives(csp);
      expect(frame.get("default-src")).toEqual(["'none'"]);
      for (const directive of NETWORK_CSP_DIRECTIVES) {
        if (directive === "font-src") {
          expect(frame.get(directive)).toEqual([fonts]);
        } else if (directive === "img-src") {
          // Images the document carries inline (`data:` names no host,
          // captain decision 2026-09-15) and the host's own scheme, which
          // serves verified card pictures (card pictures, phase 2). Neither
          // opens a network path; any other source here would.
          expect(frame.get(directive)).toEqual(["data:", "app-frame:"]);
        } else {
          expect(frame.has(directive), directive).toBe(false);
        }
      }
      expect(frame.get("style-src")).toEqual(["'unsafe-inline'"]);
    }
    expect(FRAME_FONT_SOURCE).toBe("app-frame:");
    expect(FRAME_IMAGE_SOURCE).toBe("data: app-frame:");
    // A card body runs the bridge alone; a template mount adds exactly the
    // hashes the host computed for that mount's script.
    expect(directives(FRAME_CSP).get("script-src")).toEqual([`'${FRAME_BRIDGE_SHA256}'`]);
    expect(directives(frameCsp(["sha256-template"])).get("script-src")).toEqual([
      `'${FRAME_BRIDGE_SHA256}'`,
      "'sha256-template'",
    ]);
  });

  // INF-145's review, decided for the captain's security ask: a project font
  // draws only on the mount vehicle, so a srcdoc body's policy admits the
  // design system's typefaces and no kept font, however its address is spelled.
  it("lets a srcdoc card body load the design system's typefaces and no kept project font", () => {
    expect(SRCDOC_FONT_SOURCE).toBe("app-frame://fonts");
    expect(frameFontUrl("spacegrotesk-latin.woff2").startsWith(`${SRCDOC_FONT_SOURCE}/`)).toBe(
      true,
    );
    expect(cardTypefaceUrl(`t1-${"0".repeat(32)}`, "woff2").startsWith(SRCDOC_FONT_SOURCE)).toBe(
      false,
    );
    // Only the font source differs from the frame policy a mount is served with.
    const srcdoc = directives(SRCDOC_FRAME_CSP);
    const frame = directives(FRAME_CSP);
    srcdoc.delete("font-src");
    frame.delete("font-src");
    expect(srcdoc).toEqual(frame);
  });

  it("gives a panel mount module sources on the host's own scheme - the lib and its own host - and nothing else", () => {
    // The frame realm (one plugin vehicle, Phase A item 4) is the one frame
    // policy that names a script source instead of a hash: every other
    // directive is the frame policy's, network-capable ones included.
    const panel = directives(panelFrameCsp(["sha256-importmap"], "panel-abc"));
    expect(panel.get("default-src")).toEqual(["'none'"]);
    for (const directive of NETWORK_CSP_DIRECTIVES) {
      if (directive === "font-src") expect(panel.get(directive)).toEqual([FRAME_FONT_SOURCE]);
      else if (directive === "img-src")
        expect(panel.get(directive)).toEqual(["data:", "app-frame:"]);
      else expect(panel.has(directive), directive).toBe(false);
    }
    expect(panel.get("style-src")).toEqual(["'unsafe-inline'"]);
    expect(panel.get("script-src")).toEqual([
      `'${FRAME_BRIDGE_SHA256}'`,
      "'sha256-importmap'",
      "app-frame://lib/",
      "app-frame://panel-abc/",
    ]);
    // Paths of the host's own scheme, never the scheme as a whole, never a
    // network origin, and never a way to run a string as code.
    expect(panelScriptSources("panel-abc")).toEqual(["app-frame://lib/", "app-frame://panel-abc/"]);
    for (const source of panel.get("script-src") ?? []) {
      expect(source).not.toMatch(
        /^(https?:|app-frame:$|'unsafe-(inline|eval)'|'wasm-unsafe-eval')/,
      );
    }
    // Card bodies and template mounts gained nothing: every script by hash.
    for (const csp of [FRAME_CSP, frameCsp(["sha256-template"])]) {
      for (const source of directives(csp).get("script-src") ?? []) {
        expect(source).toMatch(/^'sha256-/);
      }
    }
  });

  it("leaves the app CSP without any plugin origin", () => {
    const app = directives(PRODUCTION_CSP);
    expect(app.get("default-src")).toEqual(["'none'"]);
    expect(app.get("connect-src")).toEqual(["'self'", "app-model:"]);
    // The host's own frame scheme, served in-process, is the one addition:
    // it carries template documents and fonts, never a plugin's origin.
    expect(app.get("frame-src")).toEqual(["'self'", "app-frame:"]);
    expect(app.get("font-src")).toEqual(["'self'", "app-frame:"]);
    expect(app.get("script-src")).not.toContain("'unsafe-inline'");
    // No panel code runs in the window: the old in-window panel scheme is
    // in no directive, script-src included.
    for (const [directive, sources] of app) {
      expect(sources, directive).not.toContain("app-plugin:");
    }
    for (const sources of app.values()) {
      for (const source of sources) {
        expect(source, source).not.toMatch(/^https?:/);
      }
    }
  });
});

describe("the structurally impossible ledger", () => {
  const cases: Record<(typeof STRUCTURALLY_IMPOSSIBLE)[number], () => void> = {
    "plugin code in the renderer realm or the main process": () => {
      // A manifest names no code: every key that could is refused. The
      // only scripts a frame may run are the host's hash-pinned bridge and,
      // for a template mount, the template script the host itself hashed -
      // both inside the sandboxed frame, never in the app's realm.
      for (const key of ["main", "entry", "script", "module", "preload"]) {
        expect(() => parsePluginManifest({ ...base, [key]: "index.js" })).toThrow(key);
      }
      expect(directives(FRAME_CSP).get("script-src")).toEqual([`'${FRAME_BRIDGE_SHA256}'`]);
      expect(directives(PRODUCTION_CSP).get("script-src")).not.toContain("app-frame:");
    },
    "same-origin access from a plugin frame": () => {
      expect(FRAME_SANDBOX.split(" ")).not.toContain("allow-same-origin");
      expect(() => parsePluginManifest({ ...base, sandbox: "allow-same-origin" })).toThrow(
        "sandbox",
      );
    },
    "direct IPC from a plugin frame": () => {
      // No grant names a channel; the frame's only channel is postMessage
      // to the host, which zod-parses a closed message set.
      expect(() =>
        parsePluginManifest({ ...base, capabilities: { ipc: ["inf:cards:list"] } }),
      ).toThrow("ipc");
      expect(() =>
        parsePluginManifest({ ...base, capabilities: { channels: ["inf:cards:list"] } }),
      ).toThrow("channels");
    },
    "a plugin reading another plugin's data": () => {
      // Storage is a namespaced cap with no way to name a namespace.
      expect(() =>
        parsePluginManifest({
          ...base,
          capabilities: { storage: { kv: { maxBytes: 1, namespace: "other-plugin" } } },
        }),
      ).toThrow("namespace");
    },
    "a plugin reading accounts or auth": () => {
      // Reads come from a host-pushed catalog by name; there is no grant
      // that names a store, a file, or an account.
      for (const capabilities of [
        { accounts: true },
        { auth: ["codex"] },
        { fs: ["~/.pi"] },
        { files: ["accounts/registry.json"] },
      ]) {
        expect(() => parsePluginManifest({ ...base, capabilities })).toThrow(
          Object.keys(capabilities)[0],
        );
      }
    },
    "a plugin reaching an undeclared host": () => {
      // INF-2334, the captain's "retire hosts and keys": a plugin names no
      // host at all, exact or wildcard; it reaches a service outside your
      // projects only through an integration, and the frame CSP itself
      // admits no network source.
      for (const origin of ["https://api.example.com", "https://*.example.com", "*"]) {
        expect(() =>
          parsePluginManifest({ ...base, capabilities: { net: { origins: { any: { origin } } } } }),
        ).toThrow(retiredGrantWords("net"));
      }
      expect(directives(FRAME_CSP).has("connect-src")).toBe(false);
    },
    "a plugin holding or seeing a credential": () => {
      // INF-2334: a plugin declares no key of its own; the integration's
      // connection holds the sign-in, and the plugin never sees it.
      for (const token of [
        { kind: "bearer", label: "Token" },
        { kind: "bearer", label: "Token", value: "x" },
      ]) {
        expect(() =>
          parsePluginManifest({ ...base, capabilities: { secrets: { token } } }),
        ).toThrow(retiredGrantWords("secrets"));
      }
    },
  };

  for (const entry of STRUCTURALLY_IMPOSSIBLE) {
    it(`keeps impossible: ${entry}`, () => {
      cases[entry]();
    });
  }
});
