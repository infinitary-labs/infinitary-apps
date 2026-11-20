import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PlacedSpec, placedSpecSchema } from "@shared/work";
import { describe, expect, it } from "vitest";
import { fakeBinding, fakeSessionFactory } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { sourceInstall } from "../../../tests/helpers/sourceInstall";
import { PlacedTasks } from "../helper/placedTasks";
import { SessionHost } from "../helper/sessionHost";
import { crewmateContractStamp, crewmateSessionSpec } from "../orchestrator/crewSession";
import { appPathsFor } from "../paths";
import type { SessionSpec } from "../session/session";
import {
  readSelfSource,
  readSelfSourceAsync,
  readSelfSourceIdentity,
  sourceIdentity,
} from "./resolve";

function rolling(spec: SessionSpec | undefined) {
  if (!spec || spec.shape.turns !== "rolling")
    throw new Error("Expected an opened rolling session");
  return { ...spec, shape: spec.shape };
}

// INF-1977, approved A: the executing installation owns the path; explicit
// identities prevent an investigation silently reading another build.
describe("each computer's installed source", () => {
  it("reads indexed real files at background and Linux-style paths, then follows a relocated installation", () => {
    const dir = scratchDir("source-paths-");
    const home = sourceInstall(join(dir, "Applications/Infinitary.app/Contents/Resources"));
    const work = sourceInstall(join(dir, "background app/resources"), "0.5.0");
    const first = readSelfSource(home.location);
    const second = readSelfSource(work.location);
    expect(first.availability).toBe("available");
    expect(second.availability).toBe("available");
    expect(first.commit).not.toBe(second.commit);
    for (const installation of [home, work]) {
      const facts = readSelfSource(installation.location);
      for (const file of Object.keys(installation.map.modules)) {
        expect(readFileSync(join(facts.root, file), "utf8")).toBe(
          readFileSync(join(__dirname, "../../..", file), "utf8"),
        );
      }
    }
    const moved = join(dir, "linux/opt/Infinitary/resources");
    mkdirSync(join(dir, "linux/opt/Infinitary"), { recursive: true });
    renameSync(work.location.resourcesPath, moved);
    const relocated = readSelfSource({ ...work.location, resourcesPath: moved });
    expect(relocated.availability).toBe("available");
    expect(relocated.root).toBe(join(moved, "self-source"));
    expect(relocated.commit).toBe(second.commit);
    expect(readSelfSource(work.location).availability).toBe("unavailable");
  });

  it("keeps missing, corrupt, inconsistent and escaping source explicit without throwing", () => {
    const installed = sourceInstall(scratchDir("source-failures-"));
    const read = () => readSelfSource(installed.location);
    rmSync(join(installed.root, "self-map.json"));
    expect(read()).toMatchObject({ availability: "unavailable", commit: null });
    writeFileSync(join(installed.root, "self-map.json"), "not json");
    expect(read().availability).toBe("unavailable");
    installed.write();
    expect(readSelfSource({ ...installed.location, version: "different build" })).toMatchObject({
      availability: "unavailable",
      commit: null,
    });
    writeFileSync(
      join(installed.location.resourcesPath, "self-map.json"),
      JSON.stringify({
        ...installed.map,
        commit: installed.map.commit.replace(/^./, installed.map.commit[0] === "a" ? "b" : "a"),
      }),
    );
    expect(read().availability).toBe("unavailable");
    installed.write();
    rmSync(join(installed.root, installed.files[0]));
    expect(read().availability).toBe("unavailable");
    const outside = join(installed.location.resourcesPath, "outside.ts");
    writeFileSync(outside, "outside the source root");
    symlinkSync(outside, join(installed.root, installed.files[0]));
    expect(read()).toMatchObject({
      availability: "unavailable",
      reason: "An indexed file escapes the source folder.",
    });
  });

  // INF-4680's start cuts: the freeze recorder's tag reads the index alone,
  // never every indexed file, and names the same build readSelfSource does.
  it("reads the build's identity from its index alone, as readSelfSource names it", () => {
    const installed = sourceInstall(scratchDir("source-identity-"));
    expect(readSelfSourceIdentity(installed.location)).toEqual(
      sourceIdentity(readSelfSource(installed.location)),
    );
    expect(readSelfSourceIdentity(installed.location).commit).toBe(installed.map.commit);
    rmSync(join(installed.root, installed.files[0]));
    expect(readSelfSourceIdentity(installed.location).commit).toBe(installed.map.commit);
    expect(
      readSelfSourceIdentity({ ...installed.location, version: "different build" }),
    ).toMatchObject({ version: "different build", commit: null, mutable: false });
    installed.write();
    writeFileSync(
      join(installed.location.resourcesPath, "self-map.json"),
      JSON.stringify({ ...installed.map, commit: "0".repeat(40) }),
    );
    expect(readSelfSourceIdentity(installed.location).commit).toBeNull();
    const development = { ...installed.location, isPackaged: false, appPath: installed.root };
    expect(readSelfSourceIdentity(development)).toEqual(
      sourceIdentity(readSelfSource(development)),
    );
  });

  it("never calls an indexed development snapshot the current immutable build", () => {
    const installed = sourceInstall(scratchDir("source-dev-"));
    expect(
      readSelfSource({ ...installed.location, isPackaged: false, appPath: installed.root }),
    ).toMatchObject({
      root: installed.root,
      mutable: true,
      version: installed.location.version,
      commit: null,
      availability: "available",
    });
  });

  it.each(["pi", "claude"] as const)(
    "serves %s local facts before stamping, and sends only home identity for placed work",
    (backend) => {
      const installed = sourceInstall(scratchDir("source-local-"));
      const source = readSelfSource(installed.location);
      const paths = appPathsFor(scratchDir("source-session-"));
      const input = { taskId: "source-task", machineId: "local", cwd: paths.userData, source };
      const binding = backend === "pi" ? fakeBinding() : { backend, accountId: "test-account" };
      const local = rolling(crewmateSessionSpec(paths, input, binding));
      expect(local.instructions.base).toContain(JSON.stringify(source));
      expect(local.shape.record.stamp).toEqual(
        crewmateContractStamp(local.instructions.base, local.tools),
      );
      const placed = crewmateSessionSpec(paths, { ...input, machineId: "work-computer" }, binding);
      expect(placed.instructions.base).not.toContain(source.root);
      expect(placed.homeSource).toEqual(sourceIdentity(source));
      expect(placed.homeSource).not.toHaveProperty("root");
    },
  );

  it.each(["pi", "claude"] as const)(
    "opens %s work with unknown source on older compositions",
    async (backend) => {
      const factory = fakeSessionFactory(backend);
      const host = new SessionHost({
        tasks: new PlacedTasks(scratchDir("source-unknown-")),
        factories: { [backend]: factory },
        bind: async () =>
          backend === "pi" ? fakeBinding() : { backend, accountId: "test-account" },
        ask: async () => ({}),
      });
      try {
        await host.answer("inf:session:open", [
          {
            orderId: "old-home",
            task: "source-task",
            spec: {
              binding: { backend },
              thinking: { level: "off" },
              tools: [],
              instructions: "An unrelated task.",
            },
          },
        ]);
        const context = rolling(factory.specs[0]).instructions.base;
        expect(context).toContain(JSON.stringify({ availability: "unknown" }));
        expect(context).toContain("First mate's build identity (not a local path): null");
      } finally {
        await host.close();
      }
    },
  );

  // INF-2186: yielding during source checks must not start a session after shutdown.
  it("does not open a conversation after the computer stops during source validation", async () => {
    const dir = scratchDir("source-close-while-reading-");
    const installed = sourceInstall(join(dir, "work/Resources"));
    const facts = readSelfSource(installed.location);
    let release = (_facts: typeof facts) => {};
    const pendingSource = new Promise<typeof facts>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const factory = fakeSessionFactory("pi");
    const host = new SessionHost({
      tasks: new PlacedTasks(join(dir, "tasks")),
      factories: { pi: factory },
      bind: async () => fakeBinding(),
      ask: async () => ({}),
      source: () => {
        reached();
        return pendingSource;
      },
    });
    const opening = host.answer("inf:session:open", [
      {
        orderId: "open",
        task: "source-task",
        spec: {
          binding: { backend: "pi" },
          thinking: { level: "off" },
          tools: [],
          instructions: "Read the source.",
        },
      },
    ]);
    const rejected = expect(opening).rejects.toThrow("computer is stopping");
    try {
      await reading;
      await host.close();
      release(facts);
      await rejected;
      expect(factory.specs).toHaveLength(0);
    } finally {
      release(facts);
      await host.close();
    }
  });

  it.each(["pi", "claude"] as const)(
    "refreshes %s placed facts before stamping on reopen, update and restart",
    async (backend) => {
      const dir = scratchDir("source-placed-");
      const home = sourceInstall(join(dir, "home"));
      let installed = sourceInstall(join(dir, "work background/Resources"));
      const factory = fakeSessionFactory(backend);
      const tasks = new PlacedTasks(join(dir, "tasks"));
      const makeHost = () =>
        new SessionHost({
          tasks,
          factories: { [backend]: factory },
          bind: async () =>
            backend === "pi" ? fakeBinding() : { backend, accountId: "test-account" },
          ask: async () => ({}),
          source: () => readSelfSourceAsync(installed.location),
        });
      let host = makeHost();
      const spec: PlacedSpec = placedSpecSchema.parse({
        binding: { backend },
        thinking: { level: "off" },
        tools: [],
        instructions: "Investigate Infinitary's source.",
        homeSource: sourceIdentity(readSelfSource(home.location)),
      });
      const open = () =>
        host.answer("inf:session:open", [{ orderId: "source-open", task: "source-task", spec }]);
      try {
        await open();
        const first = rolling(factory.specs[0]);
        expect(first.instructions.base).toContain(
          JSON.stringify(readSelfSource(installed.location)),
        );
        expect(first.instructions.base).not.toContain(home.root);
        expect(first.shape.record.stamp).toEqual(
          crewmateContractStamp(first.instructions.base, first.tools),
        );
        await open();
        expect(factory.specs).toHaveLength(1);
        installed = sourceInstall(join(dir, "updated/resources"), "0.5.0");
        await open();
        expect(factory.specs).toHaveLength(2);
        const updated = rolling(factory.specs[1]);
        expect(updated.instructions.base).toContain(
          JSON.stringify(readSelfSource(installed.location)),
        );
        expect(updated.instructions.base).toContain(JSON.stringify(spec.homeSource));
        expect(updated.shape.record.stamp).not.toEqual(first.shape.record.stamp);
        await host.close();
        host = makeHost();
        await open();
        expect(rolling(factory.specs[2]).instructions.base).toBe(updated.instructions.base);
      } finally {
        await host.close();
      }
    },
  );
});
