import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertInstallerEnvironment } from "./installer-environment.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { notarizationRunner, notarizeArtifact, recordNotarizationNetwork } from "./notarize.ts";

// The installer check's notarization (INF-816; docs/alpha.md, "Isolated signed
// verification"): only in a disposable Actions Mac, each artifact uploaded
// once, and each failed request's network state recorded beside its journal.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertInstallerEnvironment();
  const [upload, target, journal] = process.argv.slice(2);
  if (!upload || !target || !journal)
    throw new Error("Use <upload.zip|dmg> <target.app|dmg> <journal.json>.");
  const { APPLE_API_KEY: key, APPLE_API_KEY_ID: keyId, APPLE_API_ISSUER: issuer } = process.env;
  if (!key || !keyId || !issuer)
    throw new Error("The notarization credentials are not configured.");
  const auth = ["--key", key, "--key-id", keyId, "--issuer", issuer];
  const modules = await openModuleRunner();
  try {
    const { hostEnv } = await modules.import<typeof import("../src/core/hostEnv")>(
      join(REPO_ROOT, "src/core/hostEnv.ts"),
    );
    const env = hostEnv();
    await notarizeArtifact(
      { upload, target, journal },
      {
        run: notarizationRunner(env),
        auth,
        recordNetwork: (operation, attempt, result) =>
          recordNotarizationNetwork(journal, operation, attempt, result, (command, args) =>
            spawnSync(command, args, { env, encoding: "utf8", timeout: 10_000 }),
          ),
        now: Date.now,
        pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
    );
  } finally {
    await modules.close();
  }
  console.log("Notarization accepted and ticket validated.");
}
