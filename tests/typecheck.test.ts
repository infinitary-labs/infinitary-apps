import { spawnSync } from "node:child_process";
import { copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { describe, expect, it } from "vitest";
import { checkerPackage } from "../scripts/typecheck.ts";
import { scratchDir } from "./helpers/scratchDirs";

const root = resolve(__dirname, "..");
const script = join(root, "scripts/typecheck.ts");

// INF-641's accepted replacement: build references, platform-only selection,
// failures remain failures, and incremental additions/import changes are checked.
describe("the required tsrs check", () => {
  it("selects published native platforms and portable Intel Mac/Windows without probing execution", () => {
    expect(checkerPackage("darwin", "arm64")).toBe("tsrs");
    expect(checkerPackage("linux", "x64")).toBe("tsrs");
    expect(checkerPackage("linux", "arm64")).toBe("tsrs");
    expect(checkerPackage("darwin", "x64")).toBe("@tsrs/wasm");
    expect(checkerPackage("win32", "x64")).toBe("@tsrs/wasm");
  });

  it("checks a referenced real module through fresh, broken, repaired and changed-import builds", () => {
    const cwd = scratchDir("infinitary-typecheck-");
    const source = join(cwd, "generalWords.ts");
    const original = readFileSync(join(root, "src/renderer/src/settings/generalWords.ts"), "utf8");
    copyFileSync(join(root, "src/renderer/src/settings/generalWords.ts"), source);
    writeFileSync(
      join(cwd, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "./tsconfig.words.json" }] }),
    );
    writeFileSync(
      join(cwd, "tsconfig.words.json"),
      JSON.stringify({
        compilerOptions: { composite: true, strict: true, noEmit: true, types: [] },
        include: ["*.ts"],
      }),
    );
    const run = () =>
      spawnSync(process.execPath, [script, "--pretty", "false"], {
        cwd,
        env: hostEnv({ TSRS_BINARY: undefined }),
        encoding: "utf8",
      });
    const clean = () => {
      const result = run();
      expect(result.stdout + result.stderr).toBe("");
      expect(result.status).toBe(0);
    };
    const broken = (file: string, code: string) => {
      const result = run();
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(`${file}(`);
      expect(result.stdout + result.stderr).toContain(code);
    };
    clean();
    clean();
    writeFileSync(source, original.replace('"1 task purged."', "count"));
    broken("generalWords.ts", "TS2322");
    broken("generalWords.ts", "TS2322");
    writeFileSync(source, original);
    clean();
    const consumer = join(cwd, "consumer.ts");
    writeFileSync(
      consumer,
      'import { purgedTasksText } from "./generalWords";\nexport const text: string = purgedTasksText(1);\n',
    );
    clean();
    writeFileSync(source, original.replace("count: number", "count: string | number"));
    clean();
    // A changed imported return type must invalidate the already-checked consumer.
    writeFileSync(source, original.replace("): string", "): string | undefined"));
    broken("consumer.ts", "TS2322");
    rmSync(source);
    broken("consumer.ts", "TS2307");
    writeFileSync(source, original);
    clean();
    rmSync(consumer);
    clean();
    // Eleven compiler processes; budget measured on the hosted Linux runner.
  }, 20_000);

  it.skipIf(checkerPackage() !== "tsrs")(
    "does not retry a failed native launch through portable tsrs",
    () => {
      const cwd = scratchDir("infinitary-typecheck-missing-");
      writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({ files: ["generalWords.ts"] }));
      copyFileSync(
        join(root, "src/renderer/src/settings/generalWords.ts"),
        join(cwd, "generalWords.ts"),
      );
      const result = spawnSync(process.execPath, [script], {
        cwd,
        env: hostEnv({ TSRS_BINARY: join(cwd, "missing-native-binary") }),
        encoding: "utf8",
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("does not exist");
    },
  );

  it.skipIf(checkerPackage() !== "tsrs")(
    "propagates a native failure exit and termination signal",
    () => {
      const cwd = scratchDir("infinitary-typecheck-failure-");
      const binary = join(cwd, "native-checker");
      const run = () =>
        spawnSync(process.execPath, [script], {
          cwd,
          env: hostEnv({ TSRS_BINARY: binary }),
          encoding: "utf8",
        });
      writeFileSync(binary, "#!/bin/sh\nexit 23\n", { mode: 0o755 });
      expect(run().status).toBe(23);
      writeFileSync(binary, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
      expect(run().signal).toBe("SIGTERM");
    },
  );
});
