/** INF-64's test home: real core and mock provider, all files and keys in a disposable HOME. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scratchDir } from "../tests/helpers/scratchDirs.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

const argument = process.argv[2];
if (!argument) throw new Error("Pass an output JSON file outside the working copy");
const output = resolve(argument);
if (output === REPO_ROOT || output.startsWith(REPO_ROOT + "/"))
  throw new Error("The test home's private control file must stay outside the working copy");
mkdirSync(dirname(output), { recursive: true });
const root = scratchDir("infinitary-phone-home-");
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.CFFIXED_USER_HOME = home;
process.env.PI_OFFLINE = "1";
process.env.INFINITARY_LOCAL_CODESIGN_DIR = join(home, "signing-unused");
const runner = await openModuleRunner();
const { startPhoneHome } = await runner.import<typeof import("../tests/helpers/phoneHome")>(
  join(REPO_ROOT, "tests/helpers/phoneHome.ts"),
);
const fixture = await startPhoneHome(root);
writeFileSync(output, JSON.stringify({ url: fixture.url, root }) + "\n", { mode: 0o600 });
console.log("The disposable phone test home is ready.");
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await fixture.close(); await runner.close();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
