# The usage report

Infinitary reports every provider's usage from its own ledger to the collectors a company or a person points it at, so a team's monitoring shows Infinitary's work instead of $0.
Each destination gets one format, and nothing is ever sent in two formats.

| Piece | Where |
| --- | --- |
| The destination shape and the sender | `UsageReportDestination`, `UsageReporter` (`src/core/usageReport/usageReporter.ts`) |
| The company's Claude Code setup as a destination | `companyDestination`, `companyUsageDestinations` (`src/core/usageReport/companyDestination.ts`) |
| The two formats, from ledger rows and heard turns | `claudeCodeBodies`, `standardBodies`, `callSpan` (`src/core/usageReport/usageReportFormats.ts`) |
| The rows it reads | what `UsageStore.record` answers it wrote (`docs/usage.md`, "What the ledger records") |
| Where it is built and hears turns | `homeUsage` (`src/core/storage/homeUsage.ts`), `EventSeam.attachUsageReport` (`src/core/eventSeam.ts`) |
| Its place on the outbound list | `docs/architecture.md` §1, "Usage report destinations" |

## Destinations

A destination is one place the report goes, with exactly one format, the full OTLP/HTTP address of each signal it takes, the headers it asks for per batch, and its own resource attributes (who and which team, as the company set them).
Its source owns where it comes from and which format it was saved with: a company's Claude Code reporting setup defaults to Claude Code's format, a connection the person adds to the standard one.
With no destination, the reporter keeps nothing and sends nothing.

The company's Claude Code reporting setup (`docs/usage.md`, "A company's Claude Code setup") is one destination in Claude Code's format.
It takes the setup's per-signal addresses, its headers (the header command's included, through `companyHeaders`) and its `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME`.
It exists only where the receiver passes Claude's records on to that setup; under a managed setup Claude's own client reports and Infinitary reads no address, so other providers' calls are not sent there.
The setup is read again at most once a minute, when the reporter asks.

## The two formats

Both are written from the same ledger rows, so every number equals Settings → Usage.

- **Claude Code's format**, for a company whose panels read Claude Code's own reports.
  Claude work is Claude's own records, passed on unchanged; the reporter never repeats a row whose provider is the Claude client (`anthropic-claude`), so nothing is counted twice.
  Every other provider's calls go under Claude Code's names: `claude_code.cost.usage` in US dollars, `claude_code.token.usage` by `type` (`input`, `output`, `cacheRead`, `cacheCreation`), and a `claude_code.api_request` log event with the model, the four token kinds and `cost_usd`.
  Each carries a `provider` attribute, so a panel that checks spend against Anthropic's bill filters by it.
- **The standard format**, OpenTelemetry's conventions for AI calls at version 1.37.0, pinned on every scope's schema address because those names are still marked in development.
  All work, Claude's included: `gen_ai.client.token.usage` as a histogram by `gen_ai.token.type`, provider and model, and `infinitary.cost.usage` in estimated US dollars, since the conventions define no cost.
  The conventions name only `input` and `output` token types; cache reads and writes go as `cache_read` and `cache_creation` rather than folding into input, because a provider's input count may or may not include them.
  Traces hold one `invoke_agent` span per first mate or crewmate turn, a `chat {model}` child span per ledger row, and an `execute_tool {name}` child span per tool run; context shortening and provider retries are not tool runs.

Every metric, event and span is grouped by `infinitary.role` (`firstmate`, `crewmate` or `other`) and the task's saved kind of work (`infinitary.work_kind`), never a task title, project name, prompt or output.
`service.name` is `infinitary` unless the destination's own attributes name another.
Metrics are delta sums: each batch says only what it adds.

The ledger keeps no call timing, so a model call's span runs from the turn's previous boundary to the moment the call was recorded.
A turn that never ends, such as a session that crashed, is forgotten after six hours; a task that finishes ends its open turn.

## Sending

The reporter runs on the computer that keeps the ledger, whichever computer the session ran on.
A batch goes five seconds after its first row or span, as Claude's client batches its own reports, and once more as the app stops.
Each signal is one OTLP/HTTP JSON request with the destination's headers; redirects are refused and a request gives up after ten seconds.
A refused or unreachable destination drops that batch with one log line naming its host and the HTTP status or failure, never a header value; recording a row never waits on the network.
A signal a setup sends over gRPC takes no JSON request, so its source offers no address for it; a signal set to `http/protobuf` takes the JSON body at the same address, which OTLP/HTTP collectors accept.
