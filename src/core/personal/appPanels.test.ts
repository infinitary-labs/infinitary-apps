import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { personalManifestSchema } from "@shared/personal/manifest";
import {
  BUILTIN_FRAME_PANELS,
  type BuiltinFramePanel,
  builtinPanelSource,
  RUNBOOK_FRAME_PANELS,
} from "@shared/plugins/frameLib";
import { panelCardsProblem } from "@shared/plugins/panelCards";
import { APP_PANEL_FOLDERS } from "@shared/surfaces";
import { describe, expect, it } from "vitest";
import { RUNBOOK_PANEL_DIRS } from "../../../scripts/generate-messages";
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
 * A built-in runbook's panel folders (docs/runbooks.md, "Panels") are held
 * to the same, from their runbook's folder.
 */

const ROOT = join(__dirname, "../../..");
const PANELS = join(ROOT, "src/panels");

function folders(): string[] {
  return [
    ...readdirSync(PANELS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
    ...Object.keys(RUNBOOK_FRAME_PANELS),
  ].sort();
}

/** An app panel's folder, as `extensionSources` reads it: the folder it is in, and its name. */
function sourcesOf(id: string) {
  const dir = join(ROOT, builtinPanelSource(id as BuiltinFramePanel));
  return extensionSources(dirname(dir), basename(dir));
}

describe("the app's own panel folders", () => {
  it("are the panels the lib builds and the app registers, by their folders' names", () => {
    expect(folders()).toEqual([...BUILTIN_FRAME_PANELS].sort());
    expect(APP_PANEL_FOLDERS.map((folder) => folder.id).sort()).toEqual(folders());
  });

  it("compile their words where the panel compiler reads them: a runbook's panel in its runbook's folder", () => {
    for (const [key, { runbook, folder }] of Object.entries(RUNBOOK_FRAME_PANELS)) {
      const id = key as BuiltinFramePanel;
      expect(builtinPanelSource(id)).toBe(`resources/runbooks/${runbook}/${folder}`);
      expect(RUNBOOK_PANEL_DIRS[id], id).toBe(builtinPanelSource(id));
    }
    expect(Object.keys(RUNBOOK_PANEL_DIRS).sort()).toEqual(
      Object.keys(RUNBOOK_FRAME_PANELS).sort(),
    );
  });

  it("each build for the frame realm on the panel library alone, their card views as the app lists them", async () => {
    const cacheRoot = scratchDir("infinitary-app-panels-");
    for (const folder of APP_PANEL_FOLDERS) {
      const compiled = await compilePersonalModule({
        extensionId: folder.id,
        extensionDir: join(ROOT, builtinPanelSource(folder.id)),
        kind: "panel",
        cacheRoot,
      });
      expect(compiled.views, folder.id).toEqual([...folder.views]);
      expect(panelCardsProblem(folder.manifest, compiled.views, folder.id), folder.id).toBeNull();
    }
  });

  it("each read as the one manifest, naming no maker: the app's own carry no attribution", async () => {
    for (const folder of APP_PANEL_FOLDERS) {
      const sources = await sourcesOf(folder.id);
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
      const findings = lintPanelSources(await sourcesOf(folder.id));
      expect(
        findings.filter((finding) => finding.severity !== "note"),
        folder.id,
      ).toEqual([]);
    }
  });
});
