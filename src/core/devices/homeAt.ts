import { randomUUID } from "node:crypto";
import { CONNECTION_PORT } from "@shared/connection";
import type {
  HomeAtAnswer,
  HomeAtOptions,
  HomeAtRefusal,
  HomeAtRefused,
  HomeStep,
} from "@shared/homeAt";
import { COMPUTER_LINK_NONE } from "@shared/phoneLink";
import {
  addressAtPort,
  addressParts,
  parseRemoteLoginAddress,
  REMOTE_LOGIN_TIME_LIMIT_MS,
  type RemoteLoginReach,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { hostPlatform } from "../platform";
import { copyCount } from "./appArchive";
import type { FarBuilds } from "./farBuilds";
import { HOME_ACCOUNT, HOME_START, homeReceive, MAKE_ACCOUNT, readHomeStarted } from "./farHome";
import { farSystemOf } from "./farSystems";
import { signInUser } from "./hostKey";
import { placeLocalityChallenge } from "./locality";
import {
  type Look,
  type RemoteLogin,
  type RemoteLoginOptions,
  RemoteLoginRefusedError,
  sendCopy,
} from "./remoteLogin";
import { runSsh, SSH_FAILED } from "./ssh";
import { UBUNTU_PACKAGE_BIN, ubuntuPackageRelease } from "./ubuntuPackage";

/**
 * Setting the first mate up on another computer over SSH, from the welcome
 * screen's Another computer (docs/first-launch.md, "Setting it up from
 * here"): the first five of its seven steps, one call each time the person
 * answers, as Join by its address asks. Steps 1 to 4 are adding a computer
 * by its address (`RemoteLogin.addOrAsk`): its key line, a sign-in with the
 * person's own SSH or the password once, the look, and the copy, or the
 * Ubuntu package on Ubuntu 24.04 and 26.04. Step 5 is new: in place of
 * `work join`, the copy kept in that account's Applications folder runs its
 * own `start-at-boot`, which starts a first mate there with the record that
 * account already has, or a fresh one. Nothing there joins this computer's
 * first mate; the window joins the one there after (`inf:devices:join-at`).
 *
 * A root sign-in on Linux makes an ordinary account named `infinitary` once
 * the person agreed, carrying the keys root's SSH lets in, and goes on as
 * it. Cancel stops at the next step: before step 5 nothing runs there and
 * the copy sent is removed.
 */

/** What a setup reaches of `RemoteLogin`, which keeps its SSH trust and builds. */
export type HomeReach = {
  options: RemoteLoginOptions;
  builds: FarBuilds;
  /** Setups the person cancelled, by the address as asked. */
  cancels: Set<string>;
  confirmHost: RemoteLogin["confirmHost"];
  look: RemoteLogin["look"];
  letIn: RemoteLogin["letIn"];
  installUbuntu: RemoteLogin["installUbuntu"];
  askLink: RemoteLogin["askLink"];
  sshFor: RemoteLogin["sshFor"];
  stepper: (address: string) => ReturnType<RemoteLogin["stepper"]>;
  once: <T>(key: string, run: () => Promise<T>) => Promise<T>;
};

const LOOK_TIMEOUT_MS = 90_000;
/** What a kept copy's path may be: absolute, and nothing a shell or SSH would read. */
const KEPT_PATH = /^\/[A-Za-z0-9 ._/-]{1,1000}$/;

export async function homeAt(
  reach: HomeReach,
  text: string,
  options: HomeAtOptions = {},
): Promise<HomeAtAnswer> {
  const typed = parseRemoteLoginAddress(text);
  if (!typed) return { refused: "not-an-address", step: "key" };
  let at: HomeStep = "key";
  let name: string | undefined;
  const stop = (
    refused: HomeAtRefusal,
    more: Partial<Omit<HomeAtRefused, "refused" | "step">> = {},
  ): HomeAtRefused => ({ refused, step: at, ...(name ? { name } : {}), ...more });
  const cancelled = () => reach.cancels.has(typed);
  reach.cancels.delete(typed);
  try {
    return await reach.once(typed, async (): Promise<HomeAtAnswer> => {
      const { pairing } = reach.options;
      let address = typed;
      let step = reach.stepper(address);
      // 1. Its SSH key, asked once before any sign-in.
      const gated = await reach.confirmHost(address, options.confirm);
      if ("asks" in gated) return gated;
      if ("refusal" in gated) return stop(gated.refusal, reachOf(gated.reach));
      if (cancelled()) return stop("cancelled");
      // 2. A sign-in with the person's own SSH, or the password once, which lets Infinitary's own key in.
      at = "sign-in";
      step.say("reaching", remoteLoginWords.reaching(address));
      const signedIn = await signIn(reach, address, options, step);
      if (!("os" in signedIn)) return "asks" in signedIn ? signedIn : stop(...signedIn.stop);
      let look: Look = signedIn;
      if (cancelled()) return stop("cancelled");
      // 3. Its system: what it is, what it lacks, whether it starts at boot, and who signed in.
      at = "look";
      name = look.name ?? address;
      const far = farSystemOf(look.os);
      const chip = far?.chips[look.arch ?? ""];
      if (!far || !chip) return stop("other-system");
      if (signedIn.locality === "this-mac" && look.uid === reach.options.pairing.ownUid)
        return stop("same-user");
      const packageRelease = reach.builds.readsPublished() ? ubuntuPackageRelease(look) : null;
      if (!packageRelease) {
        if (look.needs.length > 0)
          return stop("needs-tools", { missing: look.needs, installs: look.installs });
        if (look.sandboxOff) return stop("sandbox-off");
        if (!reach.builds.canSend(far, chip)) return stop("cannot-send");
      }
      if (far.system === "linux" && !look.systemd) return stop("no-systemd");
      if (look.uid === 0) {
        if (far.system !== "linux") return stop("root");
        if (!options.account) return { asks: "account", address, name };
        const made = await runSsh({
          ...reach.sshFor(address),
          command: ["/bin/sh", "-c", MAKE_ACCOUNT, "firstmate", HOME_ACCOUNT],
          timeoutMs: reach.options.lookTimeoutMs ?? LOOK_TIMEOUT_MS,
        });
        if (made.code === SSH_FAILED) return stop("unreachable");
        if (made.code !== 0 || !made.stdout.includes(`infinitary:account=${HOME_ACCOUNT}`))
          return stop("failed");
        const moved = accountAddress(address);
        if (!moved) return stop("failed");
        // The key line said yes to is that computer's, whichever account signs in.
        const remembered = pairing.rememberedHost(address);
        if (!remembered) return stop("host-unknown");
        const ownKey =
          (pairing.sshOptions(address)?.length ?? 0) >
          (pairing.hostTrustOptions(address)?.length ?? 0);
        try {
          pairing.rememberHost(moved, remembered);
          if (ownKey) pairing.ownKeyPlacedAt(moved);
        } catch {
          return stop("failed");
        }
        address = moved;
        step = reach.stepper(address);
        const again = await signIn(reach, address, {}, step);
        if (!("os" in again)) return "asks" in again ? again : stop(...again.stop);
        look = again;
        if (look.uid === 0) return stop("failed");
      }
      // Infinitary open there already answers this computer with a link: connect to it instead.
      const asked = await reach.askLink(address);
      if ("refusal" in asked) return stop(asked.refusal, reachOf(asked.reach));
      if ("link" in asked || asked.none === COMPUTER_LINK_NONE.tooOld)
        return { asks: "runs", address, name };
      if (asked.none === COMPUTER_LINK_NONE.noCurl) return stop("no-curl");
      if (cancelled()) return stop("cancelled");
      // 4. Infinitary: the Ubuntu package, or the copy for its system kept in its Applications folder.
      at = "send";
      step.say("setting-up", remoteLoginWords.settingUp(name), {
        name,
        copy: { state: "preparing" },
      });
      let program: string;
      let kept: string | null = null;
      if (packageRelease) {
        const secret = options.password ? Buffer.from(options.password, "utf8") : null;
        try {
          const installed = await reach.installUbuntu(look, {
            address,
            name,
            step,
            secret,
            stage: "setting-up",
          });
          if (installed !== "ready" && installed !== "linger-off") {
            if ("asks" in installed && installed.asks === "password") return installed;
            return stop("failed");
          }
        } finally {
          secret?.fill(0);
        }
        program = UBUNTU_PACKAGE_BIN;
      } else {
        if (reach.builds.fetches(far, chip))
          step.say("setting-up", remoteLoginWords.gettingBuild(name), {
            name,
            copy: { state: "preparing" },
          });
        const build = await reach.builds.for(far, chip);
        if ("refusal" in build) return stop(build.refusal);
        const receive = homeReceive(far, build.form);
        if (!receive) return stop("failed");
        const run = { id: `copy-${randomUUID()}` };
        const shown = name;
        const copy = copyCount(
          (bytes) =>
            step.say("setting-up", remoteLoginWords.sending(shown, bytes), {
              name: shown,
              copy: { state: "sending", sent: bytes },
              run,
            }),
          reach.options.copyEveryMs ?? 1_000,
        );
        const sent = await runSsh({
          ...reach.sshFor(address),
          command: [
            "/bin/sh",
            "-c",
            receive,
            "firstmate",
            build.form === "bundle" ? "" : build.sha256,
          ],
          stdin: (sink) => sendCopy(build, sink, copy.add),
          timeoutMs: reach.options.sendTimeoutMs ?? REMOTE_LOGIN_TIME_LIMIT_MS,
        });
        copy.end();
        if (sent.code === SSH_FAILED) return stop("unreachable", { reach: { step: "send" } });
        kept = /^infinitary:kept=(.+)$/m.exec(sent.stdout)?.[1]?.trim() ?? null;
        if (sent.stopped || sent.code !== 0 || !kept || !KEPT_PATH.test(kept))
          return stop("failed");
        program = kept;
      }
      if (cancelled()) {
        // Nothing runs there yet: the copy sent goes too.
        if (kept)
          await runSsh({
            ...reach.sshFor(address),
            command: ["/bin/rm", "-rf", kept],
            timeoutMs: reach.options.lookTimeoutMs ?? LOOK_TIMEOUT_MS,
          }).catch(() => undefined);
        return stop("cancelled");
      }
      // 5. Its own start-at-boot starts a first mate there, with that account's record or a fresh one.
      at = "start";
      step.say("setting-up", remoteLoginWords.starting(name), {
        name,
        copy: { state: "starting" },
      });
      const started = await runSsh({
        ...reach.sshFor(address),
        command: ["/bin/sh", "-c", HOME_START, "firstmate", program],
        timeoutMs: reach.options.lookTimeoutMs ?? LOOK_TIMEOUT_MS,
      });
      if (started.code === SSH_FAILED) return stop("unreachable");
      const said = readHomeStarted(started.stdout);
      if (said.boot !== 0) return stop("not-started");
      return {
        started: true,
        address,
        name,
        ...(look.user ? { user: look.user } : {}),
        lingerOff: said.lingerOff,
        waitsForLogin: said.waitsForLogin,
        private: said.private,
        ...(said.firewall ? { firewall: { name: said.firewall, port: CONNECTION_PORT } } : {}),
      };
    });
  } catch (error) {
    if (error instanceof RemoteLoginRefusedError) return stop(error.refusal, reachOf(error.reach));
    throw error;
  } finally {
    reach.cancels.delete(typed);
  }
}

type SignedIn =
  | (Look & { locality: "this-mac" | "elsewhere" })
  | Extract<HomeAtAnswer, { asks: "password" }>
  | { stop: [HomeAtRefusal, { reach?: RemoteLoginReach }] };

/**
 * The look, signed in with the person's own SSH; where that computer did
 * not let their key in, the password asked once lets Infinitary's own key
 * in and the look runs again. A Windows PC asks no password yet.
 */
async function signIn(
  reach: HomeReach,
  address: string,
  options: HomeAtOptions,
  step: ReturnType<HomeReach["stepper"]>,
): Promise<SignedIn> {
  let here: ReturnType<typeof placeLocalityChallenge>;
  try {
    here = (reach.options.here ?? placeLocalityChallenge)();
  } catch {
    return { stop: ["failed", {}] };
  }
  try {
    let look = await reach.look(address, here.path);
    if ("refusal" in look && look.refusal === "key-refused") {
      const methods = look.methods ?? null;
      if (methods?.length === 0) return { stop: ["password-off", {}] };
      if (hostPlatform() === "win32") return { stop: ["key-refused", {}] };
      const user = await signInUser(reach.options.ssh, address);
      const asked = { asks: "password" as const, address, ...(user ? { user } : {}) };
      if (!options.password) return asked;
      const letIn = await reach.letIn(address, methods, options.password, step);
      if (letIn === "wrong") return { ...asked, wrong: true };
      look = await reach.look(address, here.path);
      if ("refusal" in look && look.refusal === "key-refused")
        return { stop: ["key-not-taken", {}] };
    }
    if ("refusal" in look) return { stop: [look.refusal, reachOf(look.reach)] };
    return { ...look, locality: here.localityOf(look.here) };
  } finally {
    here.dispose();
  }
}

/** The same computer, at the same port, signed in to as the account made for the first mate. */
function accountAddress(address: string): string | null {
  const parts = addressParts(address);
  const host = parts.address.slice(parts.address.lastIndexOf("@") + 1);
  return addressAtPort(`${HOME_ACCOUNT}@${host}`, parts.port);
}

function reachOf(reach: RemoteLoginReach | undefined): { reach?: RemoteLoginReach } {
  return reach ? { reach } : {};
}
