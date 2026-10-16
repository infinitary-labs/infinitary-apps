import { type PluginManifest, parsePluginManifest } from "@shared/plugins/manifest";
import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { type PluginBindings, sidePanelBinding } from "../../plugins/contributions";
import type { PluginHost } from "../../plugins/host";
import { UiKitGallery } from "./UiKitGallery";

/**
 * The design fixture seam: it mounts the library gallery as a real side
 * panel AND, outside any panel, at the same width, so the promise personal
 * panels rest on can be seen component by component: a component renders
 * the same wherever it is used, so a panel built from `@infinitary/ui` cannot
 * drift from the app.
 *
 * The panel is registered through the ordinary `registerPlugin` door with a
 * Tier-1 body, which is exactly how a personal panel is mounted
 * (`personal/personalPlugins.ts` + `PersonalPanelBody`): same chrome, same
 * body region, same inherited style.
 *
 * It is OFF unless this window's own `localStorage` asks for it, which no
 * product path ever writes - nothing here reaches a captain's app.
 */

export const DESIGN_FIXTURES_KEY = "infinitary.designFixtures";
/** The same switch under Firstmate 3000's name, from before the Infinitary rename. */
const OLDER_DESIGN_FIXTURES_KEY = "fm3000.designFixtures";

export function designFixturesEnabled(): boolean {
  try {
    return [DESIGN_FIXTURES_KEY, OLDER_DESIGN_FIXTURES_KEY].some(
      (key) => window.localStorage.getItem(key) === "ui-kit",
    );
  } catch {
    // Storage can be unavailable; a fixture seam never breaks a boot.
    return false;
  }
}

const manifest: PluginManifest = parsePluginManifest({
  id: "firstmate-design-fixtures",
  name: "Design fixtures",
  version: "1.0.0",
  contributes: {
    sidePanels: [
      {
        id: "ui-kit",
        title: "UI kit",
        preferredPlacement: { x: "right", y: "top" },
        order: 5,
        size: "content",
      },
    ],
  },
  capabilities: { reads: [] },
});

/** The comparison follows the real available width, including native gutter space. */
function GalleryPanelBody() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const body = ref.current;
    const outside = document.querySelector<HTMLElement>("[data-ui-kit-outside]");
    if (!body || !outside) return;
    const followWidth = () => {
      outside.style.width = `${body.getBoundingClientRect().width}px`;
    };
    followWidth();
    const observer = new ResizeObserver(followWidth);
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref}>
      <UiKitGallery />
    </div>
  );
}

const bindings: PluginBindings = {
  sidePanels: {
    "ui-kit": sidePanelBinding({
      source: { subscribe: () => () => {}, get: () => true },
      Body: GalleryPanelBody,
    }),
  },
};

/** Mounts the same gallery outside any panel, at the panel body's width. */
function mountGalleryOutsidePanel(): void {
  const host = document.createElement("div");
  host.setAttribute("data-ui-kit-outside", "");
  // The panel publishes its measured content width when it mounts; do not
  // duplicate rail/padding/gutter arithmetic in this comparison fixture.
  // Keep the app's own background, which a panel body sits on too.
  host.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "z-index:50",
    "width:0",
    "background:var(--bg-0)",
  ].join(";");
  document.body.append(host);
  createRoot(host).render(<UiKitGallery />);
}

/** Registers the gallery when asked for; returns null on the product path. */
export function registerDesignFixtures(host: PluginHost): (() => void) | null {
  if (!designFixturesEnabled()) return null;
  const unregister = host.registerPlugin(manifest, bindings, { firstParty: true });
  mountGalleryOutsidePanel();
  return unregister;
}
