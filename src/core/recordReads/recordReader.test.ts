import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { AT, CODEX, row, snapshot } from "../../../tests/helpers/placedWorkRecord";
import type { HostChildProcess, HostChildSpawner } from "../host";
import { buildModelsCatalog } from "../quota/catalog";
import type { QuotaService } from "../quota/quotaService";
import { AccountSelector } from "../routing/accountRouter";
import { PlacedWorkScores } from "../routing/placedWork";
import { Router } from "../routing/router";
import { DecisionStore } from "../storage/decisionStore";
import { SettingsStore } from "../storage/settingsStore";
import { selectTasks } from "../storage/taskSelection";
import { seedTask } from "../tasks/seedTask";
import { queryTasksAsync } from "../tasks/taskQuery";
import { TaskService } from "../tasks/taskService";
import type { RecordChild, RecordParent } from "./protocol";
import { RECORD_READER_TIMEOUTS, RecordReader } from "./recordReader";

/** The transport boundary only: readiness and replies are controlled by each case. */
class Peer implements HostChildProcess {
  readonly pid = undefined;
  readonly sent: RecordParent[] = [];
  readonly kill = vi.fn(() => {
    for (const exit of this.exits) exit(null);
  });
  private message: (message: unknown) => void = () => {};
  private readonly exits: ((code: number | null) => void)[] = [];
  postMessage(message: unknown) {
    this.sent.push(message as RecordParent);
  }
  onMessage(listener: (message: unknown) => void) {
    this.message = listener;
  }
  onExit(listener: (code: number | null) => void) {
    this.exits.push(listener);
  }
  emit(message: RecordChild) {
    this.message(message);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Regression: optional placement reads must be bounded, require explicit scoring data, and preserve task-search errors.
describe("record reader failure boundaries", () => {
  it.each(["open", "answer"] as const)(
    "bounds a hung %s, keeps routing and attachments available, and recovers search",
    async (phase) => {
      vi.useFakeTimers();
      vi.setSystemTime(AT);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const peers: Peer[] = [];
      const spawner: HostChildSpawner = {
        spawn: () => {
          const peer = new Peer();
          peers.push(peer);
          return peer;
        },
      };
      const db = freshDatabase();
      const reader = new RecordReader(spawner, "record.sqlite");
      try {
        const settings = new SettingsStore(db);
        const decisions = new DecisionStore(db);
        const tasks = new TaskService({ db, now: () => AT });
        seedTask(tasks, { id: "resume", title: "Audit session report", status: "running" });
        decisions.recordRouting({
          taskId: "resume",
          provider: CODEX.provider,
          model: CODEX.id,
          bucket: "medium",
          served: "medium",
          rule: "R4",
          reasons: [],
        });
        const reading = row("codex", "home-codex", 84);
        const rows = [reading];
        const scores = new PlacedWorkScores(db, settings, (input) => reader.placed(input));
        const synchronous = vi.spyOn(scores, "data").mockImplementation(() => {
          throw new Error("main-thread history read");
        });
        const quota = {
          latest: () => snapshot(AT, rows),
          latestModels: () => buildModelsCatalog([CODEX], rows, new Date(AT).toISOString(), AT),
        };
        const accounts = new AccountSelector({
          pool: {
            list: () => [
              { id: "home-codex", providerId: CODEX.provider, label: "Codex", enabled: true },
            ],
            pinnedAccount: () => undefined,
            connectedSync: () => true,
            withheldReason: () => undefined,
            markSelected: () => {},
          },
          quota,
          decisions,
          placedWork: scores,
          flagshipAccountId: () => null,
        });
        const router = new Router({
          settings,
          decisions,
          quota: quota as QuotaService,
          placedWork: scores,
          availableModels: () => [CODEX],
        });
        const reach = {
          select: (input: Parameters<typeof reader.tasks>[0]) => reader.tasks(input),
        };
        const searching = queryTasksAsync(
          tasks,
          { text: "Audit" },
          undefined,
          undefined,
          undefined,
          reach,
        );
        const failedSearch = expect(searching).rejects.toThrow(`did not ${phase} in time`);
        const preparing = scores.prepare(rows, AT);
        const selecting = accounts.selectForSpawn("decision", CODEX.provider);
        const resuming = accounts.reselectForResume("resume", "unavailable");
        const routing = router.prepare();
        const peer = peers[0];
        if (!peer) throw new Error("reader did not open its transport");
        if (phase === "answer") {
          peer.emit({ type: "ready" });
          await vi.advanceTimersByTimeAsync(0);
        }
        await vi.advanceTimersByTimeAsync(
          phase === "open" ? RECORD_READER_TIMEOUTS.openMs : RECORD_READER_TIMEOUTS.answerMs,
        );
        await failedSearch;
        const [data, account, resumed, prepared] = await Promise.all([
          preparing,
          selecting,
          resuming,
          routing,
        ]);
        expect(data.charges).toEqual({});
        expect(scores.score(reading, AT, CODEX.id, data).charge).toBeUndefined();
        expect(account).toBe("home-codex");
        expect(resumed).toEqual({ accountId: "home-codex", changed: true });
        expect(
          router.preview(
            "Audit",
            { kind: "implement", basis: "plan", basis_verified: true },
            prepared,
          )?.result.choice,
        ).toMatchObject({ provider: CODEX.provider, id: CODEX.id });
        expect(synchronous).not.toHaveBeenCalled();
        expect(peer.kill).toHaveBeenCalledTimes(1);

        const recovered = queryTasksAsync(
          tasks,
          { text: "Audit" },
          undefined,
          undefined,
          undefined,
          reach,
        );
        const next = peers[1];
        if (!next) throw new Error("reader did not reopen after failure");
        next.emit({ type: "ready" });
        await vi.advanceTimersByTimeAsync(0);
        const batch = next.sent.find((message) => message.type === "batch");
        if (batch?.type !== "batch") throw new Error("reopened reader did not send search");
        for (const read of batch.reads) {
          if (read.request.kind !== "tasks") throw new Error("unexpected recovery request");
          next.emit({ type: "answer", id: read.id, answer: selectTasks(db, read.request.input) });
        }
        expect((await recovered).rows.map((task) => task.task_id)).toEqual(["resume"]);
      } finally {
        await reader.dispose();
        db.close();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
