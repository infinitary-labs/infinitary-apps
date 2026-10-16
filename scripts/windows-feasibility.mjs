#!/usr/bin/env node
// Manual observations only: never part of the normal test or release gates.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { removeScratchDirs, scratchDir } from "../tests/helpers/scratchDirs.ts";

const mode = process.argv[2];
const modes = ["native", "shell", "privateFiles", "transport", "crew", "desktop", "browser"];
if (process.platform !== "win32" || !modes.includes(mode)) {
  throw new Error(`Windows only; choose one of ${modes.join(", ")}`);
}
const evidence = process.env.FM_WINDOWS_EVIDENCE;
if (!evidence || !resolve(evidence).startsWith(resolve(process.env.RUNNER_TEMP ?? "missing"))) {
  throw new Error("Evidence must be in the disposable runner's temporary directory.");
}
mkdirSync(evidence, { recursive: true });
const home = scratchDir("fm-windows-home-");
for (const [key, path] of Object.entries({
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  INFINITARY_LOCAL_CODESIGN_DIR: join(home, "signing-unused"),
})) {
  mkdirSync(path, { recursive: true });
  process.env[key] = path;
}
process.env.PI_OFFLINE = "1";
// No installed provider clients or real sign-ins are used by these observations.
process.env.INFINITARY_CLAUDE_CLI = join(home, "absent-synthetic-client.exe");
const server = await createServer({
  configFile: false,
  server: { middlewareMode: true, watch: null },
  resolve: { alias: { "@core": resolve("src/core"), "@shared": resolve("src/shared") } },
  appType: "custom",
});
let result;
try {
  const probes = await server.ssrLoadModule("/scripts/windows-feasibility/probes.ts");
  result = { mode, status: "observed", result: await probes[mode](evidence) };
} catch (error) {
  result = { mode, status: "blocked", error: String(error), stack: error?.stack };
} finally {
  await server.close();
  removeScratchDirs();
}
writeFileSync(join(evidence, `${mode}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
// A collected blocker is a valid investigation result, not a passing Windows test.
