import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { catalogRefreshesSettled } from "../pi/modelRuntime";
import {
  createLocalOrchestratorSeat,
  LOCAL_ORCHESTRATOR_OFF_LINE,
  LOCAL_ORCHESTRATOR_PACKAGED_REFUSAL,
  LOCAL_ORCHESTRATOR_PROVIDER_ID,
  type LocalOrchestratorSeat,
  LocalOrchestratorService,
  localOrchestratorDir,
  localOrchestratorLine,
  localOrchestratorSettingProblem,
  resolveLocalOrchestrator,
} from "./localOrchestrator";

/**
 * Roadmap 1.7: the dev-only local seat. The build is the gate - a packaged
 * app answers nothing whatever the environment says - and an unpackaged
 * checkout gets a runtime of its own that Pi really serves the named model
 * from, which is what the Firstmate binds to.
 */

const ENV = {
  INFINITARY_LOCAL_ORCHESTRATOR_URL: "http://localhost:11434/v1/",
  INFINITARY_LOCAL_ORCHESTRATOR_MODEL: "qwen3:8b",
};

const ROW_ON = { enabled: true, baseUrl: "http://127.0.0.1:8080/v1/", model: "gemma4:12b" };

const dirs: string[] = [];
afterEach(async () => {
  await catalogRefreshesSettled();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveLocalOrchestrator", () => {
  it("answers nothing for a packaged build, whatever the environment or the row says", () => {
    expect(resolveLocalOrchestrator({ isPackaged: true, env: ENV })).toBeUndefined();
    expect(resolveLocalOrchestrator({ isPackaged: true, setting: ROW_ON })).toBeUndefined();
    expect(
      resolveLocalOrchestrator({
        isPackaged: true,
        env: { ...ENV, INFINITARY_DEV_OBSERVE: "1", INFINITARY_LOCAL_ORCHESTRATOR: "1" },
      }),
    ).toBeUndefined();
  });

  it("names the endpoint and the model for an unpackaged checkout", () => {
    expect(resolveLocalOrchestrator({ isPackaged: false, env: ENV })).toEqual({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3:8b",
      host: "localhost:11434",
      apiKey: "local",
      source: "environment",
    });
    expect(
      resolveLocalOrchestrator({
        isPackaged: false,
        env: { ...ENV, INFINITARY_LOCAL_ORCHESTRATOR_KEY: " sk-dev " },
      })?.apiKey,
    ).toBe("sk-dev");
  });

  it("reads the settings under Firstmate 3000's older names too; Infinitary's win", () => {
    const older = {
      FM3000_LOCAL_ORCHESTRATOR_URL: ENV.INFINITARY_LOCAL_ORCHESTRATOR_URL,
      FM3000_LOCAL_ORCHESTRATOR_MODEL: "qwen3:8b",
    };
    expect(resolveLocalOrchestrator({ isPackaged: false, env: older })).toMatchObject({
      baseUrl: "http://localhost:11434/v1",
      model: "qwen3:8b",
      source: "environment",
    });
    expect(
      resolveLocalOrchestrator({
        isPackaged: false,
        env: { ...older, INFINITARY_LOCAL_ORCHESTRATOR_MODEL: "gemma4:12b" },
      })?.model,
    ).toBe("gemma4:12b");
  });

  it("needs both the URL and the model, and the URL an http(s) one", () => {
    expect(resolveLocalOrchestrator({ isPackaged: false })).toBeUndefined();
    expect(
      resolveLocalOrchestrator({
        isPackaged: false,
        env: { INFINITARY_LOCAL_ORCHESTRATOR_URL: ENV.INFINITARY_LOCAL_ORCHESTRATOR_URL },
      }),
    ).toBeUndefined();
    expect(
      resolveLocalOrchestrator({
        isPackaged: false,
        env: { INFINITARY_LOCAL_ORCHESTRATOR_MODEL: "qwen3:8b" },
      }),
    ).toBeUndefined();
    for (const url of ["nonsense", "ftp://localhost/v1", "file:///tmp/v1", "  "]) {
      expect(
        resolveLocalOrchestrator({
          isPackaged: false,
          env: { ...ENV, INFINITARY_LOCAL_ORCHESTRATOR_URL: url },
        }),
      ).toBeUndefined();
    }
  });
});

describe("the Settings row beside the environment", () => {
  it("speaks when it is on, over an environment that names another seat", () => {
    expect(resolveLocalOrchestrator({ isPackaged: false, env: ENV, setting: ROW_ON })).toEqual({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "gemma4:12b",
      host: "127.0.0.1:8080",
      apiKey: "local",
      source: "setting",
    });
  });

  it("leaves the choice to the environment while it is off", () => {
    expect(
      resolveLocalOrchestrator({
        isPackaged: false,
        env: ENV,
        setting: { ...ROW_ON, enabled: false },
      })?.source,
    ).toBe("environment");
    expect(
      resolveLocalOrchestrator({ isPackaged: false, setting: { ...ROW_ON, enabled: false } }),
    ).toBeUndefined();
  });

  it("seats nothing on a bad row rather than falling back to the environment, and says why", () => {
    const badUrl = { ...ROW_ON, baseUrl: "ollama" };
    const noModel = { ...ROW_ON, model: "  " };
    expect(
      resolveLocalOrchestrator({ isPackaged: false, env: ENV, setting: badUrl }),
    ).toBeUndefined();
    expect(
      resolveLocalOrchestrator({ isPackaged: false, env: ENV, setting: noModel }),
    ).toBeUndefined();
    expect(localOrchestratorSettingProblem(badUrl)).toMatch(/http\(s\) URL/);
    expect(localOrchestratorSettingProblem(noModel)).toMatch(/Name the model/);
    expect(localOrchestratorSettingProblem(ROW_ON)).toBeNull();
    expect(localOrchestratorSettingProblem({ ...badUrl, enabled: false })).toBeNull();
  });
});

describe("LocalOrchestratorService", () => {
  function service(isPackaged: boolean, env: Record<string, string | undefined>) {
    vi.stubEnv("PI_OFFLINE", "1");
    const userData = scratchDir("infinitary-local-service-");
    dirs.push(userData);
    let row = { enabled: false, baseUrl: "", model: "" };
    const lines: string[] = [];
    const seats: (LocalOrchestratorSeat | undefined)[] = [];
    const seatService = new LocalOrchestratorService({
      isPackaged,
      env,
      paths: { userData },
      settings: {
        getLocalOrchestrator: () => row,
        setLocalOrchestrator: (next) => {
          row = next;
        },
      },
      broadcastEvent: (event) => lines.push(event.text),
      onSeat: (seat) => {
        seats.push(seat);
      },
    });
    return { seatService, lines, seats, row: () => row };
  }

  it("boots from the environment, moves to the row when it turns on, and back when it turns off", async () => {
    const { seatService, lines, seats } = service(false, ENV);
    const booted = await seatService.boot();
    expect(booted?.source).toBe("environment");
    expect(seatService.view()).toMatchObject({
      available: true,
      active: { model: "qwen3:8b", host: "localhost:11434", source: "environment" },
      problem: null,
    });
    expect(lines).toEqual([
      "Your first mate is running on qwen3:8b at localhost:11434 for this dev checkout; crewmates route as usual.",
    ]);
    const on = await seatService.set(ROW_ON);
    expect(on.active).toEqual({ model: "gemma4:12b", host: "127.0.0.1:8080", source: "setting" });
    expect(seats.at(-1)?.model).toEqual({
      provider: LOCAL_ORCHESTRATOR_PROVIDER_ID,
      id: "gemma4:12b",
    });
    expect(lines.at(-1)).toBe(
      "Your first mate is running on gemma4:12b at 127.0.0.1:8080 for this dev checkout; crewmates route as usual.",
    );
    // The same row again is not a change: no seat handed over, no line.
    await seatService.set(ROW_ON);
    expect(seats).toHaveLength(1);
    expect(lines).toHaveLength(2);
    // Off: the environment's seat is back, because it was never unset.
    const off = await seatService.set({ ...ROW_ON, enabled: false });
    expect(off.active?.source).toBe("environment");
    expect(seats.at(-1)?.source).toBe("environment");
  });

  it("says the usual model is back when nothing else asks for a seat", async () => {
    const { seatService, lines, seats } = service(false, {});
    expect(await seatService.boot()).toBeUndefined();
    await seatService.set(ROW_ON);
    expect(seatService.seat()?.source).toBe("setting");
    await seatService.set({ ...ROW_ON, enabled: false });
    expect(seatService.seat()).toBeUndefined();
    expect(seats.at(-1)).toBeUndefined();
    expect(lines.at(-1)).toBe(LOCAL_ORCHESTRATOR_OFF_LINE);
    const bad = await seatService.set({ ...ROW_ON, model: "" });
    expect(bad.active).toBeNull();
    expect(bad.problem).toMatch(/Name the model/);
  });

  it("preserves request order when the seat is switched off while its runtime is being created", async () => {
    const { seatService, seats, row } = service(false, {});
    await Promise.all([seatService.set(ROW_ON), seatService.set({ ...ROW_ON, enabled: false })]);
    expect(row().enabled).toBe(false);
    expect(seatService.seat()).toBeUndefined();
    expect(seats.at(-1)).toBeUndefined();
  });

  it("holds nothing on a packaged build and refuses the write outright", async () => {
    const { seatService, lines, seats, row } = service(true, ENV);
    expect(await seatService.boot()).toBeUndefined();
    expect(seatService.view()).toEqual({
      available: false,
      setting: { enabled: false, baseUrl: "http://localhost:11434/v1", model: "" },
      active: null,
      problem: null,
    });
    await expect(seatService.set(ROW_ON)).rejects.toThrow(LOCAL_ORCHESTRATOR_PACKAGED_REFUSAL);
    expect(row().enabled).toBe(false);
    expect(seats).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("createLocalOrchestratorSeat", () => {
  it("is a runtime of its own that Pi serves the named model from", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const userData = scratchDir("infinitary-local-seat-");
    dirs.push(userData);
    const spec = resolveLocalOrchestrator({ isPackaged: false, env: ENV });
    if (!spec) throw new Error("unreachable");
    const seat = await createLocalOrchestratorSeat(spec, { userData });
    expect(seat.model).toEqual({ provider: LOCAL_ORCHESTRATOR_PROVIDER_ID, id: "qwen3:8b" });
    // The real consumer: Pi resolves the model off the written file, with
    // the endpoint the environment named, and lists it as available.
    const model = seat.runtime.getModel(LOCAL_ORCHESTRATOR_PROVIDER_ID, "qwen3:8b");
    expect(model?.baseUrl).toBe("http://localhost:11434/v1");
    expect(model?.api).toBe("openai-completions");
    expect(
      seat.runtime
        .getAvailableSnapshot()
        .some(
          (entry) => entry.provider === LOCAL_ORCHESTRATOR_PROVIDER_ID && entry.id === "qwen3:8b",
        ),
    ).toBe(true);
    // Its files sit under userData/dev, never in the person's models.json.
    const dir = localOrchestratorDir(userData);
    expect(existsSync(join(dir, "models.json"))).toBe(true);
    expect(existsSync(join(userData, "auth", "models.json"))).toBe(false);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "models.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8"))).toMatchObject({
      providers: { local: { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen3:8b" }] } },
    });
    expect(localOrchestratorLine(seat)).toBe(
      "Your first mate is running on qwen3:8b at localhost:11434 for this dev checkout; crewmates route as usual.",
    );
  });
});
