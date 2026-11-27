import { X509Certificate } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { createKeyIdentity } from "../../src/core/devices/identity";
import { DevicePairing } from "../../src/core/devices/pairing";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask, type TaskSeed } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { type DeviceGrant, parsePairingLink } from "../../src/shared/devices";
import { scratchDir } from "../helpers/scratchDirs";
/**
 * `counts[m]` idle crewmates on computer `m` (0 is this Mac), as
 * `sample-<m>-<i>`; `relate` then adds rows and relationships among them,
 * given each computer's device id. Optional facts describe each real task
 * before its normal start; device placement and workspace stay owned here.
 * @journey-area src/core/devices/pairing.ts
 * @journey-area src/core/tasks/taskPlacement.ts
 */
export function clusterFixture(
  counts: number[],
  peers?: DeviceGrant[],
  relate?: (tasks: TaskService, deviceIds: (string | undefined)[]) => void,
  facts?: (
    computer: number,
    index: number,
  ) => Partial<Pick<TaskSeed, "title" | "model" | "outcome">>,
) {
  const dir = scratchDir("fm-cluster-capture-");
  const pairing = new DevicePairing({ dir: join(dir, "devices"), ownUid: 501 });
  const ids: (string | undefined)[] = [undefined];
  for (let i = 1; i < counts.length; i++) {
    const key = createKeyIdentity("Sample work computer");
    const { link } = pairing.invite({ kind: "work" });
    const answer = pairing.claim(
      {
        code: parsePairingLink(link).code,
        kind: "work",
        name: `Studio Mac ${i}`,
        user: { name: "builder", uid: 502 },
      },
      {
        headers: {},
        socket: {
          remoteAddress: "192.0.2.30",
          getPeerX509Certificate: () => new X509Certificate(key.cert),
        },
      } as unknown as IncomingMessage,
    );
    if (!answer.ok) throw new Error(answer.reason);
    ids.push(answer.grant.deviceId);
    peers?.push({
      ...answer.grant,
      at: "127.0.0.1:1",
      homeKey: pairing.identity().pin,
      key: key.key,
      cert: key.cert,
    });
  }
  pairing.dispose();
  const db = openDatabase(dir);
  const tasks = new TaskService({ db, strict: true });
  counts.forEach((count, m) => {
    for (let i = 0; i < count; i++) {
      const worktreeDir = join(dir, "crew", `${m}-${i}`);
      mkdirSync(worktreeDir, { recursive: true });
      seedTask(tasks, {
        id: `sample-${m}-${i}`,
        title: `Work on computer ${m}, task ${i}`,
        status: "idle",
        worktreeDir,
        deviceId: ids[m],
        sessionFile: ids[m] ? `placed-${m}-${i}.jsonl` : undefined,
        outcome: "Waiting for the captain.",
        ...facts?.(m, i),
      });
    }
  });
  relate?.(tasks, ids);
  db.close();
  return dir;
}
