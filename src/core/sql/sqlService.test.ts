import { join } from "node:path";
import type { SqlAnswer } from "@shared/personal/contracts";
import type { SqlRequest } from "@shared/sql";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { bundleSqlProcess } from "../../../tests/helpers/sqlProcessBundle";
import { type AppDatabase, openDatabase } from "../storage/db";
import { forkChildProcess } from "./forkChildProcess";
import { SqlService } from "./sqlService";

/**
 * The query process for real: the entry bundled as the app bundles it,
 * forked with Node, holding its own read-only connection on a database the
 * core writes. The time cap is the claim under test, so the runaway here is
 * a statement that never ends inside ONE native SQLite step - the case a
 * worker thread could not stop.
 */

const RUNAWAY =
  "WITH RECURSIVE forever(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM forever) SELECT COUNT(*) AS n FROM forever";

let entry: string;
let dir: string;
let core: AppDatabase;
let service: SqlService;
const logs: string[] = [];

beforeAll(async () => {
  entry = await bundleSqlProcess();
}, 60_000);

beforeEach(() => {
  dir = scratchDir("infinitary-sql-service-");
  core = openDatabase(dir);
  core
    .prepare(
      "INSERT INTO usage_events (task_id, provider, model, input, output, at) VALUES ('firstmate', 'openai-codex', 'gpt-6-sol', 40, 2, 1000)",
    )
    .run();
  logs.length = 0;
  service = new SqlService({
    spawner: forkChildProcess(entry),
    databasePath: join(dir, "firstmate.db"),
    log: (line) => logs.push(line),
  });
});

afterEach(() => {
  service.dispose();
  core.close();
});

function request(sql: string, views: string[] = ["v_usage_v1"]): SqlRequest {
  return { sql, views: views as SqlRequest["views"] };
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exitOf(pid: number | undefined): Promise<void> {
  await expect.poll(() => alive(pid), { timeout: 5_000 }).toBe(false);
}

describe("the query process", () => {
  it("answers a query from its own process over the core's database", async () => {
    const answer = await service.query(request("SELECT key, input FROM v_usage_v1"));
    expect(answer).toMatchObject({ rows: [{ key: "FIRSTMATE", input: 40 }], truncated: false });
    expect(service.pid).not.toBe(process.pid);
    expect(alive(service.pid)).toBe(true);
  });

  it("kills a runaway statement, answers sql_timeout, and serves the next query from a fresh process", async () => {
    await service.query(request("SELECT 1 AS warm", []));
    const runawayPid = service.pid;
    expect(service.processesStarted).toBe(1);

    const answer: SqlAnswer = await service.query(request(RUNAWAY, []));
    expect(answer).toMatchObject({ refused: "sql_timeout" });
    // The process that ran it is gone - the only way to stop one native step.
    await exitOf(runawayPid);
    expect(logs.some((line) => line.includes("was stopped"))).toBe(true);

    const next = await service.query(request("SELECT COUNT(*) AS n FROM v_usage_v1"));
    expect(next).toMatchObject({ rows: [{ n: 1 }] });
    expect(service.processesStarted).toBe(2);
    expect(service.pid).not.toBe(runawayPid);
  });

  it("holds queries behind a runaway and answers them after it is stopped", async () => {
    const runaway = service.query(request(RUNAWAY, []));
    const behind = service.query(request("SELECT input FROM v_usage_v1"));
    expect(await runaway).toMatchObject({ refused: "sql_timeout" });
    expect(await behind).toMatchObject({ rows: [{ input: 40 }] });
  });

  it("leaves nothing running when it is disposed mid-query", async () => {
    await service.query(request("SELECT 1 AS warm", []));
    const pid = service.pid;
    const pending = service.query(request(RUNAWAY, []));
    service.dispose();
    await expect(pending).rejects.toThrow("shut down");
    await exitOf(pid);
    await expect(service.query(request("SELECT 1 AS x", []))).rejects.toThrow("shut down");
  });
});
