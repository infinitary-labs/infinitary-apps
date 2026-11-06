import { expect, it } from "vitest";
import { readRenewals, serviceNames } from "../scripts/runner-link-readings";

// INF-2805: an alpha's update check passed every step, and GitHub still ended the job
// as lost at 05:18:45, when the ten-minute lease from the runner's last renewal ran
// out; the runner's own log was deleted with its virtual Mac. The job now reads that
// log while it can still report. The lines are the runner's own trace format and
// messages (a live runner's renewal lines, its retry messages and .NET's timeout
// text), placed at the lost job's times: renewals from 05:07:14, the last one
// answered at 05:08:45 instead of its turn at 05:08:14.
const job = "6f0c3a52-0f4e-5d1b-9d3c-2a7a4c1f9e11";
const listenerLog = [
  `[2026-11-06 05:07:12Z INFO Runner] Using BrokerMessageListener`,
  `[2026-11-06 05:07:12Z INFO BrokerMessageListener] Using provided settings`,
  `[2026-11-06 05:07:12Z INFO BrokerMessageListener] {`,
  `  "DisableUpdate": true,`,
  `  "Ephemeral": true,`,
  `  "UseV2Flow": true,`,
  `  "ServerUrlV2": "https://broker.actions.githubusercontent.com/"`,
  `}`,
  `[2026-11-06 05:07:14Z INFO JobDispatcher] Job request 0 for plan 1d2c6b0e-6a35-5f4e-8b7a-0c9e3f5d2a17 job ${job} received.`,
  `[2026-11-06 05:07:14Z INFO Terminal] WRITE LINE: 2026-11-06 05:07:14Z: Running job: Automatic alpha · Published-alpha update check / Automatic alpha · Apply published-alpha update (Mac; Apple silicon)`,
  `[2026-11-06 05:07:14Z INFO JobDispatcher] Start renew job request 0 for job ${job}.`,
  `[2026-11-06 05:07:14Z INFO JobDispatcher] Successfully renew job ${job}, job is valid till 11/6/2026 5:17:14 AM`,
  `[2026-11-06 05:07:14Z INFO JobDispatcher] Start dispatching job ${job} to worker.`,
  `[2026-11-06 05:08:45Z INFO JobDispatcher] Successfully renew job ${job}, job is valid till 11/6/2026 5:18:45 AM`,
  `[2026-11-06 05:11:25Z ERR  RunServer] Catch exception during request`,
  `[2026-11-06 05:11:25Z ERR  RunServer] System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.`,
  ` ---> System.TimeoutException: The operation was canceled.`,
  `   at System.Net.Http.HttpClient.HandleFailure(Exception e, Boolean telemetryStarted, HttpResponseMessage response, CancellationTokenSource cts, CancellationToken cancellationToken, CancellationTokenSource pendingRequestsCts)`,
  `[2026-11-06 05:11:25Z WARN RunServer] Back off 9.317 seconds before next retry. 4 attempt left.`,
].join("\n");

it("reads when the runner last reached GitHub's job service, how late each renewal came and what the listener hit", () => {
  const record = readRenewals(listenerLog);
  expect(record.jobId).toBe(job);
  expect(record.started?.toISOString()).toBe("2026-11-06T05:07:14.000Z");
  expect(
    record.renewals.map((renewal) => [
      renewal.at.toISOString(),
      renewal.secondsAfterTurn,
      renewal.validTill,
    ]),
  ).toEqual([
    ["2026-11-06T05:07:14.000Z", 0, "11/6/2026 5:17:14 AM"],
    ["2026-11-06T05:08:45.000Z", 31, "11/6/2026 5:18:45 AM"],
  ]);
  // One line per error header; the exception's stack lines carry no header and stay out.
  expect(record.errors.map((line) => `${line.level} ${line.source}: ${line.message}`)).toEqual([
    "ERR RunServer: Catch exception during request",
    "ERR RunServer: System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.",
    "WARN RunServer: Back off 9.317 seconds before next retry. 4 attempt left.",
  ]);
});

it("probes the job service the runner named, beside the results service its uploads use", () => {
  const workerLog = `        "url": "https://run-actions-3-azure-eastus.actions.githubusercontent.com/320/",`;
  expect(serviceNames(listenerLog, workerLog)).toEqual([
    "broker.actions.githubusercontent.com",
    "results-receiver.actions.githubusercontent.com",
    "run-actions-3-azure-eastus.actions.githubusercontent.com",
  ]);
});
