// Packaged disposable-fixture entry only; never imported by the production app.
import { join } from "node:path";
import { loadDarwinKeychainApi } from "../../../src/main/host/darwinKeychain";
import { serveKeychainRequest } from "../../../src/main/host/keychainProcessRuntime";
import { fixtureUnlockReader } from "./unlock";

declare const __INF_SECRET_FIXTURE_ROOT__: string;
const root = __INF_SECRET_FIXTURE_ROOT__;
const home = join(root, "home");
if (
  process.platform !== "darwin" ||
  process.env.HOME !== home ||
  process.env.CFFIXED_USER_HOME !== home ||
  process.env.PI_OFFLINE !== "1"
)
  throw new Error("The fixture unlock requires its isolated Mac home.");
// The shared lifecycle refuses a directly launched child with no private recipient.
void serveKeychainRequest(fixtureUnlockReader(root, loadDarwinKeychainApi));
