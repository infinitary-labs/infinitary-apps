/**
 * INF-5265: the phone part's second computer (tests/helpers/phoneSecondHome.ts), a disposable real home in a process
 * of its own, so its HOME, port and stand-in relay are its own. Its arguments are the private file its control
 * address is written to and the computer's name.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openModuleRunner, REPO_ROOT } from "../../scripts/moduleRunner.ts";
import { scratchDir } from "./scratchDirs.ts";

const [, , argument, name] = process.argv;
if (!argument || !name) throw new Error("Pass the control file and the computer's name");
const output = resolve(argument);
mkdirSync(dirname(output), { recursive: true });
const root = scratchDir("infinitary-phone-second-home-");
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.CFFIXED_USER_HOME = home;
process.env.PI_OFFLINE = "1";
process.env.INFINITARY_LOCAL_CODESIGN_DIR = join(home, "signing-unused");
const runner = await openModuleRunner();
const { startPhoneHome } = await runner.import<typeof import("./phoneHome")>(
  join(REPO_ROOT, "tests/helpers/phoneHome.ts"),
);
const fixture = await startPhoneHome(root, undefined, { name });
writeFileSync(output, `${JSON.stringify({ url: fixture.url })}\n`, { mode: 0o600 });
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await fixture.close();
  await runner.close();
  // The scratch folders go as the process exits.
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
