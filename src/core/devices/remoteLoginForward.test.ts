import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { closeEach, home, server, THEIR_UID } from "../../../tests/helpers/remoteLoginHome";
import { socketScratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import { privateSocket } from "../helper/route";
import { hostEnv } from "../hostEnv";
import { claimLink } from "./dial";
import { SSH_OPTIONS } from "./ssh";

/**
 * The private socket the home's own SSH forwards (docs/devices.md, "Reached
 * over your SSH"): a computer's pinned connection reaches the home, private
 * to its user, and nothing else does (`tests/helpers/remoteLoginHome.ts`).
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

describe.runIf(SSH_SERVER_AVAILABLE)("a private socket the home's own SSH forwards", () => {
  /** SSH's options without its refusal to share a connection: this one is the app's own, kept private. */
  const OWN_MASTER = SSH_OPTIONS.filter(
    (option, index, all) => option !== "ControlMaster=no" && all[index + 1] !== "ControlMaster=no",
  );

  it("carries a computer's pinned connection to the home, private to its user, and nothing else", async () => {
    const sshd = await server();
    const ssh = sshd.ssh();
    // A forward the person's own SSH settings ask for, which the home's
    // connection must not open.
    const settings = ssh.args[1] ?? "";
    const unasked = await claimedPort();
    writeFileSync(
      settings,
      `${readFileSync(settings, "utf8")}  LocalForward 127.0.0.1:${unasked} 127.0.0.1:9\n`,
    );
    const at = await home({ ssh, bundle: null });
    const control = join(socketScratchDir("fm-c-"), "c");
    const socket = join(socketScratchDir("fm-r-"), "h");
    const env = hostEnv();
    delete env.SSH_ASKPASS;
    delete env.SSH_ASKPASS_REQUIRE;
    const master = spawn(
      ssh.program,
      [
        ...ssh.args,
        ...OWN_MASTER,
        "-o",
        "ControlPersist=no",
        "-M",
        "-S",
        control,
        "-N",
        "--",
        sshd.address,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let said = "";
    master.stderr?.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
    });
    const exited = new Promise((resolve) => master.once("exit", resolve));
    /** One request on the app's own control socket, never a connection of its own. */
    const ask = (...args: string[]) =>
      new Promise<number | null>((resolve) => {
        const asked = spawn(
          "/usr/bin/ssh",
          ["-F", "/dev/null", "-S", control, "-o", "BatchMode=yes", ...args, "--", sshd.address],
          { env, stdio: "ignore" },
        );
        asked.once("exit", resolve);
      });
    const reaches = (path: string | number) =>
      new Promise<boolean>((resolve) => {
        const dialed = typeof path === "number" ? connect(path, "127.0.0.1") : connect(path);
        dialed.once("connect", () => {
          dialed.destroy();
          resolve(true);
        });
        dialed.once("error", () => resolve(false));
      });
    try {
      await vi.waitFor(() => expect(existsSync(control), said).toBe(true), { timeout: 5_000 });
      expect(await reaches(unasked)).toBe(false);
      const forward = `${socket}:127.0.0.1:${at.port}`;
      expect(await ask("-O", "forward", "-R", forward)).toBe(0);
      await vi.waitFor(() => expect(existsSync(socket)).toBe(true));
      // SSH makes it for this user alone, and a dial's route takes it.
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      expect(privateSocket(socket)).toBe(true);

      const { link } = at.pairing.invite(
        { kind: "work" },
        { remoteLogin: sshd.address, via: "ssh", locality: "elsewhere" },
      );
      await at.settled();
      const grant = await claimLink(
        link,
        { kind: "work", name: "Mac mini", user: { name: "sam", uid: THEIR_UID } },
        { target: { socket } },
      );
      expect(grant.via).toBe("ssh");
      const client = await connectClient(grant, { dial: { target: { socket } } });
      expect(client.welcome).toMatchObject({ t: "welcome", takesWork: true });
      await client.close();

      // Cancelled, the socket answers nothing more. SSH answers the cancel
      // once it has sent it, before the server closes its listener.
      expect(await ask("-O", "cancel", "-R", forward)).toBe(0);
      await vi.waitFor(async () => expect(await reaches(socket)).toBe(false), { timeout: 5_000 });
      expect(await ask("-O", "exit")).toBe(0);
      await exited;
      // With its connection gone, a request on its control socket fails
      // rather than open a connection of its own.
      expect(await ask("-O", "check")).not.toBe(0);
    } finally {
      if (master.exitCode === null && master.signalCode === null) master.kill();
    }
  });
});
