# Linux source timing fixture

`linux-report.json` projects the retained `source-results.json` from run [41039506055](https://github.com/infinitary-labs/infinitary/actions/runs/41039506055), artifact `12970966303`, job `124008527604` (`source-desktop-Linux-source-desktop`).
INF-1944 retained that report in `own-playwright-json.zip`; its artifact inspection recorded the result digest `f234cfa8d97cd7d054acc359e2d91c7f996f6ae29c9b0ce7543484c2056e896f`.
The projection preserves the complete selected suites, test outcomes, actual/configured worker counts, attempt start times and durations, and aggregate statistics.
It removes environment metadata, report configuration unrelated to workers, logs, attachments, steps and error payloads.
The original observation passed 25 tests and skipped five on Linux with one actual worker.
The test context's setup and observation boundaries are explicit inputs for arithmetic checks, not measurements attributed to that historical job.
Failure and missing-data cases remove or interrupt these captured observations rather than inventing substitute execution times.
