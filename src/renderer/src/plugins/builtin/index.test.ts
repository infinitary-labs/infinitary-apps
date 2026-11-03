import { CARD_PRESENTATIONS, cardSchema } from "@shared/cards";
import { frameTemplateSchema } from "@shared/plugins/frameDocument";
import { READ_NAMES } from "@shared/reads";
import { APP_PANEL_FOLDERS } from "@shared/surfaces";
import { describe, expect, it } from "vitest";
import { FramedPanelBody, type FramedPanelContent } from "../../personal/FramedPanelBody";
import { orderSettingsSections, PluginHost, placeSidePanels } from "../host";
import {
  appPanelContent,
  observeTemplate,
  recordTemplate,
  registerBuiltinPlugin,
  registerGatedPanels,
} from "./index";
import { BUILTIN_PLUGIN_ID, builtinManifest, gatedPluginId, UNGATED_FOLDERS } from "./manifest";

/** A host like the app's: it serves the read catalog and nothing else. */
function appLikeHost() {
  return new PluginHost({ reads: new Set(READ_NAMES) });
}

describe("the built-in plugin", () => {
  it("describes every card presentation, so no derived dress is missing", () => {
    const host = appLikeHost();
    registerBuiltinPlugin(host);
    for (const kind of CARD_PRESENTATIONS) {
      expect(host.cardKinds.get(kind)?.pluginId, kind).toBe(BUILTIN_PLUGIN_ID);
    }
    // The three presentations plus the host-owned task record (P4).
    expect(
      host.cardKinds
        .list()
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual([...CARD_PRESENTATIONS, "task-record"].sort());
  });

  it("dresses the task record as a card the wire never carries (P4)", () => {
    const host = appLikeHost();
    registerBuiltinPlugin(host);
    expect(host.describeCardKind("task-record").chrome).toBe("record");
    // Never persisted, never agent-emitted: the wire schema carries no kind
    // at all (cards/tasks/agents P1), so neither the card store nor
    // emit_card can ever produce one.
    expect(
      cardSchema.safeParse({
        id: "c1",
        kind: "task-record",
        author: "host",
        priority: 1,
        title: "A task",
        meta: "",
        body: "",
        actions: [],
        status: "ready",
        createdAt: 0,
      }).success,
    ).toBe(false);
    // Its body is the record template, stamped with the task it shows.
    const template = recordTemplate("abc123");
    expect(frameTemplateSchema.safeParse(template).success).toBe(true);
    expect(template.html).toContain('data-task-id="abc123"');
    expect(template.script).toBe(recordTemplate("other").script);
    // The id crosses the frame boundary attribute-escaped.
    expect(recordTemplate('x"><b>').html).toContain('data-task-id="x&quot;&gt;&lt;b&gt;"');
  });

  it("offers General, Appearance, Keyboard, Projects, Intelligence, Usage, Devices, then the gated Observe tab", () => {
    const host = appLikeHost();
    const remove = registerBuiltinPlugin(host);
    const sections = orderSettingsSections(host.settingsSections.list());
    expect(sections.map((section) => [section.id, section.label, section.width])).toEqual([
      ["general", "General", "wide"],
      ["appearance", "Appearance", "wide"],
      ["keyboard", "Keyboard", "wide"],
      ["projects", "Projects", "wide"],
      ["subscriptions", "Intelligence", "wide"],
      ["runbooks", "Runbooks", "wide"],
      ["usage", "Usage", "wide"],
      ["automation", "Automation", "wide"],
      ["integrations", "Integrations", "wide"],
      ["devices", "Devices", "wide"],
      ["observe", "Observe", "wide"],
    ]);
    expect(sections.find((section) => section.id === "observe")?.enabled).toBeTypeOf("function");
    expect(sections.find((section) => section.id === "devices")?.enabled).toBeTypeOf("function");
    expect(sections.find((section) => section.id === "general")?.enabled).toBeUndefined();
    remove();
    expect(host.settingsSections.list()).toHaveLength(0);
    expect(host.capabilitiesOf(BUILTIN_PLUGIN_ID)).toBeUndefined();
  });

  it("docks the feed on the left rail and Tasks at the bottom right, each an ordinary folder", () => {
    const host = appLikeHost();
    registerBuiltinPlugin(host);
    const placed = placeSidePanels(host.sidePanels.list());
    expect(placed.left.map((panel) => [panel.id, panel.title, panel.size])).toEqual([
      ["activity", "Activity", "content"],
    ]);
    expect(placed.right.map((panel) => [panel.id, panel.title, panel.size])).toEqual([
      ["now", "Tasks", "content"],
    ]);
    expect(placed.left[0]?.preferredPlacement.y).toBe("bottom");
    expect(placed.right[0]?.preferredPlacement.y).toBe("bottom");
    for (const panel of [...placed.left, ...placed.right]) {
      // Bound as a panel added from elsewhere is: drawn in the frame realm
      // from its folder's code in the lib, its cards drawn the same way,
      // speaking for itself on its rail. No template, no field only it sets.
      expect(panel.Body, panel.id).toBe(FramedPanelBody);
      expect(panel.CardBody, panel.id).toBeTypeOf("function");
      expect(panel.frame, panel.id).toBeUndefined();
      expect(panel.source.get(), panel.id).toEqual(
        appPanelContent(APP_PANEL_FOLDERS.find((folder) => folder.id === panel.id) as never),
      );
      expect((panel.source.get() as FramedPanelContent | null)?.code, panel.id).toEqual({
        source: "builtin",
      });
      // The host's own panels carry no attribution: the app never names itself.
      expect(panel.attribution, panel.id).toBeNull();
    }
    // Activity always shows; Tasks says itself whether it does.
    expect(host.sidePanels.get("activity")?.rail).toEqual({ decides: false });
    expect(host.sidePanels.get("now")?.rail).toEqual({ decides: true });
  });

  it("declares exactly the reads its frames subscribe to, and no other grant", () => {
    const declared = builtinManifest.capabilities.reads ?? [];
    expect(builtinManifest.capabilities).toEqual({ reads: declared });
    const host = appLikeHost();
    registerBuiltinPlugin(host);
    expect(host.declaredReads(BUILTIN_PLUGIN_ID)).toEqual(declared);
    // Every read a frame script names, and every read the app's own panel
    // folders declare, is declared - a read it did not declare would be
    // refused by the controller at run time - and every declared read is
    // used by some frame, so the grant is exactly what is used.
    const named = new Set<string>(UNGATED_FOLDERS.flatMap((folder) => folder.manifest.reads ?? []));
    for (const template of [observeTemplate, recordTemplate("t")]) {
      for (const match of (template.script ?? "").matchAll(/bridge\.subscribe\(\s*"([^"]+)"/g)) {
        expect(declared, match[1]).toContain(match[1]);
        named.add(match[1] as string);
      }
    }
    expect([...named].sort()).toEqual([...declared].sort());
    // A host serving no catalog refuses the built-in plugin, as it would any.
    expect(() => registerBuiltinPlugin(new PluginHost())).toThrow(`reads:${declared[0]}`);
  });

  it("registers the Knowledge panel, its card and its command only where its gate is open", () => {
    const shut = appLikeHost();
    registerBuiltinPlugin(shut);
    registerGatedPanels(shut, { knowledge: false });
    expect(shut.sidePanels.get("knowledge")).toBeUndefined();
    expect(shut.capabilitiesOf(gatedPluginId("knowledge"))).toBeUndefined();
    expect(
      shut.sidePanels
        .list()
        .flatMap((panel) => panel.commands ?? [])
        .map((command) => command.id),
    ).not.toContain("open");

    const open = appLikeHost();
    registerBuiltinPlugin(open);
    registerGatedPanels(open, { knowledge: true });
    const knowledge = open.sidePanels.get("knowledge");
    expect(knowledge?.title).toBe("Knowledge");
    expect(knowledge?.attribution).toBeNull();
    expect(knowledge?.preferredPlacement).toEqual({ x: "right", y: "bottom" });
    expect(knowledge?.cardViews).toEqual(["browser"]);
    expect(knowledge?.header?.map((button) => [button.id, button.emits])).toEqual([
      ["open", "browser"],
    ]);
    // Its one command, chosen by name: the app invents no key for it.
    expect(knowledge?.commands?.map((command) => [command.id, command.key])).toEqual([
      ["open", undefined],
    ]);
    expect(knowledge?.source.get()).toEqual(
      appPanelContent(APP_PANEL_FOLDERS.find((folder) => folder.id === "knowledge") as never),
    );
    // Its reads are its own plugin's grant, and the built-in plugin's stay as they were.
    expect([...open.declaredReads(gatedPluginId("knowledge"))].sort()).toEqual([
      "knowledge.collections",
      "knowledge.concepts",
      "knowledge.direction",
      "knowledge.directions",
      "knowledge.entry",
      "knowledge.findings",
      "knowledge.graph",
      // Its task keys link to their tasks (FI3-1271).
      "tasks.board",
      "tasks.search",
    ]);
    expect(open.declaredReads(BUILTIN_PLUGIN_ID)).not.toContain("knowledge.graph");
    // Under Tasks on the right rail.
    expect(placeSidePanels(open.sidePanels.list()).right.map((panel) => panel.id)).toEqual([
      "now",
      "knowledge",
    ]);
  });
});
