import { readdirSync } from "node:fs";
import { join } from "node:path";
import { personalManifestSchema } from "@shared/personal/manifest";
import { BUILTIN_FRAME_PANELS } from "@shared/plugins/frameLib";
import { panelCardsProblem } from "@shared/plugins/panelCards";
import { APP_PANEL_FOLDERS } from "@shared/surfaces";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { lintPanelSources } from "../plugins/pluginLint";
import { compilePersonalModule } from "./compiler";
import { extensionSources } from "./liveWorkspace";

/**
 * The app's own panels are ordinary panel folders (docs/ui-plugins.md, "The
 * app's own panels are ordinary folders"): each `src/panels/<id>/` passes
 * what a panel added from elsewhere passes - its manifest is one the app
 * reads, the panel compiler builds it for the frame realm on React,
 * `@infinitary/ui` and its own files alone, every card, button and command
 * it names is one it has, and the panel lint finds nothing - and the app
 * registers exactly these folders, with the card views the compiler found.
 */

const PANELS = join(__dirname, "../../panels");

function folders(): string[] {
  return readdirSync(PANELS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe("the app's own panel folders", () => {
  it("are the panels the lib builds and the app registers, by their folders' names", () => {
    expect(folders()).toEqual([...BUILTIN_FRAME_PANELS].sort());
    expect(APP_PANEL_FOLDERS.map((folder) => folder.id).sort()).toEqual(folders());
  });

  it("each build for the frame realm on the panel library alone, their card views as the app lists them", async () => {
    const cacheRoot = scratchDir("infinitary-app-panels-");
    for (const folder of APP_PANEL_FOLDERS) {
      const compiled = await compilePersonalModule({
        extensionId: folder.id,
        extensionDir: join(PANELS, folder.id),
        kind: "panel",
        cacheRoot,
        realm: "frame",
      });
      expect(compiled.views, folder.id).toEqual([...folder.views]);
      expect(panelCardsProblem(folder.manifest, compiled.views, folder.id), folder.id).toBeNull();
    }
  });

  it("each read as the one manifest, naming no maker: the app's own carry no attribution", async () => {
    for (const folder of APP_PANEL_FOLDERS) {
      const sources = await extensionSources(PANELS, folder.id);
      const manifest = sources.find((file) => file.path === "manifest.json");
      expect(personalManifestSchema.parse(JSON.parse(manifest?.text ?? "null")), folder.id).toEqual(
        folder.manifest,
      );
      expect(folder.manifest.name, folder.id).toBeUndefined();
      expect(folder.manifest.api, folder.id).toBe(1);
    }
  });

  it("each pass the panel lint: nothing refused, and every value on the design system's tokens", async () => {
    for (const folder of APP_PANEL_FOLDERS) {
      const findings = lintPanelSources(await extensionSources(PANELS, folder.id));
      expect(
        findings.filter((finding) => finding.severity !== "note"),
        folder.id,
      ).toEqual([]);
    }
  });
});
