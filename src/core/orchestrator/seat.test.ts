import { createHash } from "node:crypto";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { fakeBinding } from "../../../tests/helpers/fakeSession";
import { appPathsFor } from "../paths";
import { boundTool, FIRSTMATE_TOOLS } from "../session/tools";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../storage/sessionReader";
import { seatSessionSpec } from "./seat";

/**
 * The seat preset is the production surface the architecture doc describes:
 * builtins none, and exactly the typed tools the caller passed. No read,
 * grep, find, or ls is added here.
 */

const FILESYSTEM_TOOL_NAMES = ["read", "grep", "find", "ls", "bash", "edit", "write"];

describe("seatSessionSpec", () => {
  it("runs with builtins none and does not add filesystem tools", () => {
    const typed = boundTool({
      name: "emit_card",
      label: "Card",
      description: "Show a card.",
      parameters: Type.Object({}),
      run: () => ({ text: "ok" }),
    });
    const tools = [typed];
    const spec = seatSessionSpec({
      paths: appPathsFor("/tmp/firstmate"),
      binding: fakeBinding(),
      model: { provider: "fm-mock", id: "mock-1" },
      tools,
    });
    expect(spec.builtins).toBe("none");
    expect(spec.tools).toBe(tools);
    for (const name of FILESYSTEM_TOOL_NAMES) {
      expect(spec.tools.map((tool) => tool.name)).not.toContain(name);
    }
  });

  it("serves the short-name sentence only to a Claude seat, and stamps the prompt it served (INF-3718)", () => {
    const specFor = (binding: Parameters<typeof seatSessionSpec>[0]["binding"]) =>
      seatSessionSpec({
        paths: appPathsFor("/tmp/firstmate"),
        binding,
        model: { provider: "fm-mock", id: "mock-1" },
        tools: [],
      });
    const claude = specFor({ backend: "claude", accountId: "claude-1" });
    const pi = specFor(fakeBinding());
    expect(claude.instructions.base).toContain(`${CLAUDE_SEAT_TOOL_PREFIX}<name>`);
    expect(pi.instructions.base).not.toContain(CLAUDE_SEAT_TOOL_PREFIX);
    // A Claude client resumes only on the prompt its record stamped, so the
    // stamp is the prompt this seat was served, never the Pi seat's.
    for (const spec of [claude, pi]) {
      expect(spec.shape.turns === "rolling" ? spec.shape.record.stamp?.promptSha : null).toBe(
        createHash("sha256").update(spec.instructions.base).digest("hex"),
      );
    }
  });

  it("offers no filesystem tool in the Firstmate tool set", () => {
    const names = FIRSTMATE_TOOLS.map((tool) => tool.name);
    for (const name of FILESYSTEM_TOOL_NAMES) {
      expect(names, name).not.toContain(name);
    }
  });
});
