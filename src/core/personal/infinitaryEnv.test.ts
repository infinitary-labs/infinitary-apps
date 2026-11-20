import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CONTRACTS_PATH,
  GENERATED_PATH,
  renderGeneratedModule,
  renderInfinitaryEnv,
} from "../../../scripts/generate-personal-env";
import { INFINITARY_ENV_DTS } from "./seed/infinitaryEnv.generated";

// The generator reads the contracts through CONTRACTS_PATH, which the pull
// request check's selector (scripts/unit-reach.ts) cannot see from here: a
// contracts edit without a regenerated file reached the merge batch unread.
// This literal project-relative path declares that indirect read to it.
const inventoryFiles = ["src/shared/personal/contracts.ts"] as const;
// The selector reads this declaration statically, never by importing a test.
void inventoryFiles;

/**
 * The generated contract is fresh:
 * a change to src/shared/personal/contracts.ts without
 * `pnpm generate:personal-env` fails here, and the file the seeder ships
 * is real TypeScript an extension can compile against.
 */
describe("infinitary-env.d.ts", () => {
  it("is what the generator renders from the current contracts (run `pnpm generate:personal-env`)", () => {
    const dts = renderInfinitaryEnv(readFileSync(CONTRACTS_PATH, "utf8"));
    expect(INFINITARY_ENV_DTS).toBe(dts);
    expect(readFileSync(GENERATED_PATH, "utf8")).toBe(renderGeneratedModule(dts));
  });

  it("declares every exported contract type inside the @infinitary/contracts module, with its doc", () => {
    expect(INFINITARY_ENV_DTS).toContain('declare module "@infinitary/contracts" {');
    // Every type the contracts module exports, read from its source.
    const exported = [
      ...readFileSync(CONTRACTS_PATH, "utf8").matchAll(/^export (type|interface) (\w+)/gm),
    ];
    expect(exported.length).toBeGreaterThan(0);
    for (const [, keyword, name] of exported) {
      expect(INFINITARY_ENV_DTS).toContain(`export ${keyword} ${name}`);
    }
    expect(INFINITARY_ENV_DTS).toContain("clamped up to it");
    expect(INFINITARY_ENV_DTS).not.toMatch(/^import /m);
  });

  it("type-checks a panel and a server written against it, with no node_modules", () => {
    const files: Record<string, string> = {
      "/ws/infinitary-env.d.ts": INFINITARY_ENV_DTS,
      "/ws/clock/panel.tsx": [
        'import type { PanelProps, PersonalManifest, PanelKnowledgeDirection } from "@infinitary/contracts";',
        "const manifest: PersonalManifest = { presence: { store: 'items', when: 'nonEmpty' } };",
        "export const directionText = (direction: PanelKnowledgeDirection): string => direction.text;",
        "export default function Panel({ id, store, invoke, theme }: PanelProps) {",
        '  void store.get("x"); void invoke<number>("count"); void manifest;',
        "  return [id, theme].join('-');",
        "}",
      ].join("\n"),
      "/ws/clock/server.ts": [
        'import type { ServerModule } from "@firstmate/contracts";',
        "export const actions: NonNullable<ServerModule['actions']> = {",
        "  count: async (_input, context) => (await context.db.list()).length,",
        "};",
        "export const background: NonNullable<ServerModule['background']> = {",
        '  tick: { everyMs: 60_000, run: (context) => context.db.set("t", Date.now()) },',
        "};",
      ].join("\n"),
    };
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      noEmit: true,
      types: [],
      lib: ["lib.es2022.d.ts"],
    };
    const host = ts.createCompilerHost(options, true);
    const read = host.readFile;
    host.readFile = (name) => files[name] ?? read(name);
    host.fileExists = (name) => name in files || ts.sys.fileExists(name);
    const program = ts.createProgram(Object.keys(files), options, host);
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(diagnostics).toEqual([]);
  });
});
