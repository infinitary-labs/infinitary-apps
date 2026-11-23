import { randomUUID } from "node:crypto";
import { CONNECTION_PORT } from "@shared/connection";
import type {
  HomeAtAnswer,
  HomeAtOptions,
  HomeAtRefusal,
  HomeAtRefused,
  HomeStep,
} from "@shared/homeAt";
import { COMPUTER_LINK_NONE, type ComputerLinkNone } from "@shared/phoneLink";
import {
  addressAtPort,
  addressParts,
  parseRemoteLoginAddress,
  REMOTE_LOGIN_TIME_LIMIT_MS,
  type RemoteLoginReach,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { copyCount } from "./appArchive";
import type { FarBuilds } from "./farBuilds";
import { HOME_ACCOUNT, HOME_START, homeReceive, MAKE_ACCOUNT, readHomeStarted } from "./farHome";
import { farSystemOf } from "./farSystems";
import { placeLocalityChallenge } from "./locality";
import {
  type Look,
  type RemoteLogin,
  type RemoteLoginOptions,
  RemoteLoginRefusedError,
  sendCopy,
} from "./remoteLogin";
import { runSsh, SSH_FAILED } from "./ssh";
import { sshRefusal } from "./sshRefusal";
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
  withPassword: RemoteLogin["withPassword"];
  refusedOver: RemoteLogin["refusedOver"];
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
  /** Something there changed: an account made, or the Ubuntu package going in. */
  let changed = false;
  const stop = (
    refused: HomeAtRefusal,
    more: Partial<Omit<HomeAtRefused, "refused" | "step">> = {},
  ): HomeAtRefused => ({
    refused,
    step: at,
    ...(name ? { name } : {}),
    ...(changed ? { changed: true as const } : {}),
    ...more,
  });
  const asked = typed;
  const cancelled = () => reach.cancels.has(asked);
  try {
    // Only the run that holds this address clears its cancel: a second call
    // refused by `once` leaves the running setup's cancel standing.
    return await reach.once(typed, async (): Promise<HomeAtAnswer> => {
      reach.cancels.delete(typed);
      try {
        return await setUp(asked);
      } finally {
        reach.cancels.delete(typed);
      }
    });
  } catch (error) {
    if (error instanceof RemoteLoginRefusedError) return stop(error.refusal, reachOf(error.reach));
    throw error;
  }

  async function setUp(typedAddress: string): Promise<HomeAtAnswer> {
    const { pairing } = reach.options;
    let address = typedAddress;
    let step = reach.stepper(address);
    // 1. Its SSH key, asked once before any sign-in.
    const gated = await reach.confirmHost(address, options.confirm);
    if ("asks" in gated) return gated;
    if ("refusal" in gated) return stop(gated.refusal, reachOf(gated.reach));
    if (cancelled()) return stop("cancelled");
    // 2. A sign-in with the person's own SSH, or the password once, which lets Infinitary's own key in.
    at = "sign-in";
    step.say("reaching", remoteLoginWords.reaching(address));
    const signedIn = await signIn(reach, address, options.password, step);
    if (!("os" in signedIn)) return "asks" in signedIn ? signedIn : stop(...signedIn.stop);
    let look: Look = signedIn;
    if (cancelled()) return stop("cancelled");
    // 3. Its system: what it is, what it lacks, whether it starts at boot, and who signed in.
    at = "look";
    const computer = look.name ?? address;
    name = computer;
    const far = farSystemOf(look.os);
    const chip = far?.chips[look.arch ?? ""];
    if (!far || !chip) return stop("other-system");
    if (signedIn.locality === "this-mac" && look.uid === pairing.ownUid) return stop("same-user");
    const packageRelease = reach.builds.readsPublished() ? ubuntuPackageRelease(look) : null;
    const checked = lookStop(look, packageRelease !== null, far, chip, reach.builds);
    if (checked) return stop(...checked);
    // The Ubuntu package goes in over the sign-in that may install software.
    const installer = { address, look };
    if (look.uid === 0) {
      if (far.system !== "linux") return stop("root");
      if (!options.account) return { asks: "account", address, name: computer };
      // From here an account may be part made, so a stop no longer says nothing changed.
      changed = true;
      const made = await runSsh({
        ...reach.sshFor(address),
        command: ["/bin/sh", "-c", MAKE_ACCOUNT, "firstmate", HOME_ACCOUNT],
        timeoutMs: reach.options.lookTimeoutMs ?? LOOK_TIMEOUT_MS,
      });
      if (made.code === SSH_FAILED) {
        const refused = await reach.refusedOver(address, sshRefusal(made.stderr));
        return stop(refused.refusal, reachOf(refused.reach));
      }
      if (made.code !== 0 || !made.stdout.includes(`infinitary:account=${HOME_ACCOUNT}`))
        return stop("failed");
      const moved = accountAddress(address);
      if (!moved) return stop("failed");
      // The key line said yes to is that computer's, whichever account signs in.
      const remembered = pairing.rememberedHost(address);
      if (!remembered) return stop("host-unknown");
      const ownKey = pairing.ownKeyPlacedIn(address);
      try {
        pairing.rememberHost(moved, remembered);
        if (ownKey) pairing.ownKeyPlacedAt(moved);
      } catch {
        return stop("failed");
      }
      address = moved;
      step = reach.stepper(address);
      const again = await signIn(reach, address, undefined, step);
      // The account made has no password: a question here would only ask again.
      if (!("os" in again)) return "asks" in again ? stop("key-not-taken") : stop(...again.stop);
      if (again.uid === 0) return stop("failed");
      // What root may do there says nothing of what the account may: check it again as the account.
      const recheck = lookStop(again, packageRelease !== null, far, chip, reach.builds);
      if (recheck) return stop(...recheck);
      look = again;
    }
    // Infinitary open there already answers this computer with a link: connect to it instead.
    const link = await reach.askLink(address);
    if ("refusal" in link) return stop(link.refusal, reachOf(link.reach));
    if ("link" in link || link.none === COMPUTER_LINK_NONE.tooOld)
      return { asks: "runs", address, name: computer };
    // Only an account with no Infinitary open goes on: any other answer means one may run there.
    if (link.none !== COMPUTER_LINK_NONE.notOpen) return stop(linkNoneStop(link.none));
    if (cancelled()) return stop("cancelled");
    // 4. Infinitary: the Ubuntu package, or the copy for its system kept in its Applications folder.
    at = "send";
    step.say("setting-up", remoteLoginWords.settingUp(computer), {
      name: computer,
      copy: { state: "preparing" },
    });
    let program: string;
    let kept: string | null = null;
    if (packageRelease) {
      const secret = options.password ? Buffer.from(options.password, "utf8") : null;
      try {
        const installed = await reach.installUbuntu(installer.look, {
          address: installer.address,
          name: computer,
          step,
          secret,
          stage: "setting-up",
          beforeInstall: async () => {
            changed = true;
          },
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
        step.say("setting-up", remoteLoginWords.gettingBuild(computer), {
          name: computer,
          copy: { state: "preparing" },
        });
      const build = await reach.builds.for(far, chip);
      if ("refusal" in build) return stop(build.refusal);
      const receive = homeReceive(far, build.form);
      if (!receive) return stop("failed");
      const run = { id: `copy-${randomUUID()}` };
      const shown = computer;
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
      if (sent.code === SSH_FAILED) {
        const refused = await reach.refusedOver(address, sshRefusal(sent.stderr), true);
        return stop(refused.refusal, reachOf(refused.reach));
      }
      kept = /^infinitary:kept=(.+)$/m.exec(sent.stdout)?.[1]?.trim() ?? null;
      if (sent.stopped || sent.code !== 0 || !kept || !KEPT_PATH.test(kept)) return stop("failed");
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
    step.say("setting-up", remoteLoginWords.starting(computer), {
      name: computer,
      copy: { state: "starting" },
    });
    const started = await runSsh({
      ...reach.sshFor(address),
      command: ["/bin/sh", "-c", HOME_START, "firstmate", program],
      timeoutMs: reach.options.lookTimeoutMs ?? LOOK_TIMEOUT_MS,
    });
    if (started.code === SSH_FAILED) {
      const refused = await reach.refusedOver(address, sshRefusal(started.stderr));
      return stop(refused.refusal, reachOf(refused.reach));
    }
    const said = readHomeStarted(started.stdout);
    if (said.boot !== 0) return stop("not-started");
    return {
      started: true,
      address,
      name: computer,
      ...(look.user ? { user: look.user } : {}),
      lingerOff: said.lingerOff,
      waitsForLogin: said.waitsForLogin,
      private: said.private,
      ...(said.firewall ? { firewall: { name: said.firewall, port: CONNECTION_PORT } } : {}),
    };
  }
}

/**
 * The look's own stops for the account signed in to: tools it lacks, a
 * sandbox it cannot use and a copy this computer cannot send, unless the
 * Ubuntu package brings all three, and a Linux computer with no systemd.
 */
function lookStop(
  look: Look,
  ubuntuPackage: boolean,
  far: Parameters<FarBuilds["canSend"]>[0],
  chip: Parameters<FarBuilds["canSend"]>[1],
  builds: FarBuilds,
): [HomeAtRefusal, Partial<Omit<HomeAtRefused, "refused" | "step">>] | null {
  // A first mate started beside a work grant, or a closed window's, would share that account's record with another first mate.
  if (look.joined || look.windowHome) return ["already-joined", {}];
  if (!ubuntuPackage) {
    if (look.needs.length > 0)
      return ["needs-tools", { missing: look.needs, installs: look.installs }];
    if (look.sandboxOff) return ["sandbox-off", {}];
    if (!builds.canSend(far, chip)) return ["cannot-send", {}];
  }
  if (far.system === "linux" && !look.systemd) return ["no-systemd", {}];
  return null;
}

/** Why a computer that answered with no link, other than none open, stops the setup. */
function linkNoneStop(none: ComputerLinkNone): HomeAtRefusal {
  switch (none) {
    case COMPUTER_LINK_NONE.noCurl:
      return "no-curl";
    case COMPUTER_LINK_NONE.controls:
      return "controls";
    default:
      return "no-link";
  }
}

type SignedIn =
  | (Look & { locality: "this-mac" | "elsewhere" })
  | Extract<HomeAtAnswer, { asks: "password" }>
  | { stop: [HomeAtRefusal, { reach?: RemoteLoginReach }] };

/** The look, signed in with the person's own SSH or, where their key was not let in, the password once. */
async function signIn(
  reach: HomeReach,
  address: string,
  password: string | undefined,
  step: ReturnType<HomeReach["stepper"]>,
): Promise<SignedIn> {
  let here: ReturnType<typeof placeLocalityChallenge>;
  try {
    here = (reach.options.here ?? placeLocalityChallenge)();
  } catch {
    return { stop: ["failed", {}] };
  }
  try {
    const signed = await reach.withPassword(address, password, step, () =>
      reach.look(address, here.path),
    );
    if ("asks" in signed) return signed;
    if ("keyStop" in signed) return { stop: [signed.keyStop, {}] };
    const look = signed.ran;
    if ("refusal" in look)
      return { stop: [look.refusal, reachOf("reach" in look ? look.reach : undefined)] };
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
