import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// INF-487: a pull request's newer version must not wait behind its own older phone run.
// Cancel a replaced run only where no simulator can exist yet: before its native job
// starts a device gate, or right before either gate. A started gate deletes its own simulator.

// The native job and its simulator steps, as phone.yml names them.
export const NATIVE_JOB = "native-phone";
export const DEVICE_GATES: readonly string[] = ["Read and recover on iPhone", "Read and recover on iPad"];

export type Job = { name: string; status: string; conclusion: string | null; steps?: { name: string; status: string }[] };
export type Run = { id: number; run_number: number; status: string; pull_requests: { number: number }[] };
export type Api = { get(path: string): Promise<unknown>; post(path: string): Promise<number> };
export type PhoneRun = {
  repository: string; workflow: string; runId: number; runNumber: number;
  pull: number; branch: string; headSha: string;
};

export function replacedRunVerdict(jobs: readonly Job[]): { cancel: boolean; why: string } {
  const native = jobs.find((job) => job.name === NATIVE_JOB);
  if (!native) return { cancel: true, why: "its native job has not been created yet" };
  if (native.status === "completed") return { cancel: false, why: `its native job already ended (${native.conclusion})` };
  const gate = native.steps?.filter((step) => DEVICE_GATES.includes(step.name) && step.status !== "pending" && step.status !== "queued").at(-1);
  if (gate) return { cancel: false, why: `"${gate.name}" already started and deletes its own simulator` };
  return { cancel: true, why: native.status === "in_progress" ? "its native job has not started a device gate" : "its native job is waiting for the Mac mini" };
}

/** Cancels this pull request's older phone runs that have not started a device gate. */
export async function cancelOlderRuns(api: Api, current: PhoneRun): Promise<string[]> {
  const { workflow_runs: runs } = await api.get(`/repos/${current.repository}/actions/workflows/${current.workflow}/runs?event=pull_request&branch=${encodeURIComponent(current.branch)}&per_page=100`) as { workflow_runs: Run[] };
  const older = runs.filter((run) => run.run_number < current.runNumber && run.status !== "completed"
    && run.pull_requests.some((pull) => pull.number === current.pull));
  const lines: string[] = [];
  for (const run of older) {
    const { jobs } = await api.get(`/repos/${current.repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`) as { jobs: Job[] };
    const verdict = replacedRunVerdict(jobs);
    if (verdict.cancel) {
      // A gate that starts after this read is still in its lease wait and checks: it creates its simulator minutes later.
      const status = await api.post(`/repos/${current.repository}/actions/runs/${run.id}/cancel`);
      // 409: the run ended between the read and the cancel.
      if (status !== 202 && status !== 409) throw new Error(`Cancelling phone run ${run.run_number} answered ${status}`);
    }
    lines.push(`${verdict.cancel ? "Cancelled" : "Kept"} run ${run.run_number}: ${verdict.why}.`);
  }
  return lines.length > 0 ? lines : ["No older phone run of this pull request is still going."];
}

/** Before each device gate no simulator exists: a replaced version cancels its own run there. */
export async function stopIfReplaced(api: Api, current: PhoneRun): Promise<{ replaced: boolean; line: string }> {
  const { head } = await api.get(`/repos/${current.repository}/pulls/${current.pull}`) as { head: { sha: string } };
  if (head.sha === current.headSha) return { replaced: false, line: "This version is still the pull request's latest." };
  const status = await api.post(`/repos/${current.repository}/actions/runs/${current.runId}/cancel`);
  if (status !== 202) throw new Error(`Cancelling this replaced run answered ${status}`);
  return { replaced: true, line: `A newer push (${head.sha.slice(0, 8)}) replaced this version, so this run stops before its next device gate.` };
}

function fromEnvironment(): { api: Api; current: PhoneRun } {
  const env = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set`); })();
  const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as {
    pull_request: { number: number; head: { ref: string; sha: string } };
  };
  const workflow = /\.github\/workflows\/([^@/]+)@/.exec(env("GITHUB_WORKFLOW_REF"))?.[1];
  if (!workflow) throw new Error("GITHUB_WORKFLOW_REF names no workflow file");
  const headers = {
    Accept: "application/vnd.github+json", Authorization: `Bearer ${env("GITHUB_TOKEN")}`, "X-GitHub-Api-Version": "2022-11-28",
  };
  const base = process.env.GITHUB_API_URL || "https://api.github.com";
  return {
    api: {
      get: async (path) => {
        const answer = await fetch(base + path, { headers });
        if (!answer.ok) throw new Error(`GET ${path} answered ${answer.status}`);
        return answer.json();
      },
      post: async (path) => (await fetch(base + path, { method: "POST", headers })).status,
    },
    current: {
      repository: env("GITHUB_REPOSITORY"), workflow, runId: Number(env("GITHUB_RUN_ID")), runNumber: Number(env("GITHUB_RUN_NUMBER")),
      pull: event.pull_request.number, branch: event.pull_request.head.ref, headSha: event.pull_request.head.sha,
    },
  };
}

async function main(mode: string | undefined): Promise<void> {
  const { api, current } = fromEnvironment();
  if (mode === "cancel-older") {
    const lines = await cancelOlderRuns(api, current);
    for (const line of lines) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      ["### Older phone runs of this pull request", "", ...lines.map((line) => `- ${line}`), ""].join("\n"));
  } else if (mode === "stop-if-replaced") {
    const { replaced, line } = await stopIfReplaced(api, current);
    console.log(replaced ? `::notice::${line}` : line);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `replaced=${replaced}\n`);
  } else throw new Error("Pass cancel-older or stop-if-replaced");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv[2]);
