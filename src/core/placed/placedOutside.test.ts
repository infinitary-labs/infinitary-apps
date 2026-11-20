import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, relative } from "node:path";
import type { Card } from "@shared/cards";
import { FILES_COMMAND } from "@shared/files";
import { GOOGLE_DATA_KEPT, NOTICE_ACCEPTED } from "@shared/integrations";
import { PROTOCOL_VERSION } from "@shared/ipc";
import { outsideDataDeletedNote } from "@shared/savedOutsideData";
import { secretKeepFields } from "@shared/secrets";
import { decode } from "@toon-format/toon";
import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StubRequest } from "../../../tests/helpers/anthropicDialect";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { startGoogleStandIn } from "../../../tests/helpers/googleStandIn";
import { allowIntegrationReads } from "../../../tests/helpers/integrationApprovals";
import {
  api,
  model,
  placedWorldHooks,
  said,
  stops,
  world,
} from "../../../tests/helpers/placedWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { renderFilesReply } from "../axi/fileCommands";
import { renderIntegrationReply } from "../axi/integrationCommands";
import type { ChannelReply } from "../axi/protocol";
import { CONTRACT_CHANGES } from "../connection/contractChanges";
import { CardFileReads } from "../files/cardFileReads";
import { saveIntoDownloads } from "../files/downloadsSave";
import * as hostEnvironment from "../hostEnv";
import { CREWMATE_INTEGRATIONS_LINE, INTEGRATIONS_COMMAND } from "../integrations";
import { READ_HOUR_MS } from "../integrations/outsideReads";
import { renderWake } from "../orchestrator/wakes";
import { crewmatePlacedDir, crewmateSessionsDir, crewmateTempDir } from "../paths";
import { backgroundJobReceipt } from "../pi/bashWords";
import { CREWMATE_STOPS_LINE } from "../pi/piResources";
import type { SecretAskEnded } from "../secrets/asks";
import {
  CREWMATE_SECRETS_CATALOG_LINE,
  CREWMATE_SECRETS_LINE,
  CREWMATE_SECRETS_THERE_LINE,
  SECRET_ASK_WORDS,
  SECRETS_COMMAND,
} from "../secrets/commandWords";
import { ProtectedSecrets } from "../secrets/protected";
import { SecretsSettings } from "../secrets/settings";
import { seedTask } from "../tasks/seedTask";
import { KEEP_AS_ANOTHER_USER } from "../tasks/taskStops";

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * the integrations command there, Gmail and Calendar content kept there, and
 * the files command between this Mac and that computer.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

function onlyFixtureTools(): void {
  // INF-1038: this computer has only its fixture's tools, not the runner's
  // task commands. hostEnv also appends installer directories, so replacing
  // process.env.PATH alone does not isolate it. Keep git for working copies;
  // withTaskShell still adds the real command path when the task is granted it.
  const bin = scratchDir("infinitary-placed-host-bin-");
  symlinkSync("/usr/bin/git", join(bin, "git"));
  const inheritedHostEnv = hostEnvironment.hostEnv;
  const environment = vi.spyOn(hostEnvironment, "hostEnv").mockImplementation((extra) => ({
    ...inheritedHostEnv(extra),
    PATH: bin,
  }));
  stops.push(() => {
    environment.mockRestore();
  });
}

// INF-795: "A crewmate on a computer that runs work gets
// infinitary-integrations-axi, whose list, show and call are forwarded to the
// home ... so no sign-in leaves the home." The command runs in the
// crewmate's shell there through the real launcher, command process and
// task channel, and each call crosses the real connection to this Mac's
// own integrations, over a stand-in GitHub.
describe("the integrations command on a computer that runs work", () => {
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  beforeEach(onlyFixtureTools);

  it("lists, shows and calls this Mac's integrations from the crewmate's shell there, with the sign-in and the ask kept here", async () => {
    const github = await standInGitHub();
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      github: { apiBaseUrl: github.base, token: GITHUB_TOKEN, login: "octo" },
    });
    const issue = {
      method: "POST",
      path: "/repos/acme/site/issues",
      body: JSON.stringify({ title: "The footer overlaps on phones" }),
    };
    const answers = collectEach(
      [
        INTEGRATIONS_COMMAND,
        `${INTEGRATIONS_COMMAND} show GitHub`,
        `${INTEGRATIONS_COMMAND} call GitHub read '{"path":"/user"}'`,
        `${INTEGRATIONS_COMMAND} call GitHub write '${JSON.stringify(issue)}' --reason 'File the footer bug you asked me to report.'`,
      ],
      INTEGRATIONS_KEPT,
      "The issue waits for the captain.",
    );
    // INF-950: this transport journey explicitly starts with the read always allowed.
    at.home().integrations?.setRule("github", "read", true);
    const requests = api.requests.length;
    await at.start("t-reach");
    const home = at.home();
    await expect
      .poll(() => home.tasks.get("t-reach")?.outcome)
      .toBe("The issue waits for the captain.");
    // Its instructions there name the command.
    expect(systemOf(api.requests[requests])).toContain(CREWMATE_INTEGRATIONS_LINE);
    const [listed, shown, read, write] = answers;

    // List and show answer what this Mac has connected.
    expect(listed?.exit).toBe(0);
    expect(listed?.output).toContain("GitHub");
    expect(listed?.output).toContain("octo");
    expect(shown?.exit).toBe(0);
    expect(shown?.output).toContain("read");
    expect(shown?.output).toContain("write");

    // A read runs here, through this Mac's sign-in, and its answer reaches the shell there.
    expect(read?.exit).toBe(0);
    expect(read?.output).toContain('"login": "octo"');
    expect(github.seen).toEqual([{ method: "GET", path: "/user", auth: `Bearer ${GITHUB_TOKEN}` }]);

    // A change is kept here as the captain's ask; nothing is sent, so the
    // command exits 1 and still names the ask (the captain's INF-824 choice:
    // "Return exit 1: the change was not sent.").
    if (!write) throw new Error("The write's answer did not reach the crewmate.");
    expect(write.exit).toBe(1);
    expect(write.output).toContain("REFUSED");
    expect(write.output).toContain("Not run");
    const kept = home.tasks.get("t-reach")?.delivery?.writeAsks?.[0];
    expect(write.output).toContain(`approval card for ask ${kept?.id}`);
    expect(home.tasks.get("t-reach")?.delivery?.writeAsks).toEqual([
      expect.objectContaining({
        kind: "integration",
        action: "write",
        input: JSON.stringify(issue),
        reason: "File the footer bug you asked me to report.",
      }),
    ]);
    expect(github.seen).toHaveLength(1);
    const approval = home.supervisor.cards.snapshot().find((card) => card.taskId === "t-reach");
    expect(approval).toMatchObject({
      author: "host",
      actions: expect.arrayContaining([
        expect.objectContaining({ label: "Only this time", default: true }),
      ]),
    });
    // The call is kept by its id, so one asked again after a drop is answered once.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-reach"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { channel: string }).channel);
    expect(calls.filter((channel) => channel === "inf:work:use-integration")).toHaveLength(2);

    if (!approval) throw new Error("The host approval card is missing");
    model([{ text: "The issue request was refused." }]);
    home.supervisor.cardActions.act(approval.id, "once");
    await expect
      .poll(() => home.tasks.get("t-reach")?.outcome)
      .toBe("The issue request was refused.");
    expect(github.seen.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(home.tasks.get("t-reach")?.delivery?.writeAsks?.[0]?.outcome).toMatchObject({
      kind: "refused",
    });
    // Repeating the already-resolved choice never repeats the request.
    home.supervisor.cardActions.act(approval.id, "once");
    expect(github.seen.filter((request) => request.method === "POST")).toHaveLength(1);

    // Nothing of the sign-in is on that computer, while the answer it read is in its record there.
    expect(filesHolding(at.dataDir, GITHUB_TOKEN)).toEqual([]);
    expect(filesHolding(at.dataDir, "The Octocat")).toContainEqual(
      expect.stringMatching(/^tasks\/t-reach\/sessions\//),
    );
  });

  it("starts no integrations work on an older major and supplies the command after updating", async () => {
    // An installed command must not supply a missing command on the older
    // computer, even on CI runners that have no task commands of their own.
    const installed = scratchDir("infinitary-installed-task-command-");
    writeFileSync(
      join(installed, "infinitary-integrations-axi"),
      "#!/bin/sh\nprintf 'runner-installed command reached\\n'\nexit 0\n",
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${installed}:${process.env.PATH ?? ""}`);
    const github = await standInGitHub();
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      github: { apiBaseUrl: github.base, token: GITHUB_TOKEN, login: "octo" },
      protocolVersion: "11.0.0",
    });
    const answers = collectEach([INTEGRATIONS_COMMAND], INTEGRATIONS_KEPT, "No integrations here.");
    const home = at.home();
    const requests = api.requests.length;
    seedTask(home.tasks, {
      id: "t-older",
      title: "Use integrations",
      prompt: "List integrations",
      status: "queued",
      deviceId: at.deviceId,
    });
    await home.supervisor.starts.dispatchQueuedTask("t-older");
    expect(home.tasks.get("t-older")?.status).toBe("open");
    expect(home.placed.takesIntegrations(at.deviceId)).toBe(false);
    expect(api.requests.length).toBe(requests);
    expect(github.seen).toEqual([]);
    await at.restartComputer({ protocolVersion: PROTOCOL_VERSION });
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    await at.inReach("t-older");
    await home.supervisor.starts.dispatchQueuedTask("t-older");
    await expect.poll(() => home.tasks.get("t-older")?.outcome).toBe("No integrations here.");
    expect(systemOf(api.requests[requests])).toContain(CREWMATE_INTEGRATIONS_LINE);
    expect(answers[0]?.exit).toBe(0);
    expect(answers[0]?.output).toContain("GitHub");
    expect(JSON.stringify(api.requests)).not.toContain("runner-installed command reached");
  });
});

// INF-4381's approved plan, piece 1, done criteria 6 and 7: a job the captain
// asked to keep, recorded from the crewmate's shell on a computer that runs
// work through the real launcher, command process and task channel, is kept
// there past a merged close and recorded here by that computer; a crewmate
// running as another user on this Mac is refused, since the job would run as
// that user.
describe("a kept job on a computer that runs work", () => {
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  const KEEP = `infinitary-stops-axi keep --label "nightly photo backup" --check 'true' 'echo removed'`;

  it("keeps the job there past a merged close, and records it here by that computer", async () => {
    const at = await world(undefined, { jobs: true, taskChannel: entry, leftovers: true });
    // The world joins its computer as another user on this Mac; this case
    // stands in a separate computer, whose crewmates may keep a job.
    vi.spyOn(at.pairing(), "onThisMac").mockReturnValue(false);
    const home = at.home();
    model([
      { tools: [shellCommand(KEEP)] },
      { tools: [shellCommand("infinitary-stops-axi")] },
      { text: "The backup keeps running." },
    ]);
    const requests = api.requests.length;
    await at.start("t-keep");
    await expect.poll(() => home.tasks.get("t-keep")?.outcome).toBe("The backup keeps running.");
    expect(systemOf(api.requests[requests])).toContain(CREWMATE_STOPS_LINE);
    const folder = join(at.dataDir, "kept", "t-keep-s1");
    const kept = shellAnswer(api.requests[requests + 1]);
    expect(kept.exit).toBe(0);
    expect(kept.output).toContain(folder);
    expect(existsSync(folder)).toBe(true);
    const listed = shellAnswer(api.requests[requests + 2]);
    expect(listed.output).toContain("nightly photo backup");

    home.tasks.close("t-keep", { status: "done", reason: "merged", actor: "host" });
    await expect
      .poll(() => home.placed.keptJobs.list())
      .toEqual([
        {
          computer: at.deviceId,
          account: expect.any(String),
          label: "nightly photo backup",
          check: "true",
          remove: "echo removed",
          folder,
          task: "t-keep",
          key: home.tasks.get("t-keep")?.key,
          at: expect.any(Number),
        },
      ]);
    expect(
      home.tasks
        .timeline("t-keep")
        .filter((event) => event.text.startsWith("At close:"))
        .map((event) => event.text),
    ).toEqual(['At close: job "nightly photo backup" keeps running.']);
    expect(existsSync(folder)).toBe(true);
  });

  it("refuses a keep to a crewmate running as another user on this Mac", async () => {
    const at = await world(undefined, { jobs: true, taskChannel: entry, leftovers: true });
    const home = at.home();
    model([{ tools: [shellCommand(KEEP)] }, { text: "The job cannot be kept here." }]);
    const requests = api.requests.length;
    await at.start("t-other-user");
    await expect
      .poll(() => home.tasks.get("t-other-user")?.outcome)
      .toBe("The job cannot be kept here.");
    const refused = shellAnswer(api.requests[requests + 1]);
    expect(refused.exit).toBe(1);
    expect(refused.output).toContain(KEEP_AS_ANOTHER_USER);
    expect(existsSync(join(at.dataDir, "kept"))).toBe(false);
  });
});

// INF-2468, the captain: "isn't this fundamentally about a file transport
// protocol between infinitary connected machines?", then "Any file that
// computer's user can read, except the app's own sign-ins and keys" with "No
// click. Each copy adds one line to that task's record."
describe("the files command between this Mac and a computer that runs work", () => {
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  /**
   * A computer that runs work as another macOS user on this Mac, as the world joins it, with this
   * Mac's files command over a scratch home folder.
   */
  async function withFiles() {
    const homeFolder = realpathSync(scratchDir("infinitary-files-home-folder-"));
    mkdirSync(join(homeFolder, "Documents"));
    mkdirSync(join(homeFolder, "Projects"));
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      files: { home: homeFolder, name: "MacBook Pro" },
    });
    return { at, home: at.home(), homeFolder };
  }

  /** A crewmate on the computer runs each command from its shell there and hears how each answered. */
  async function runThere(
    at: Awaited<ReturnType<typeof world>>,
    taskId: string,
    commands: string[],
  ): Promise<Answered[]> {
    const answers = collectEach(commands, FILES_KEPT, "The files are here.");
    await at.start(taskId, "Read the clips list on my laptop.");
    await expect.poll(() => at.home().tasks.get(taskId)?.outcome).toBe("The files are here.");
    return answers;
  }

  it("copies a file and a database in use from this Mac into the hand-over folder of a task there, read there as its own user and never from the captain's private folders", async () => {
    const { at, home, homeFolder } = await withFiles();
    const clips = Buffer.from("clip,length\nintro,12\n".repeat(300_000));
    writeFileSync(join(homeFolder, "Projects", "clips.csv"), clips);
    writeFileSync(join(homeFolder, "Documents", "letter.txt"), "dear");
    const record = join(homeFolder, "Projects", "record.db");
    const db = new Database(record);
    stops.push(() => {
      db.close();
    });
    db.pragma("journal_mode = WAL");
    db.exec("create table tasks (key text); insert into tasks values ('INF-2468')");
    const requests = api.requests.length;
    const [computers, listed, copied, database, refused, closed] = await runThere(at, "t-files", [
      FILES_COMMAND,
      `${FILES_COMMAND} ls home:~/Projects`,
      `${FILES_COMMAND} get home:~/Projects/clips.csv`,
      `${FILES_COMMAND} get 'MacBook Pro:${record}'`,
      `${FILES_COMMAND} get home:${join(home.paths.accountsDir, "registry.json")}`,
      `${FILES_COMMAND} get home:~/Documents/letter.txt`,
    ]);
    // Its instructions there name the command beside the computers.
    expect(systemOf(api.requests[requests])).toContain(
      `To read a file on another of these computers, copy it with ${FILES_COMMAND} in your shell`,
    );
    expect(computers?.output).toContain("MacBook Pro");
    expect(computers?.output).toContain("in reach");
    expect(listed?.output).toContain("clips.csv");
    expect(listed?.output).toContain("record.db");

    // The file arrives whole in the task's hand-over folder there, private, and only its path is heard.
    const handover = join(at.folders("t-files").temp, "handover");
    const [kept] = readdirSync(handover).filter((name) => name.endsWith("clips.csv"));
    const path = join(handover, kept ?? "missing");
    expect(readFileSync(path).equals(clips)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(copied?.output).toContain(path);
    expect(copied?.output).not.toContain("intro,12");

    // A database another program has open arrives complete, through its own backup.
    expect(database?.output).toContain("copied through its own backup");
    const [keptDb] = readdirSync(handover).filter((name) => name.endsWith("record.db"));
    const copy = new Database(join(handover, keptDb ?? "missing"), { readonly: true });
    expect(copy.prepare("select key from tasks").all()).toEqual([{ key: "INF-2468" }]);
    copy.close();

    // The app's own sign-ins stay where they are, and so do the captain's private folders.
    expect(refused?.exit).toBe(1);
    expect(refused?.output).toContain("never copies");
    expect(closed?.exit).toBe(1);
    expect(closed?.output).toContain(
      "~/Documents/letter.txt is in a private folder - Desktop, Documents, Library or ~/.ssh - which the files command never copies for another user on the same computer.",
    );

    // Each copy is one line on the task's record here, and nothing is kept on this Mac.
    const notes = home.tasks
      .timeline("t-files")
      .filter((event) => event.kind === "note" && event.text.startsWith("copied "))
      .map((event) => event.text);
    expect(notes).toEqual([
      `copied ${join(homeFolder, "Projects", "clips.csv")} from MacBook Pro into its hand-over folder (6.0 MB)`,
      expect.stringMatching(/^copied .*record\.db from MacBook Pro into its hand-over folder/),
    ]);
    expect(existsSync(join(crewmateTempDir(home.paths, "t-files"), "handover"))).toBe(false);
    // Each was read on that computer, as its own user, never by this Mac's own reader.
    expect(existsSync(join(home.paths.userData, "file-reach", "set-aside"))).toBe(false);
    expect(readdirSync(join(at.dataDir, "file-reach"))).toEqual([]);
  });

  it("copies a file from the computer that runs work for a task on this Mac, piece by piece over the connection", async () => {
    const { at, home } = await withFiles();
    const folder = realpathSync(scratchDir("infinitary-files-there-"));
    const footage = randomBytes(9 * 1024 * 1024 + 17);
    writeFileSync(join(folder, "footage.mov"), footage);
    seedTask(home.tasks, { id: "t-here", title: "Edit the footage", status: "running" });
    const files = home.files?.forTask("t-here");
    if (!files) throw new Error("The home composes the files command here.");
    const rows = (await files.computers()).data?.computers as { name: string; role: string }[];
    const there = rows.find((row) => row.role === "runs work")?.name ?? "missing";

    const listed = await files.list(`${there}:${folder}`);
    expect(listed.data?.entries).toEqual([
      expect.objectContaining({ name: "footage.mov", kind: "file", size: footage.length }),
    ]);
    const copied = await files.copy(`${there}:${join(folder, "footage.mov")}`);
    const path = String(copied.data?.copied);
    expect(path.startsWith(crewmateTempDir(home.paths, "t-here"))).toBe(true);
    expect(readFileSync(path).equals(footage)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // Neither computer keeps a copy once it is delivered.
    expect(readdirSync(join(at.dataDir, "file-reach"))).toEqual([]);
    expect(readdirSync(join(home.paths.userData, "file-reach", "fetched"))).toEqual([]);
    // The other computer's own sign-ins stay there.
    const refused = await files.copy(`${there}:${join(at.dataDir, "home.json")}`);
    expect(refused.text).toContain("never copies");
  });

  // INF-3757, direction C, under the captain's condition: "the file content
  // should not physically get attached to the card. data transfer should
  // only happen when user click". A crewmate there puts a file on its card;
  // the card reaches this Mac with the reference alone, and a Save in this
  // Mac's window reads the copy kept there over the connection.
  it("saves a card's file kept on the computer that runs work into this Mac's Downloads only on Save", async () => {
    const { at, home } = await withFiles();
    const letter = randomBytes(2 * 1024 * 1024 + 41);
    model((_request, index) =>
      index === 0
        ? {
            tools: [
              {
                name: "emit_card",
                args: {
                  title: "The letter is ready",
                  body: "<p>The letter to the landlord is ready to send.</p>",
                  files: [join(at.folders("t-letter").temp, "letter to the landlord.docx")],
                },
              },
            ],
          }
        : { text: "The letter is on the card." },
    );
    mkdirSync(at.folders("t-letter").temp, { recursive: true });
    writeFileSync(join(at.folders("t-letter").temp, "letter to the landlord.docx"), letter);
    await at.start("t-letter", "Write the letter to the landlord.");
    await expect
      .poll(() => home.cards().find((card) => card.taskId === "t-letter")?.files?.length)
      .toBe(1);
    const card = home.cards().find((one) => one.taskId === "t-letter");
    const file = card?.files?.[0];
    if (!card || !file || !home.files) throw new Error("The card's file did not arrive.");
    expect(file).toMatchObject({
      name: "letter to the landlord.docx",
      bytes: letter.length,
      computer: at.deviceId,
    });
    // Nothing of the file crossed with the card, and nothing is set aside there yet.
    const setAside = () => {
      const dir = join(at.dataDir, "file-reach");
      return existsSync(dir) ? readdirSync(dir) : [];
    };
    expect(setAside()).toEqual([]);
    const reads = new CardFileReads({
      card: (id) => home.cards().find((one) => one.id === id),
      localDir: () => scratchDir("infinitary-card-files-none-here-"),
      router: home.files,
    });
    const downloads = scratchDir("infinitary-card-files-downloads-");
    const saved = await saveIntoDownloads({
      folder: downloads,
      read: (offset) => reads.piece(card.id, file.id, offset),
    });
    expect(saved.savedAs).toBe("letter to the landlord.docx");
    expect(readFileSync(saved.path).equals(letter)).toBe(true);
    // The copy set aside there for the save is let go once the last piece arrives.
    await expect.poll(setAside).toEqual([]);
  });
});

// INF-1109's revision spec: "Treat all crewmates consistently ... If metadata
// needs to travel to a work computer, use existing authenticated home/work
// routes and send metadata only. Do not move values, grant remote execution
// or construct production custody as a shortcut." The command runs in the
// crewmate's shell there through the real launcher, command process and task
// channel, and its list crosses the real connection to this Mac's Secrets,
// whose custody is a disposable stand-in: no Keychain is touched.
describe("the Secrets command on a computer that runs work", () => {
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  beforeEach(onlyFixtureTools);

  it("lists and shows this Mac's secrets from the crewmate's shell there, while a use, its value and custody stay here", async () => {
    const value = "invented-staging-database-password";
    const custody = disposableCustody();
    const dir = scratchDir("infinitary-placed-secrets-");
    const raised: string[] = [];
    let confirms = 0;
    const settings = new SecretsSettings({
      open: (initialize) =>
        ProtectedSecrets.open({
          dir,
          custody,
          initialize,
          environment: () => ({}),
          now,
          authentication: {
            available: async () => true,
            confirm: async () => {
              confirms++;
              return true;
            },
          },
        }),
      raise: (card) => {
        raised.push(card.title);
      },
      withdraw: () => {},
      settled: () => {},
      changed: () => {},
      now,
    });
    await settings.put({
      ref: "staging-db",
      label: "Staging database password",
      value,
      expectedVersion: 0,
      expectedRevision: null,
      environment: "Staging",
    });
    // Every use this Mac's Secrets is asked for, whichever task asks.
    const uses: string[] = [];
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      secrets: {
        forTask: (task) => {
          const command = settings.commandFor({ task });
          return {
            ...command,
            inject: (input) => {
              uses.push(`inject for ${task}`);
              return command.inject(input);
            },
            status: (request) => {
              uses.push(`status for ${task}`);
              return command.status(request);
            },
            cancel: (request) => {
              uses.push(`cancel for ${task}`);
              return command.cancel(request);
            },
          };
        },
      },
    });
    const done = "The staging migration needs a use on the home.";
    const answers = collectEach(
      [
        `${SECRETS_COMMAND} list`,
        `${SECRETS_COMMAND} show staging-db`,
        `${SECRETS_COMMAND} inject --env '{"DATABASE_PASSWORD":"staging-db"}' --reason 'Run the staging migration' --id migrate-staging -- /bin/sh ./scripts/migrate.sh`,
      ],
      SECRETS_KEPT,
      done,
    );
    const requests = api.requests.length;
    await at.start("t-secrets");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-secrets")?.outcome).toBe(done);
    // Its instructions there name the catalog alone, never requests.
    const system = systemOf(api.requests[requests]);
    expect(system).toContain(CREWMATE_SECRETS_CATALOG_LINE);
    expect(system).not.toContain(CREWMATE_SECRETS_LINE);

    // List and show answer the catalog a crewmate here lists: reference, name, environment and version.
    expect(answers).toHaveLength(3);
    const [listed, shown, injected] = answers;
    expect(listed?.exit).toBe(0);
    for (const words of ["staging-db", "Staging database password", "Staging"])
      expect(listed?.output).toContain(words);
    expect(shown?.exit).toBe(0);
    expect(shown?.output).toContain("Staging database password");

    // A use asked there is unavailable: it never reached this Mac's Secrets,
    // raised no approval, asked for no confirmation and left no receipt or history.
    expect(injected?.output).toContain("unavailable: true");
    expect(injected?.output).toContain("runs on another computer");
    expect(uses).toEqual([]);
    expect(raised).toEqual([]);
    expect(confirms).toBe(0);
    expect(settings.commandFor({ task: "t-secrets" }).receipts()).toEqual([]);
    expect((await settings.view()).history).toEqual([]);

    // Only the metadata read crossed the connection, once for each list and show.
    const calls = readFileSync(
      join(crewmatePlacedDir(home.paths, "t-secrets"), "calls.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { channel: string }).channel);
    expect(calls).toEqual(["inf:work:secrets", "inf:work:secrets"]);

    // Nothing on that computer holds the value or any custody bytes.
    expect(filesHolding(at.dataDir, value)).toEqual([]);
    expect(custody.slots.size).toBeGreaterThan(0);
    for (const bytes of custody.slots.values()) expect(filesHolding(at.dataDir, bytes)).toEqual([]);
  });
});

// INF-4239's piece 2: "a crewmate on a computer that runs work can ask for a
// secret, carried by one metadata-only work request to the home's ask." The
// ask runs in the crewmate's shell there through the real launcher, command
// process and task channel, and crosses the real connection to this Mac's
// Secrets, whose custody is a disposable stand-in. The plan: "A work computer
// without the change keeps today's line saying it cannot ask."
describe("asking to keep a secret from a computer that runs work", () => {
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  beforeEach(onlyFixtureTools);

  const ASK = `infinitary-secrets-axi ask --name 'Stripe test key' --place 'Test' --reason 'Charge the test card in the checkout tests' --id checkout`;

  /** This Mac's Secrets, a computer joined to it that lists `changes`, and a crewmate there that asks once. */
  async function askThere(changes?: readonly string[]) {
    const raised: Omit<Card, "author" | "priority" | "status" | "createdAt">[] = [];
    const heard: { task: string | null; ended: SecretAskEnded }[] = [];
    const settings = new SecretsSettings({
      open: (initialize) =>
        ProtectedSecrets.open({
          dir: scratchDir("infinitary-placed-secret-asks-"),
          custody: disposableCustody(),
          initialize,
          environment: () => ({}),
          now,
          authentication: { available: async () => true, confirm: async () => true },
        }),
      raise: (card) => {
        raised.push(card);
      },
      withdraw: () => {},
      settled: () => {},
      changed: () => {},
      asked: (task, ended) => {
        heard.push({ task, ended });
      },
      now,
    });
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      secretRuns: true,
      ...(changes ? { changes } : {}),
      secrets: {
        forTask: (task) => settings.commandFor({ task }),
        elsewhere: (task) => ({
          use: (computer, input) => settings.elsewhere({ task, computer }, input),
          take: (computer, request, call) => settings.take({ task, computer }, request, call),
          gone: (computer) => settings.elsewhereGone({ task, computer: computer.id }),
          ask: (_computer, input) => settings.askElsewhere(task, input),
        }),
      },
    });
    model([{ tools: [shellCommand(ASK)] }, { text: "Asked for the Stripe test key." }]);
    const requests = api.requests.length;
    await at.start("t-ask");
    const home = at.home();
    await expect
      .poll(() => home.tasks.get("t-ask")?.outcome)
      .toBe("Asked for the Stripe test key.");
    return {
      at,
      settings,
      raised,
      heard,
      system: systemOf(api.requests[requests]),
      asked: shellAnswer(api.requests[requests + 1]),
    };
  }

  it("raises this Mac's own card for the task there, and the task hears the kept reference once, never the value", async () => {
    const value = "sk_test_invented_placed_ask_value";
    const { at, settings, raised, heard, system, asked } = await askThere();
    // Its instructions there say to ask, as a crewmate's here do.
    expect(system).toContain(CREWMATE_SECRETS_LINE);
    expect(system).not.toContain(CREWMATE_SECRETS_THERE_LINE);
    expect(asked.exit).toBe(0);
    expect(asked.output).toContain("waiting");
    expect(asked.output).toContain(SECRET_ASK_WORDS.waiting);
    // The card is this Mac's, for the task there, with one masked field.
    expect(raised.at(-1)?.taskId).toBe("t-ask");
    const card = raised.at(-1);
    const keep = card && secretKeepFields({ ...card, author: "host" });
    expect(keep?.fields.map((field) => [field.name, field.place])).toEqual([
      ["Stripe test key", "Test"],
    ]);
    expect(
      await settings.keep({ pass: keep?.pass ?? "", values: [{ field: "s1", value }] }),
    ).toEqual({ kept: true });
    expect(heard).toEqual([
      {
        task: "t-ask",
        ended: {
          ask: "checkout",
          state: "kept",
          secrets: [
            expect.objectContaining({ name: "Stripe test key", place: "Test", version: 1 }),
          ],
        },
      },
    ]);
    // Nothing on that computer holds the value.
    expect(filesHolding(at.dataDir, value)).toEqual([]);
  });

  it("a computer without the change keeps its line saying it cannot ask, and nothing is asked here", async () => {
    const older = CONTRACT_CHANGES.names.filter((name) => name !== "secret-asks-elsewhere");
    const { raised, heard, system, asked } = await askThere(older);
    expect(system).toContain(CREWMATE_SECRETS_THERE_LINE);
    expect(system).not.toContain(CREWMATE_SECRETS_LINE);
    expect(asked.output).toContain(SECRET_ASK_WORDS.notHere);
    expect(raised).toEqual([]);
    expect(heard).toEqual([]);
  });
});

describe("Gmail and Calendar content on a computer that runs work", () => {
  // INF-1094: "Gmail and Calendar content a crewmate read on another
  // computer that runs work is replaced with the same note after 30 days
  // and when the captain uses Delete Gmail and Calendar content, and the
  // row's answer counts those conversations." The captain's INF-952
  // answers hold there too: the passage is replaced and the conversation
  // stays, 30 days after it was read.
  const NOTE = outsideDataDeletedNote("Gmail and Calendar content");
  const DAY = 24 * 60 * 60 * 1000;
  const LENA = {
    from: "Lena Ortiz <lena@ortiz-studio.com>",
    subject: "Invoice 2214 for the October shoot",
    text: "Hi Ada,\n\nThe invoice for the October shoot is attached. Payment is due by Nov 4.\n\nThanks,\nLena",
  };
  let entry: string;
  beforeAll(async () => {
    entry = await bundleAxiProcess();
  }, 60_000);

  /** A computer that runs work, with this Mac signed in to Google's stand-in and its reads allowed. */
  async function withGoogle(changes?: readonly string[]) {
    const google = await startGoogleStandIn();
    stops.push(() => google.close());
    const at = await world(undefined, {
      jobs: true,
      taskChannel: entry,
      google: { base: google.base },
      ...(changes ? { changes } : {}),
    });
    const home = at.home();
    const integrations = home.integrations;
    const outsideData = home.outsideData;
    if (!integrations || !outsideData) throw new Error("The home composes Google here.");
    await integrations.signIn("google", NOTICE_ACCEPTED);
    // INF-950: content retention starts after the captain has allowed these reads.
    allowIntegrationReads(integrations);
    return { google, at, home, outsideData };
  }

  /**
   * A crewmate on the computer runs one integrations command from its shell
   * there, through this Mac's Google sign-in, and reports on what it heard;
   * answers what the command printed.
   */
  async function runThere(
    at: Awaited<ReturnType<typeof world>>,
    taskId: string,
    command: string,
  ): Promise<string> {
    const answers = collectEach([command], INTEGRATIONS_KEPT, "Lena's message is answered.");
    await at.start(taskId, "Answer Lena.");
    await expect
      .poll(() => at.home().tasks.get(taskId)?.outcome)
      .toBe("Lena's message is answered.");
    return answers[0]?.output ?? "";
  }

  /**
   * A crewmate on the computer reads Lena's message through this Mac's
   * Google sign-in, from its shell there, and its turn ends.
   */
  async function readThere(changes?: readonly string[]) {
    const { google, at, home, outsideData } = await withGoogle(changes);
    const id = google.deliver(LENA);
    const read = await runThere(
      at,
      "t-lena",
      `${INTEGRATIONS_COMMAND} call Google read_message '${JSON.stringify({ id })}'`,
    );
    // It read the message there, and its record there and this Mac's copy hold it.
    expect(read).toContain(LENA.subject);
    const there = at.folders("t-lena").sessions;
    const here = crewmateSessionsDir(home.paths, "t-lena");
    const calls = join(crewmatePlacedDir(home.paths, "t-lena"), "calls.jsonl");
    expect(filesHolding(there, LENA.subject)).not.toEqual([]);
    await expect.poll(() => filesHolding(here, LENA.subject)).not.toEqual([]);
    expect(readFileSync(calls, "utf8")).toContain(LENA.subject);
    return { at, home, outsideData, there, here, calls };
  }

  // INF-2466, the captain's approved plan: a crewmate saves a Gmail
  // attachment "into the task's hand-over folder, kept until day 30 or the
  // task closes", and Delete Gmail and Calendar content removes it at once.
  it("saves an attachment into the task's hand-over folder there byte for byte, and the captain's delete removes it there", async () => {
    const { google, at, home, outsideData } = await withGoogle();
    const pdf = randomBytes(48_211);
    const id = google.deliver({
      ...LENA,
      attachment: {
        name: "invoice-2214.pdf",
        type: "application/pdf",
        size: pdf.length,
        bytes: pdf,
      },
    });
    const heard = await runThere(
      at,
      "t-lena",
      `${INTEGRATIONS_COMMAND} call Google save_attachment '${JSON.stringify({ id, part: "1" })}'`,
    );
    const handover = join(at.folders("t-lena").temp, "handover");
    const [saved] = readdirSync(handover).filter((name) => name.endsWith("invoice-2214.pdf"));
    const path = join(handover, saved ?? "missing");
    expect(readFileSync(path).equals(pdf)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The crewmate heard its path there, never its bytes.
    expect(heard).toContain(path);
    expect(heard).not.toContain(pdf.subarray(0, 64).toString("base64url"));
    // Nothing of it stays on this Mac.
    expect(
      existsSync(join(crewmateTempDir(home.paths, "t-lena"), "handover", saved ?? "missing")),
    ).toBe(false);

    await outsideData.deleteNow();
    expect(existsSync(path)).toBe(false);
  });

  it("replaces what it read there and in this Mac's copy on the captain's delete, counts it, and its next turn reads the note", async () => {
    // The current work major includes deletion without the retired minor name.
    const { at, home, outsideData, there, here, calls } = await readThere([]);

    expect(await outsideData.deleteNow()).toEqual({ conversations: 1, waiting: 0 });
    // Replaced on the computer, in this Mac's copy of its record and in the
    // calls this Mac answered, with the conversation kept around it.
    expect(filesHolding(there, LENA.subject)).toEqual([]);
    expect(filesHolding(there, NOTE)).not.toEqual([]);
    expect(filesHolding(dirname(here), LENA.subject)).toEqual([]);
    expect(filesHolding(here, NOTE)).not.toEqual([]);
    expect(readFileSync(calls, "utf8")).not.toContain(LENA.subject);
    expect(filesHolding(here, "Lena's message is answered.")).not.toEqual([]);

    // Its next turn there carries the note, never the message.
    model([{ text: "Lena's invoice is answered." }]);
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate("t-lena", "What did Lena ask for?");
    await expect.poll(() => home.tasks.get("t-lena")?.outcome).toBe("Lena's invoice is answered.");
    const next = said(api.requests[requests]);
    expect(next).toContain("What did Lena ask for?");
    expect(next).toContain(NOTE);
    expect(next).not.toContain(LENA.subject);
    // This Mac's copy follows that turn as written there, file for file.
    await expect.poll(() => sameFiles(here, there)).toEqual({ missing: [], differing: [] });
    expect(filesHolding(at.dataDir, LENA.subject)).toEqual([]);
  });

  // Intent: guardrail before the placedSessions.ts split (INF-2625's plan):
  // a file that computer wrote again shorter comes home whole or not at all,
  // so a copy cut short leaves this Mac's copy as it was and waits for the
  // next pass, and a copied file named outside the record writes nothing.
  it("waits for the next pass when a changed file comes home short, and writes nothing outside the record", async () => {
    const { home, outsideData, there, here } = await readThere();
    const ask = home.devices.ask.bind(home.devices);
    const outside = join(dirname(here), "escaped.txt");
    let cut = 0;
    const asked = vi.spyOn(home.devices, "ask").mockImplementation(async (...args) => {
      const answer = await ask(...args);
      if (args[1] !== "inf:session:copy") return answer;
      const copy = answer as { files: { name: string; data: string }[]; more: boolean };
      return {
        ...copy,
        // Cut short with nothing more to come: each file that now holds the note arrives half.
        more: false,
        files: [
          ...copy.files.map((file) => {
            if (!Buffer.from(file.data, "base64").includes(NOTE)) return file;
            cut++;
            const bytes = Buffer.from(file.data, "base64");
            return { ...file, data: bytes.subarray(0, bytes.length >> 1).toString("base64") };
          }),
          {
            name: "../escaped.txt",
            size: 5,
            offset: 0,
            data: Buffer.from("there").toString("base64"),
          },
        ],
      };
    });
    expect(await outsideData.deleteNow()).toEqual({ conversations: 0, waiting: 1 });
    expect(cut).toBeGreaterThan(0);
    // Replaced there; this Mac's copy holds what it held, never half of each.
    expect(filesHolding(there, LENA.subject)).toEqual([]);
    expect(filesHolding(here, LENA.subject)).not.toEqual([]);
    expect(filesHolding(here, NOTE)).toEqual([]);
    expect(existsSync(`${here}.whole`)).toBe(false);
    expect(existsSync(outside)).toBe(false);

    // The next pass copies them whole.
    asked.mockRestore();
    expect(await outsideData.deleteNow()).toEqual({ conversations: 1, waiting: 0 });
    expect(filesHolding(dirname(here), LENA.subject)).toEqual([]);
    expect(filesHolding(here, NOTE)).not.toEqual([]);
    expect(existsSync(outside)).toBe(false);
  });

  it("goes on its own 30 days after it was read, there too", async () => {
    const { outsideData, there, here } = await readThere();
    const kept = GOOGLE_DATA_KEPT.days * DAY;
    ahead = kept - DAY;
    await outsideData.sweep();
    expect(filesHolding(there, LENA.subject)).not.toEqual([]);
    // The ledger counts in hours: its words go within the hour after they are due.
    ahead = kept + READ_HOUR_MS;
    await outsideData.sweep();
    expect(filesHolding(there, LENA.subject)).toEqual([]);
    expect(filesHolding(there, NOTE)).not.toEqual([]);
    expect(filesHolding(dirname(here), LENA.subject)).toEqual([]);
  });

  it("counts a computer on an older major as unreachable until updated, then replaces its content", async () => {
    const { at, home, outsideData, there, calls } = await readThere();
    await at.restartComputer({ protocolVersion: "11.0.0" });
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe("11.0.0");

    expect(await outsideData.deleteNow()).toEqual({
      conversations: 0,
      waiting: 0,
      elsewhere: [{ computer: "Mac mini", conversations: 1, until: "reach" }],
    });
    // Nothing was asked of that computer; the calls this Mac answered are its own to replace.
    expect(filesHolding(there, LENA.subject)).not.toEqual([]);
    expect(readFileSync(calls, "utf8")).not.toContain(LENA.subject);

    // Updated, it is replaced there at the next sweep.
    await at.restartComputer({ protocolVersion: PROTOCOL_VERSION });
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    await at.inReach("t-lena");
    await outsideData.sweep();
    expect(filesHolding(there, LENA.subject)).toEqual([]);
    expect(filesHolding(there, NOTE)).not.toEqual([]);
  });
});

/** The files under `copy` that `source` holds differently or not at all, by their path in `source`. */
function sameFiles(copy: string, source: string): { missing: string[]; differing: string[] } {
  const missing: string[] = [];
  const differing: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const name = relative(source, path);
        const copied = join(copy, name);
        if (!existsSync(copied)) missing.push(name);
        else if (!readFileSync(copied).equals(readFileSync(path))) differing.push(name);
      }
    }
  };
  walk(source);
  return { missing, differing };
}

/** The invented token this Mac's github.com sign-in holds in these cases. */
const GITHUB_TOKEN = "gho_fixture_owned_by_app";

/**
 * A stand-in GitHub API: `/user` answers as GitHub's does for the signed-in
 * account (trimmed), and every other path is Not Found. Every request is recorded.
 */
async function standInGitHub() {
  const seen: { method: string; path: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization });
    const found = req.method === "GET" && req.url === "/user";
    res.writeHead(found ? 200 : 404, {
      "Content-Type": "application/json",
      "x-github-request-id": "REQ-1",
      "x-ratelimit-remaining": "4999",
    });
    res.end(
      JSON.stringify(
        found
          ? {
              login: "octo",
              id: 583231,
              node_id: "MDQ6VXNlcjU4MzIzMQ==",
              type: "User",
              html_url: "https://github.com/octo",
              name: "The Octocat",
              public_repos: 8,
            }
          : { message: "Not Found", documentation_url: "https://docs.github.com/rest" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stops.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** The model runs one command in its shell, in the foreground. */
function shellCommand(command: string) {
  return { name: "bash", args: { command, description: "Reach the integrations" } };
}

/** The crewmate's instructions as a request carried them. */
function systemOf(request: StubRequest | undefined): string {
  return (request?.body.system ?? []).map((block) => block.text ?? "").join("\n");
}

/** What the shell answered the model's last command, as its next request carries it. */
function shellAnswer(request: StubRequest | undefined): Answered {
  const content = request?.body.messages?.at(-1)?.content;
  const result = Array.isArray(content)
    ? (content as { type?: string; content?: unknown }[]).findLast(
        (block) => block.type === "tool_result",
      )?.content
    : undefined;
  return answerOf(textOf(result));
}

/** How a command run in the crewmate's shell answered: its exit, and what it printed. */
type Answered = { exit: number; output: string };

/** A command's answer in the bash tool's words: `exit <code>`, then what it printed. */
function answerOf(text: string): Answered {
  const [first = "", ...rest] = text.split("\n");
  return { exit: Number(/^exit (\d+)$/.exec(first)?.[1] ?? Number.NaN), output: rest.join("\n") };
}

/** What the model's request told it last: the shell's answer to its command, or a wake's words. */
function lastHeard(request: StubRequest): string {
  const content = request.body.messages?.at(-1)?.content;
  if (!Array.isArray(content)) return textOf(content);
  return (content as { type?: string; text?: string; content?: unknown }[])
    .map((block) => (block.type === "tool_result" ? textOf(block.content) : (block.text ?? "")))
    .join("\n");
}

/** A message's or tool result's content as its text. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as { text?: string }[]).map((block) => block.text ?? "").join("");
}

/** Stands for the part of a composer's words a reader looks for around them. */
const HOLE = "\u0000";

/** The job a shell's answer is the receipt for, read in the bash tool's own words; none when it finished. */
function jobOf(heard: string): string | undefined {
  const [before = "", after = ""] = backgroundJobReceipt(HOLE).split(HOLE);
  const end = heard.startsWith(before) ? heard.indexOf(after, before.length) : -1;
  return end < 0 ? undefined : heard.slice(before.length, end);
}

/**
 * How job `job` ended, read from its exit wake in the renderer's own words
 * (`renderWake`): the exit it names and its output's tail; none while the
 * job still runs.
 */
function jobEnd(heard: string, job: string): Answered | undefined {
  const wake = (exitCode: number, tail?: string) =>
    renderWake({
      facts: {
        kind: "job-exit",
        to: "crewmate",
        jobId: job,
        command: HOLE,
        exitCode,
        durationMs: 0,
        ...(tail === undefined ? {} : { tail }),
      },
    });
  // The words before the command and between it and the exit, then those
  // between the run's time and the output's tail.
  const [opening = "", toExit = ""] = sharedStart(wake(0), wake(1)).split(HOLE);
  const [toTail = ""] = wake(0, HOLE)
    .slice(sharedStart(wake(0, HOLE), wake(0)).length)
    .split(HOLE);
  const at = heard.indexOf(opening);
  if (at < 0) return undefined;
  const exit = heard.indexOf(toExit, at + opening.length);
  const rest = exit < 0 ? "" : heard.slice(exit + toExit.length);
  const tail = rest.indexOf(toTail);
  return {
    exit: Number.parseInt(rest, 10),
    output: tail < 0 ? "" : rest.slice(tail + toTail.length),
  };
}

/** The longest start two texts share. */
function sharedStart(a: string, b: string): string {
  let at = 0;
  while (at < a.length && a[at] === b[at]) at += 1;
  return a.slice(0, at);
}

/**
 * A task command's words for an answer kept past the shell's limit, which
 * its bare command reads: what any of its commands prints when its answer
 * is kept (`running`), or when it came while a kept one still runs (the
 * `busy` refusal), in the words of the renderer that prints them.
 */
function keptBy(
  bare: string,
  render: (command: string, reply: ChannelReply<never>, help: string[]) => string,
): { bare: string; kept: (heard: string) => boolean } {
  // A command's name as its words print it, plain, so the printed form quotes nothing new.
  const any = "anycommand";
  let busy = "";
  try {
    render(any, { kind: "busy", command: any }, []);
  } catch (error) {
    busy = (error as Error).message;
  }
  if (!busy) throw new Error(`${bare} prints a busy reply rather than refusing it.`);
  const running = render(any, { kind: "running", command: any }, []).trimEnd();
  const shapes = [running, busy].map((words) => words.split(any).filter(Boolean));
  return {
    bare,
    kept: (heard) =>
      shapes.some((pieces) => {
        let at = 0;
        for (const piece of pieces) {
          at = heard.indexOf(piece, at);
          if (at < 0) return false;
          at += piece.length;
        }
        return true;
      }),
  };
}

const INTEGRATIONS_KEPT = keptBy(INTEGRATIONS_COMMAND, renderIntegrationReply);
const FILES_KEPT = keptBy(FILES_COMMAND, renderFilesReply);
const SECRETS_KEPT = {
  bare: SECRETS_COMMAND,
  // Secrets prints structured replies, not the prose notes above. Only the
  // pending state and the BUSY refusal call for reading the kept answer.
  kept(output: string): boolean {
    try {
      const reply = decode(output) as { state?: unknown; code?: unknown } | null;
      return reply?.state === "running" || reply?.code === "BUSY";
    } catch {
      // Leave unstructured shell failures for the case's answer assertions.
      return false;
    }
  },
};

/**
 * A crewmate on the computer that runs work runs each command from its
 * shell there, one after another, then ends its turn with `done`; what it
 * returns fills with how each command answered. A command whose answer is
 * kept past the shell's limit is collected as the product tells it to, by
 * the bare command, and a background job's receipt waits for the job's
 * end, which carries the command's exit and output. On a loaded computer
 * any command can outlast the shell's 3 s limit, so a case never depends
 * on that limit holding (INF-1534, INF-4283; the journeys' stand-ins do the
 * same, INF-1141).
 */
function collectEach(
  commands: readonly string[],
  tool: { bare: string; kept: (heard: string) => boolean },
  done: string,
): Answered[] {
  const answers: Answered[] = [];
  let job: string | undefined;
  const run = (command: string) => ({ tools: [shellCommand(command)] });
  const waiting = { text: "Waiting for the answer." };
  model((request, index) => {
    if (index === 0) return run(commands[0] ?? tool.bare);
    if (answers.length === commands.length) return { text: done };
    const heard = lastHeard(request);
    let answer: Answered | undefined;
    if (job !== undefined) {
      answer = jobEnd(heard, job);
      if (!answer) return waiting;
      job = undefined;
    } else {
      job = jobOf(heard);
      if (job !== undefined) return waiting;
      answer = answerOf(heard);
    }
    if (tool.kept(answer.output)) return run(tool.bare);
    answers.push(answer);
    const next = commands[answers.length];
    return next ? run(next) : { text: done };
  });
  return answers;
}

/** Every file under `root` whose bytes hold `text`. */
function filesHolding(root: string, text: string | Buffer): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && readFileSync(path).includes(text))
        found.push(relative(root, path));
    }
  };
  walk(root);
  return found;
}
