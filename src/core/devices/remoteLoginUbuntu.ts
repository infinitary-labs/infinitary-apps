import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { type DeviceView, deviceLabel } from "@shared/devices";
import {
  type BackgroundState,
  REMOTE_LOGIN_TIME_LIMIT_MS,
  type RemoteLoginAddAnswer,
  type RemoteLoginCopy,
  type RemoteLoginPasswordQuestion,
  type RemoteLoginReach,
  type RemoteLoginRefusal,
  type RemoteLoginStage,
  readWorkOutcome,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { copyCount } from "./appArchive";
import { type FarBuild, type FarBuilds, sendCopy } from "./farBuilds";
import { farSystemOf, onHomeMacWord, REMOTE_PATH } from "./farSystems";
import type { DevicePairing } from "./pairing";
import { runSsh, SSH_FAILED, type SshProgram, type SshResult } from "./ssh";
import { sshRefusal } from "./sshRefusal";
import {
  lingerOff,
  RECEIVE_DEB,
  type SudoRight,
  sudoInstallCommand,
  sudoRejected,
  UBUNTU_PACKAGE_BIN,
  ubuntuInstallNeed,
  writeSecret,
} from "./ubuntuPackage";

/**
 * The Ubuntu package on a computer reached over Remote Login (docs/devices.md,
 * "The Ubuntu package"): installed when it is missing or another version, with
 * that account's password on `sudo -S`'s input, for an add, a setup from the
 * welcome screen and an update; and a computer that runs it updated in place.
 * `RemoteLogin` composes it over its own SSH trust, builds and list.
 */

/** What the package's install and update reach of `RemoteLogin`. */
type UbuntuHost = {
  options: {
    pairing: Pick<DevicePairing, "identity" | "noteSystem">;
    /** This app's version, which an Ubuntu package there is compared with. */
    version?: string;
    copyEveryMs?: number;
    sendTimeoutMs?: number;
  };
  builds: Pick<FarBuilds, "for">;
  sshFor: (address: string) => { ssh: SshProgram; address: string; options?: readonly string[] };
  refusedOver: (
    address: string,
    refusal: RemoteLoginRefusal,
    sending?: boolean,
  ) => Promise<{ refusal: RemoteLoginRefusal; reach?: RemoteLoginReach }>;
  device: (deviceId: string) => DeviceView;
};

/** One operation's steps in the feed, as `RemoteLogin`'s stepper says them. */
type UbuntuStep = {
  say: (
    stage: RemoteLoginStage,
    text: string,
    extra?: { name?: string; deviceId?: string; copy?: RemoteLoginCopy; run?: { id: string } },
  ) => unknown;
  caution: (said: readonly string[], extra?: { name?: string; deviceId?: string }) => void;
  uncertain: (name: string) => never;
  stopped: (name: string, why: NonNullable<SshResult["stopped"]>) => never;
  warn: (refusal: RemoteLoginRefusal) => void;
  refuse: (refusal: RemoteLoginRefusal, at?: { name?: string; reach?: RemoteLoginReach }) => never;
};

/** What the look found there that the install reads. */
type UbuntuLook = { user?: string; sudo?: SudoRight; pkg?: string };

/**
 * An Ubuntu package that matches this computer's version there: `ready`, or
 * `linger-off` when the install just made it so but could not let that
 * user's work keep running after they log out, where systemd does not run.
 */
type UbuntuReady = "ready" | "linger-off";

const SEND_TIMEOUT_MS = REMOTE_LOGIN_TIME_LIMIT_MS;
/** The copy's count is said at most this often between its first bytes and its end. */
const COPY_EVERY_MS = 1_000;

export class RemoteLoginUbuntu {
  constructor(private readonly host: UbuntuHost) {}

  /**
   * Installs the Ubuntu package when it is missing or another version, with
   * the password on `sudo -S`'s input. `ready` once the package matches, or
   * `linger-off` once this install put it there but could not let that
   * user's work keep running after they log out (`LINGER_OFF_LINE`).
   * A password that did not work is asked again; it is not logged.
   */
  async installUbuntu(
    look: UbuntuLook,
    at: {
      address: string;
      name: string;
      step: UbuntuStep;
      secret: Buffer | null;
      stage: "setting-up" | "finding" | "updating";
      deviceId?: string;
      /** Runs once the install goes ahead, past the password question and before anything is sent. */
      beforeInstall?: () => Promise<void>;
    },
  ): Promise<RemoteLoginAddAnswer | UbuntuReady> {
    const need = ubuntuInstallNeed(look, this.host.options.version ?? "");
    if (need === "ready") return "ready";
    if (need === "refused") return at.step.refuse("cannot-install", { name: at.name });
    if (need === "ask" && !at.secret) {
      return {
        asks: "password",
        address: at.address,
        ...(look.user ? { user: look.user } : {}),
        for: at.stage === "updating" ? "update" : "install",
        ...(at.deviceId ? { deviceId: at.deviceId } : {}),
      };
    }
    await at.beforeInstall?.();
    const said = {
      name: at.name,
      ...(at.deviceId ? { deviceId: at.deviceId } : {}),
      copy: { state: "preparing" as const },
    };
    at.step.say(
      at.stage === "updating" ? "updating" : at.stage,
      remoteLoginWords.gettingBuild(at.name),
      said,
    );
    const linux = farSystemOf("Linux");
    if (!linux) return at.step.refuse("other-system", { name: at.name });
    const build = await this.host.builds.for(linux, "x64", "deb");
    if ("refusal" in build) return at.step.refuse(build.refusal, { name: at.name });
    if (build.form === "bundle") return at.step.refuse("failed", { name: at.name });
    const sent = await this.sendDeb(at.address, build, at);
    if (sent === "stopped") return at.step.stopped(at.name, "timeout");
    if (sent === "failed") return at.step.refuse("failed", { name: at.name });
    at.step.say(
      at.stage === "updating" ? "updating" : at.stage,
      remoteLoginWords.installing(at.name),
      { name: at.name, ...(at.deviceId ? { deviceId: at.deviceId } : {}) },
    );
    const outcome = await this.runInstall(
      at.address,
      sent,
      build.sha256,
      need === "ask" ? at.secret : null,
    );
    if (outcome === "wrong") {
      at.step.warn("password-wrong");
      return {
        asks: "password",
        address: at.address,
        ...(look.user ? { user: look.user } : {}),
        wrong: true,
        for: at.stage === "updating" ? "update" : "install",
        ...(at.deviceId ? { deviceId: at.deviceId } : {}),
      };
    }
    if (outcome === "mismatch") return at.step.refuse("build-unverified", { name: at.name });
    // Stopped while the installer ran: it may already have installed it.
    if (outcome === "stopped")
      return at.stage === "updating"
        ? at.step.uncertain(at.name)
        : at.step.stopped(at.name, "timeout");
    if (outcome === "linger-off") return "linger-off";
    if (outcome !== "ok") return at.step.refuse("failed", { name: at.name });
    return "ready";
  }

  /** Sends the checked deb and answers the path it was kept at, `stopped` by the time limit, or `failed`. */
  private async sendDeb(
    address: string,
    build: Exclude<FarBuild, { form: "bundle" }>,
    at: {
      name: string;
      step: UbuntuStep;
      stage: RemoteLoginStage;
      deviceId?: string;
    },
  ): Promise<string | "stopped" | "failed"> {
    const run = { id: `copy-${randomUUID()}` };
    const copy = copyCount(
      (bytes) =>
        at.step.say(
          at.stage === "updating" ? "updating" : at.stage,
          remoteLoginWords.sending(at.name, bytes),
          {
            name: at.name,
            ...(at.deviceId ? { deviceId: at.deviceId } : {}),
            copy: { state: "sending", sent: bytes },
            run,
          },
        ),
      this.host.options.copyEveryMs ?? COPY_EVERY_MS,
    );
    const ran = await runSsh({
      ...this.host.sshFor(address),
      command: ["/bin/sh", "-c", RECEIVE_DEB, "firstmate", build.sha256],
      stdin: (sink) => sendCopy(build, sink, copy.add),
      timeoutMs: this.host.options.sendTimeoutMs ?? SEND_TIMEOUT_MS,
    });
    copy.end();
    if (ran.stopped) return "stopped";
    const path = /^infinitary:deb=(\/\S+)$/m.exec(ran.stdout)?.[1] ?? "";
    if (ran.code !== 0 || !REMOTE_PATH.test(path)) return "failed";
    return path;
  }

  /**
   * Installs the deb already checked there. The password, when one is
   * needed, is written to `sudo -S` and then zeroed by the caller. stderr
   * is read only for sudo's own refusal, and is not logged; stdout only for
   * the line that says linger could not be turned on (`linger-off`).
   */
  private async runInstall(
    address: string,
    debPath: string,
    sha256: string,
    secret: Buffer | null,
  ): Promise<"ok" | "linger-off" | "wrong" | "mismatch" | "stopped" | "failed"> {
    const ran = await runSsh({
      ...this.host.sshFor(address),
      command: sudoInstallCommand(debPath, sha256, secret !== null),
      ...(secret ? { stdin: (sink: Writable) => writeSecret(secret, sink) } : {}),
      timeoutMs: this.host.options.sendTimeoutMs ?? SEND_TIMEOUT_MS,
    });
    if (ran.stopped) return "stopped";
    if (ran.code === 0) return lingerOff(ran.stdout) ? "linger-off" : "ok";
    if (ran.code === 65) return "mismatch";
    if (secret && sudoRejected(ran.stderr)) return "wrong";
    if (ran.code === SSH_FAILED) return "failed";
    return "failed";
  }

  /** Updates an Ubuntu package computer: the password again, then the new package, then a restart. */
  async updateUbuntu(
    device: DeviceView,
    look: UbuntuLook,
    options: { password?: string; pause?: (lost: () => never) => Promise<void> },
    step: UbuntuStep,
    address = device.remoteLogin ?? "",
    verifyReturn = false,
  ): Promise<DeviceView | RemoteLoginPasswordQuestion> {
    if (!verifyReturn && ubuntuInstallNeed(look, this.host.options.version ?? "") === "ready")
      return step.refuse("current");
    const secret = options.password ? Buffer.from(options.password, "utf8") : null;
    // Its crew's work is saved once, past the password question and before
    // the package is sent, or before `work update` when none is installed.
    let saved = false;
    const save = async () => {
      if (saved) return;
      saved = true;
      await options.pause?.(() => step.refuse("out-of-reach"));
    };
    try {
      const installed = await this.installUbuntu(look, {
        address,
        name: deviceLabel(device),
        step,
        secret,
        stage: "updating",
        deviceId: device.id,
        beforeInstall: save,
      });
      if (installed !== "ready" && installed !== "linger-off") {
        if ("asks" in installed && installed.asks === "password") return installed;
        return step.refuse("failed");
      }
      await save();
      if (verifyReturn) {
        const name = deviceLabel(device);
        step.say("updating", remoteLoginWords.starting(name), {
          deviceId: device.id,
          name,
          copy: { state: "starting" },
        });
      }
      const onHomeMac = onHomeMacWord(device);
      const ran = await runSsh({
        ...this.host.sshFor(address),
        command: [
          UBUNTU_PACKAGE_BIN,
          "work",
          "update",
          "--from-home",
          "--home",
          this.host.options.pairing.identity().pin,
          "--device",
          device.id,
          ...(onHomeMac ? ["--on-home-mac", onHomeMac] : []),
        ],
        timeoutMs: this.host.options.sendTimeoutMs ?? SEND_TIMEOUT_MS,
      });
      const outcome = readWorkOutcome(ran.stdout);
      if (outcome?.firstmate === "updated") {
        if (outcome.background === "unavailable" || outcome.background === "unknown") {
          this.host.options.pairing.noteSystem(device.id, { automaticStartup: outcome.background });
          step.caution([remoteLoginWords.startup(device, outcome.background)], {
            deviceId: device.id,
          });
        }
        if (!verifyReturn)
          step.say("done", remoteLoginWords.updated(device, outcome.background), {
            deviceId: device.id,
          });
        if (outcome.background === "failed")
          step.caution(remoteLoginWords.notInBackground(device, "update"), { deviceId: device.id });
        if (installed === "linger-off")
          step.caution(afterLogoutLines(device, device.user ?? look.user, outcome.background), {
            deviceId: device.id,
          });
        return this.host.device(device.id);
      }
      // Stopped by the time limit while `work update` ran there: it may already have updated.
      if (ran.stopped) return step.uncertain(deviceLabel(device));
      // The package is already there: a connection lost now is lost while sending.
      if (ran.code === SSH_FAILED) {
        const refused = await this.host.refusedOver(address, sshRefusal(ran.stderr), true);
        return step.refuse(refused.refusal, reachOf(refused.reach));
      }
      return step.refuse("failed");
    } finally {
      secret?.fill(0);
    }
  }
}

/**
 * After an Ubuntu install that could not turn on linger there, once the work
 * runs in the background or starts at the next login: the one line an
 * administrator runs there so it keeps running after `user` logs out. None
 * when it could not set itself up there, whose own lines say so.
 */
export function afterLogoutLines(
  device: DeviceView,
  user: string | undefined,
  background: BackgroundState,
): readonly string[] {
  if (!user || (background !== "running" && background !== "at-login")) return [];
  return remoteLoginWords.afterLogout(device, user);
}

/** The step a refusal could not reach the computer at, as the refusal's words take it. */
function reachOf(reach: RemoteLoginReach | undefined): { reach?: RemoteLoginReach } {
  return reach ? { reach } : {};
}
