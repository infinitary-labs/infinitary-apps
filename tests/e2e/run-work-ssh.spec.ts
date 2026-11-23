import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import { deviceLabel } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import electronPath from "electron";
import { startConnection } from "../../src/core/connection/connection";
import { FarBuilds } from "../../src/core/devices/farBuilds";
import { farSystemNamed } from "../../src/core/devices/farSystems";
import { joinCommand, shellWord } from "../../src/core/devices/joinCommand";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { DevicePairing } from "../../src/core/devices/pairing";
import { RemoteLogin } from "../../src/core/devices/remoteLogin";
import { SshConnections } from "../../src/core/devices/sshConnections";
import { CoreEventBus } from "../../src/core/events";
import { readInstalled } from "../../src/core/helper/background";
import { HomeRoute } from "../../src/core/helper/route";
import { helperWords } from "../../src/core/helper/words";
import { WorkingCopies } from "../../src/core/helper/workingCopies";
import { WorkDevices } from "../../src/core/placed/workDevices";
import { deviceChipOf } from "../../src/shared/platform";
import { claimedPort } from "../helpers/claimedPort";
import { scratchDir, socketScratchDir } from "../helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, type SshServer, startSshServer } from "../helpers/sshServer";
import { builtAppDir } from "./launch";
import {
  appVersion,
  connections,
  endRunWork,
  home,
  ME,
  noUbuntuPackage,
  onLinuxThatRunsIt,
  pairings,
  sshServers,
  sshStops,
  standIn,
  THIS_MAC,
  terminal,
  user,
  work,
} from "./runWork";
import { seedRetainedAccountDirectory, seedRetainedSignInSentinel } from "./workFixtures";

/**
 * A computer that runs work which the home reaches through its own SSH
 * connection (docs/helper.md, "Through the home's SSH"): a Mac added by its
 * address over Remote Login, one a command joined and the home finds again by
 * its address, one whose old home is gone for good, and a run that dials
 * only the route the home's connection keeps.
 */

test.afterEach(endRunWork);

/**
 * A Firstmate whose program starts the built app, as an installed
 * Firstmate's own program is the app itself: what the home sends. On Linux
 * it is the AppImage the home sends there, one file that is its own program
 * (src/core/devices/farSystems.ts).
 */
function builtAppBundle(): string {
  if (process.platform === "linux") {
    const app = join(scratchDir("infinitary-run-work-bundle-"), "infinitary.AppImage");
    writeFileSync(
      app,
      `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
      { mode: 0o755 },
    );
    return app;
  }
  const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(bundle, "Contents", "MacOS", "Firstmate 3000"),
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
  );
  chmodSync(join(bundle, "Contents", "MacOS", "Firstmate 3000"), 0o755);
  return bundle;
}

function programOf(kept: string): string {
  return kept.endsWith(".AppImage") ? kept : join(kept, "Contents", "MacOS", "Firstmate 3000");
}

/**
 * Marks a copy so a later copy tells them apart: a file in a Mac's bundle,
 * or a last line of an AppImage, which its shell never reaches.
 */
function markCopy(app: string, text: string): void {
  if (app.endsWith(".AppImage")) appendFileSync(app, `# mark: ${text}\n`);
  else writeFileSync(join(app, "Contents", "version"), `${text}\n`);
}

function copyMark(app: string): string {
  if (!app.endsWith(".AppImage")) return readFileSync(join(app, "Contents", "version"), "utf8");
  const mark = /^# mark: (.*)$/m.exec(readFileSync(app, "utf8"))?.[1];
  return mark === undefined ? "" : `${mark}\n`;
}

/**
 * A home that adds Macs by their address: pairing kept in `dir`, answering
 * at a port of its own, with its own SSH connection to each Mac it reaches
 * that way, and `bundle` for a command or Remote Login to get. Started again
 * on the same folder at another port, it is the same home after it moved.
 * `said` holds each line it says, but the copy's moving count.
 */
async function sshHome(options: {
  sshd: SshServer;
  them: ReturnType<typeof user>;
  bundle: string;
  dir: string;
  controlBase: string;
  said: string[];
}) {
  const { sshd, them, bundle, dir, controlBase, said } = options;
  const remoteEnv = Object.fromEntries(
    [
      "HOME",
      "CFFIXED_USER_HOME",
      "INFINITARY_HELPER_DATA_DIR",
      "XDG_CONFIG_HOME",
      "INFINITARY_LAUNCHCTL",
      "INFINITARY_SYSTEMCTL",
      "INFINITARY_DEVICE_NAME",
      "ELECTRON_RENDERER_URL",
      "PI_OFFLINE",
    ].map((name) => [name, them.env[name] ?? ""]),
  );
  const port = await claimedPort();
  const pairing = new DevicePairing({
    dir,
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownUid: ME.uid + 1,
  });
  pairings.push(pairing);
  // What a computer that names its system gets: this app's own, as the app's own wiring answers.
  const builds = new FarBuilds({
    own: () => bundle,
    published: null,
    chip: deviceChipOf(process.arch),
  });
  const connection = startConnection({
    dispatch: standIn,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    app: () => bundle,
    build: async (system, chip) => {
      const far = farSystemNamed(system);
      const on = chip ?? deviceChipOf(process.arch);
      const build = far && on ? await builds.for(far, on) : null;
      return build && !("refusal" in build) ? build : null;
    },
  });
  connections.push(connection);
  const work = new WorkDevices();
  work.attach(connection);
  const ssh = sshd.ssh({ remote: remoteEnv });
  const sshConnections: SshConnections = new SshConnections({
    pairing,
    ssh,
    flavor: "dev",
    listening: () => work.listening(),
    settled: () => work.settled(),
    welcomed: (deviceId) => work.inReach(deviceId) || work.version(deviceId) !== undefined,
    onWorkDevice: (listener) => work.onWorkDevice(listener),
    cleanUpThere: (cleanup) => remote.cleanUpThere(cleanup),
    emit: (event) => said.push(event.text),
    changed: () => {},
    controlBase,
    retryMs: [100, 200],
    beatMs: 1_000,
  });
  const remote: RemoteLogin = new RemoteLogin({
    pairing,
    ssh,
    flavor: "dev",
    appBundle: () => bundle,
    listening: () => connection.settled(),
    inReach: (deviceId) => work.inReach(deviceId),
    connections: sshConnections,
    controlBase,
    // Every line but the copy's moving count of what it sent so far.
    emit: (event) => {
      if (event.copy?.state !== "sending") said.push(event.text);
    },
  });
  const stopSsh = sshConnections.start();
  sshStops.push(stopSsh);
  return { pairing, port, connection, remote, sshConnections, stopSsh };
}

test("a Mac added by its address over Remote Login: the copy joins through the home's own SSH connection, runs in the background over it, is updated, stays in reach when the home moves, and is removed", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  const sshd = await startSshServer();
  sshServers.push(sshd);
  const bundle = builtAppBundle();
  // The user there: a home of its own, its work's folder, and a launchctl that writes down what it was asked.
  const them = user();
  const said: string[] = [];
  const dir = join(scratchDir("infinitary-run-work-home-"), "devices");
  const controlBase = socketScratchDir("fm-c-");
  const homeAt = () => sshHome({ sshd, them, bundle, dir, controlBase, said });
  const first = await homeAt();
  const { remote } = first;

  // Added: the copy got over SSH joined through the socket the home forwarded, kept itself and set up its agent.
  const asked = await remote.addOrAsk(sshd.address);
  if (!("asks" in asked) || asked.asks !== "confirm")
    throw new Error("The first reach did not ask for the check line.");
  const device = await remote.add(sshd.address, { confirm: asked.line });
  expect(device).toMatchObject({
    kind: "work",
    name: "Studio Mac",
    user: ME.name,
    remoteLogin: sshd.address,
  });
  expect(said.slice(0, 2)).toEqual([
    remoteLoginWords.reaching(sshd.address),
    remoteLoginWords.settingUp("Studio Mac"),
  ]);
  const kept = join(them.dataDir, "app", basename(bundle));
  const installed = readInstalled(them.dataDir);
  expect(installed.app).toBe(kept);
  expect(readFileSync(installed.service?.file ?? "", "utf8")).toContain(
    them.background.holds(programOf(kept)),
  );
  // Another user here, added at this Mac's own address: the home's look found
  // it on this Mac and its welcome says so, so its agent keeps the low
  // priority (captain on INF-255), and its grant keeps that word.
  expect(readFileSync(installed.service?.file ?? "", "utf8")).not.toContain("ProcessType");
  const grant = new JoinedHome(them.dataDir, () => {}).read()?.grant;
  expect(grant).toMatchObject({ deviceId: device.id, via: "ssh", onHomeMac: true });
  if (!grant) throw new Error("Nothing joined there.");
  // The home's SSH connection runs the copy's own controller, which keeps its route there.
  await expect
    .poll(() => new HomeRoute(them.dataDir).current(grant), { timeout: 30_000 })
    .not.toBeNull();
  expect(first.sshConnections.state(device.id)).toEqual({ state: "connecting" });

  // Its run dials that route, and is in reach of the home: connected using SSH.
  const place = { thisMac: false, host: "127.0.0.1", overSsh: true };
  const running = work(["run"], them.env);
  writeFileSync(them.agentPid, `${running.child.pid}\n`);
  await expect.poll(running.lines).toContain(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => first.sshConnections.state(device.id)).toEqual({ state: "connected" });

  // A grant kept before its home said where it runs (INF-472), as a join
  // before alpha 0.5.0-alpha.5 kept it: the update below decides its agent.
  const joinedHome = new JoinedHome(them.dataDir, () => {});
  const joined = joinedHome.read();
  if (!joined) throw new Error("Nothing joined there.");
  const { onHomeMac: _said, ...unheard } = joined.grant;
  joinedHome.join(unheard, joined.joinedAt);
  if (joined.name) joinedHome.name(joined.name);

  // Updated: the connection lets go, this Mac's Firstmate goes there again and replaces the
  // copy, and the connection is made again to the new copy. The service manager here is a
  // stand-in, so the journey starts the new copy where its agent would: it proves the copy's
  // transfer and replacement and the return to reach, not an agent starting it unattended.
  markCopy(bundle, "the home's newer version");
  said.splice(0);
  await remote.update(device.id);
  expect(said).toEqual([
    remoteLoginWords.updating(device),
    remoteLoginWords.starting(deviceLabel(device)),
    remoteLoginWords.updated(device, "running"),
  ]);
  expect(await running.exited).toBe(0);
  expect(copyMark(kept)).toBe("the home's newer version\n");
  // The home held its connection, so the update could dial nothing: it kept
  // the home's word from its own arguments, and set the agent up by it.
  expect(new JoinedHome(them.dataDir, () => {}).read()?.grant).toMatchObject({ onHomeMac: true });
  expect(readFileSync(installed.service?.file ?? "", "utf8")).not.toContain("ProcessType");
  const updated = work(["run"], them.env);
  writeFileSync(them.agentPid, `${updated.child.pid}\n`);
  await expect
    .poll(updated.lines, { timeout: 30_000 })
    .toContain(helperWords.inReach(place, "MacBook Pro")[0]);

  // The home quits and starts again at another port: its new connection forwards there,
  // and the run comes back by itself, with nothing run there and nothing told.
  await first.connection.close();
  await first.stopSsh();
  await expect.poll(() => updated.lines().at(-1)).toBe(helperWords.quit(place, "MacBook Pro")[0]);
  const moved = await homeAt();
  await expect
    .poll(() => updated.lines().at(-1), { timeout: 30_000 })
    .toBe(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => moved.sshConnections.state(device.id)).toEqual({ state: "connected" });
  expect(moved.pairing.list().map(({ id }) => id)).toEqual([device.id]);

  // Removed in reach: it hears it through the connection and removes what Firstmate
  // set up there; the home's connection lets go, and its cleanup over SSH finds nothing
  // of this home's left.
  moved.pairing.remove(device.id, { cleanUpThere: true });
  expect(await updated.exited).toBe(0);
  await expect.poll(() => moved.pairing.sshCleanups(), { timeout: 30_000 }).toEqual([]);
  expect(existsSync(join(them.dataDir, "home.json"))).toBe(false);
  expect(existsSync(kept)).toBe(false);
  expect(existsSync(installed.service?.file ?? "")).toBe(false);
  expect(existsSync(join(them.dataDir, "left.json"))).toBe(false);
  for (const gone of ["route.json", "work.log", "service.log", "chromium"])
    expect(existsSync(join(them.dataDir, gone)), gone).toBe(false);
  expect(new HomeRoute(them.dataDir).current(grant)).toBeNull();
  expect(readdirSync(controlBase)).toEqual([]);
});

test("a Mac a command joined, stranded when the home's address changes, is found by its address and kept on the home's own SSH from then on", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  const sshd = await startSshServer();
  sshServers.push(sshd);
  const bundle = builtAppBundle();
  const them = user();
  const said: string[] = [];
  const dir = join(scratchDir("infinitary-run-work-home-"), "devices");
  const controlBase = socketScratchDir("fm-c-");
  const homeAt = () => sshHome({ sshd, them, bundle, dir, controlBase, said });
  const first = await homeAt();

  // Joined by the command for another Mac: it dials the home's address itself.
  const { link } = first.pairing.invite({ kind: "work", at: `127.0.0.1:${first.port}` });
  await first.connection.settled();
  const command = joinCommand({
    for: "another-mac",
    link,
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
    linux: noUbuntuPackage(),
  });
  expect(await terminal(command, onLinuxThatRunsIt(them.env), "yes\n").exited).toBe(0);
  const joined = new JoinedHome(them.dataDir, () => {}).read();
  if (!joined) throw new Error("Nothing joined there.");
  expect(joined.grant).not.toHaveProperty("via");
  const deviceId = joined.grant.deviceId;
  // A sign-in it made there, which must stay.
  seedRetainedSignInSentinel(them.dataDir);
  const running = work(["run"], them.env);
  writeFileSync(them.agentPid, `${running.child.pid}\n`);
  await expect.poll(running.lines).toContain(helperWords.inReach(THIS_MAC, "MacBook Pro")[0]);
  expect(first.sshConnections.state(deviceId)).toBeUndefined();

  // The home moves: the run keeps dialing where it was, out of reach.
  await first.connection.close();
  await first.stopSsh();
  await expect
    .poll(() => running.lines().at(-1))
    .toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
  const moved = await homeAt();

  said.splice(0);
  const asked = await moved.remote.addOrAsk(sshd.address);
  if (!("asks" in asked) || asked.asks !== "confirm")
    throw new Error("The first reach did not ask for the check line.");
  expect(said).toEqual([]);
  const found = await moved.remote.add(sshd.address, { confirm: asked.line });
  expect(found).toMatchObject({ id: deviceId, remoteLogin: sshd.address });
  expect(said.slice(0, 2)).toEqual([
    remoteLoginWords.reaching(sshd.address),
    remoteLoginWords.finding(found),
  ]);
  await running.exited;
  const grant = new JoinedHome(them.dataDir, () => {}).read()?.grant;
  expect(grant).toMatchObject({ deviceId, homeKey: joined.grant.homeKey, via: "ssh" });
  expect(readFileSync(join(them.dataDir, "accounts", "kept"), "utf8")).toBe("a sign-in\n");
  expect(moved.pairing.list().map(({ id }) => id)).toEqual([deviceId]);

  // Its run reaches the home only through the home's SSH connection, which is made once the find is done.
  const place = { thisMac: false, host: "127.0.0.1", overSsh: true };
  const after = work(["run"], them.env);
  writeFileSync(them.agentPid, `${after.child.pid}\n`);
  await expect
    .poll(after.lines, { timeout: 30_000 })
    .toContain(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => moved.sshConnections.state(deviceId)).toEqual({ state: "connected" });

  // The home moves again: nothing is run there, and it comes back by itself.
  await moved.connection.close();
  await moved.stopSsh();
  await expect.poll(() => after.lines().at(-1)).toBe(helperWords.quit(place, "MacBook Pro")[0]);
  const again = await homeAt();
  await expect
    .poll(() => after.lines().at(-1), { timeout: 30_000 })
    .toBe(helperWords.inReach(place, "MacBook Pro")[0]);
  await expect.poll(() => again.sshConnections.state(deviceId)).toEqual({ state: "connected" });
});

test("its home gone for good, a new home adds it by its address: asked once, its captain's yes leaves the old home as a removal would, keeping unmerged work", async () => {
  test.skip(!SSH_SERVER_AVAILABLE, "needs the Mac's own SSH server and client");
  const sshd = await startSshServer();
  sshServers.push(sshd);
  const old = await home(ME.uid + 1);
  const me = user();
  expect(await work(["join", await old.link()], me.env, "yes\n").exited).toBe(0);
  const joined = new JoinedHome(me.dataDir).read();
  const copies = new WorkingCopies(me.dataDir, { pool: false });
  const { dir } = await copies.prepare("t-unmerged", undefined);
  writeFileSync(join(dir, "only-copy.txt"), "unique uncommitted work\n");
  seedRetainedAccountDirectory(me.dataDir);

  const said: string[] = [];
  const { pairing, remote } = await sshHome({
    sshd,
    them: me,
    bundle: builtAppBundle(),
    dir: join(scratchDir("infinitary-run-work-home-"), "devices"),
    controlBase: socketScratchDir("fm-c-"),
    said,
  });
  const unchanged = () => {
    expect(new JoinedHome(me.dataDir).read()).toEqual(joined);
    expect(existsSync(join(me.dataDir, "accounts", "codex"))).toBe(true);
    expect(pairing.list()).toEqual([]);
  };

  await test.step("Add it asks once, and sends nothing there", async () => {
    const asked = await remote.addOrAsk(sshd.address);
    expect(asked).toMatchObject({ asks: "confirm", address: sshd.address });
    expect(said).toEqual([]);
    unchanged();
    if (!("line" in asked)) throw new Error("The check line was not asked.");
    expect(await remote.addOrAsk(sshd.address, { confirm: asked.line })).toEqual({
      asks: "leave",
      address: sshd.address,
      name: "Studio Mac",
    });
    expect(said).toEqual([remoteLoginWords.reaching(sshd.address)]);
    unchanged();
  });

  await test.step("while the old home answers, the yes changes nothing there", async () => {
    said.splice(0);
    await expect(remote.add(sshd.address, { leave: true })).rejects.toMatchObject({
      refusal: "still-answers",
    });
    expect(said.slice(-2)).toEqual(
      remoteLoginWords.refused("still-answers", { address: sshd.address, doing: "add" }),
    );
    unchanged();
  });

  await test.step("once it is gone, the yes leaves it as a removal would, keeps the unmerged work, and joins", async () => {
    await old.gone();
    said.splice(0);
    const device = await remote.add(sshd.address, { leave: true });
    expect(device).toMatchObject({ kind: "work", name: "Studio Mac", remoteLogin: sshd.address });
    // Its SSH connection may say more after it joined.
    const setUp = [
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Studio Mac"),
      remoteLoginWords.starting("Studio Mac"),
      ...remoteLoginWords.leftOther(device, { kept: 1, unremoved: 0 }),
    ];
    expect(said.slice(0, setUp.length)).toEqual(setUp);
    expect(readFileSync(join(dir, "only-copy.txt"), "utf8")).toBe("unique uncommitted work\n");
    expect(existsSync(join(me.dataDir, "accounts"))).toBe(false);
    expect(new JoinedHome(me.dataDir).read()?.grant).toMatchObject({
      deviceId: device.id,
      homeKey: pairing.identity().pin,
      via: "ssh",
    });
    expect(old.pairing.list().map(({ id }) => id)).toEqual([joined?.grant.deviceId]);
  });
});

test("a computer whose home reaches it over the home's own SSH connection dials only the route that connection keeps", async () => {
  const at = await home(ME.uid + 1);
  const me = user();
  const { forward, publish } = await at.overSsh(me.dataDir);
  const place = { thisMac: false, host: "127.0.0.1" };
  const run = work(["run"], me.env);
  // No route yet: out of reach, and the home's loopback the grant names,
  // where the home answers, is never dialed.
  await expect
    .poll(run.lines)
    .toEqual(expect.arrayContaining(helperWords.outOfReach(place, "MacBook Pro")));
  expect(forward.carried()).toBe(1);
  expect(at.pairing.list()).toEqual([expect.objectContaining({ onThisMac: false })]);
  // The home's connection keeps its route: in reach through that socket.
  publish();
  await expect
    .poll(run.lines)
    .toEqual(expect.arrayContaining(helperWords.inReach(place, "MacBook Pro")));
  expect(forward.carried()).toBe(2);
  run.child.kill("SIGTERM");
  expect(await run.exited).toBe(0);
});
