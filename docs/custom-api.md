# Custom API connections

## Accepted contract and delivery

FI3-337 consolidates the captain's FI3-327/FI3-334 choices.
The feature supports public, private/VPN and local HTTP/HTTPS, with connection-scoped organization CA approval for private HTTPS.
FI3-1312 (captain's direction A) removed the questions an address already answers: the network class is read from the address on Save, Save is the approval to send to the address it shows, and Save checks everything.
A server that needs no key gets none, wherever it is: an empty key field means no key.
FI3-974 adds the person's own extra request headers (captain's choices: one row per header, a Secret switch on each, stored beside the key, and headers may stand in for the key); "Extra request headers" below.
FI3-485 extends HTTP to public addresses (captain chose direction B), behind independent unencrypted approval and a stronger public-internet warning.
Chat Completions, Responses and Anthropic Messages are explicit protocol choices.
Anthropic Messages (FI3-1754) runs Pi's own Anthropic adapter through the same guarded transport: `POST {base}/messages` with `x-api-key` and `anthropic-version: 2023-06-01` (no `Authorization`), and `GET {base}/models` the same way.
The base address ends in `/v1` like the others, and Pi's adapter is given a base without it because it appends `/v1/messages` itself.
Responses defaults to `store:false`; only connection-specific retention consent can permit omission, never `store:true` or server-saved continuation.

The complete connection flow is exposed from **Intelligence → Add account**, first setup and a connection's **Edit**, using the same bounded, focus-contained dialog (`CustomApiDialog`); Escape closes the dialog alone, not Settings around it.
The same form adds a connection for a computer that runs work, from that computer's Add account row (`docs/helper.md`, "Its own sign-ins").
The form is drawn here and that computer reads the address, checks each model and keeps the key; this Mac keeps no copy.
A connection saved there shows Edit and Disconnect only, and never offers the first mate's own model.
P1's guarded transport remains the only custom request boundary; P2–P4 add its account, model, lifecycle, scoped certificate and Responses integration.
Built-in providers and the person's `models.json`/auth configuration are not repointed.

A named connection receives an app-generated `fm-custom-<16 hex>` provider identity and its own account.
Model names and addresses are data, never paths.
The account owner writes one unencrypted private `custom-auth.json` under 0700 account directories with mode 0600.
Pi receives only an in-memory availability marker, never the key, ambient credentials or connection-owned auth/model files.
The provider-name pattern is reserved for app-owned connections.

## P1: guarded transport

`src/core/pi/customApiPolicy.ts` owns canonical base addresses, network classes, literal bearer validation and safe errors.
`customApiTransport.ts` owns the actual native Node HTTP/HTTPS requests, without mutating global fetch, agents, proxy settings or trust.
A transport captures one destination and credential; there is no address/key setter and no credential getter.
Constructing one sends nothing.
`close()` is terminal, cancels DNS waits, aborts requests/streams and releases the captured key.
This is a transport lifetime, not the account Pause policy.

- Public mode accepts publicly routed HTTP/HTTPS; private mode accepts private IPv4, unique-local IPv6 and shared-address VPN HTTP/HTTPS.
  A DNS change into another class is refused.
  Local mode permits hostnames as well as the exact `127.0.0.1` and `[::1]` literal forms; every request must resolve only to loopback addresses, and a later DNS change outside loopback fails closed.
  The name remains the HTTP Host and TLS identity, so a local server can route by its own name without a Host override.
- Nobody chooses the mode: `readCustomApiDestination` reads it when a draft is prepared, from every DNS answer of the address's name, or from the literal address (`classifyCustomApiAddresses`).
  All answers must fall in one class; answers in two classes, a forbidden range or no answer at all are refused as `destination`, and a name that does not resolve as `network`.
  The class read is stored with the connection and held on every request as an explicit choice was.
  A same-address edit keeps the class the connection was saved with, including one chosen explicitly before FI3-1312, and a changed address reads its own.
  A name that later resolves into another class fails closed, as before.
- The full base path/port are preserved; no `/v1` is invented.
  Operation URLs return a suggestion for confirmation.
  Credentials, queries, fragments, backslashes, dot segments, repeated inner path separators and encoded/non-ASCII paths are refused conservatively.
  This first boundary deliberately does not support encoded or non-ASCII base paths; a future relaxation requires unambiguous normalization and tests, not bypassing approval.
- Every request validates **all** DNS answers (including mapped IPv4) before connecting, hands native lookup only those checked IPs and uses a fresh connection.
  One checked IP keeps an explicit address family; several go to Node's own multi-address connect, which tries the next checked IP when one refuses or does not answer within Node's attempt timeout.
  So `localhost` reaches a server listening on `127.0.0.1` alone even when its first answer is `::1`, and the other way round.
  The request is written only on the connection that answered, so nothing reaches an address that refused.
  The original host remains the HTTP Host and TLS verification identity.
  No DNS retry, redirect, proxy, alternate endpoint or ambient credential is used: another checked IP of the same answer is not an alternate endpoint.
- Link-local, unspecified, multicast, reserved/documentation/transition ranges and known metadata-service addresses are refused.
  This cannot identify every internal service or protect against a malicious approved server.
- HTTPS explicitly uses Node's bundled normal roots with hostname/chain/expiry checks.
  Ambient extra roots and global-agent modifications do not grant approval.
  Private HTTPS may append explicitly reviewed, locally supplied public PEM CAs to this transport only.
  Private keys, remote downloads and client certificates are refused.
  There is no certificate bypass.
- The only request operations are `models` (GET), `chat/completions`, `responses` and `messages` (POST).
  Callers cannot supply request headers or an alternate URL; the only extra headers are the connection's own, captured at construction ("Extra request headers" below).
  A no-key connection sends no Authorization header of its own, in any mode.
  A bearer key is printable ASCII, at most 8 KiB, without outer whitespace; shell/environment-looking values stay literal.
  No auth file, environment lookup or other account is read.
- A generation request may carry 1 MiB plus six bytes per token of its model's documented context (FI3-563), plus the encoded pictures it sends, so a large-context model is never cut off at a fixed size first.
  That bound is a connection size limit, not a token estimate: a tool call's arguments travel as JSON text inside JSON, which at most doubles them, and the 1 MiB covers the model name and fixed fields.
  A larger request is refused as the context overflow before anything is sent, so a rolling session can shorten the chat and retry.
  Whether the request fits the model's context window is left to the server and to compaction, not decided before anything is sent.
  Listing is bounded by 15 seconds and a 1 MiB reply, and each connection-check request by 60 seconds, including DNS and streaming, and a 1 MiB reply.
  A real turn's request (FI3-490) runs as long as the server keeps sending.
  It is cut off after five minutes without a reply byte (`stalled`; Pi's own HTTP idle default, which also covers the wait for headers), after one hour in all (`timeout`) or past a 64 MiB reply (`oversized`).
  Crewmates have no other time bound on a request; the first mate's own five-minute request bound (`docs/firstmate-runaway-hardening.md`) still applies on top.
  A slow/abandoned reader applies backpressure and is cut off by the same limits.
  Caller abort and terminal close apply before DNS completes and during streaming.
  Stream cancellation destroys the native request.
  There are no automatic retries.
- Redirects, 401 key rejection, 403 access refusal, 404 path/model and 429 rate limit are translated before their bodies or headers are read.
  A generation request's other server failure is read only far enough to tell whether it is a context overflow, at most 16 KiB, and the text is then discarded.
  Only that yes or no leaves the transport: an overflow becomes the context refusal a rolling session already compacts and retries on, and any other wording stays a server failure.
  A model-list error is not read.
  Raw network/TLS errors and abort reasons are also discarded, without a raw `cause`.
  Successful replies expose only a validated JSON/SSE content type, not arbitrary headers, links or request IDs.
  Success content remains untrusted; a hostile server can disguise a key in generated output.
  Trust in the operator/model remains required.

## Setup, models and selection

1. The form asks for a name, the full base address, an optional masked bearer key, the protocol, optional **Extra request headers** and the models.
   There is no network question and no no-key checkbox.
   A live line under the address reads "Sends to (canonical address) · (network)" (`inf:accounts:custom:address`, DNS only, nothing sent to the server).
   On Edit at the same address the key field reads "Saved key kept · type to replace", beside **Remove saved key**; an empty key there keeps the saved one.
   Each model row has its check status, ID, context and output tokens, Reasoning profile, Cache retention and a remove button.
   **Fetch from server** lists the server's models above the lines; picking one adds its line with the limits the server states, and **Add by hand** adds an empty line.
   Unknown/zero limits block checks and use rather than inventing limits.
2. Save, with the address shown above it, is the approval to send the key, headers and content there: the form passes the displayed canonical address as `approvedDestination`, and the owner refuses any other.
   There is no Review step and no general approval checkbox.
   Plain HTTP keeps one checkbox under the address, remembered for that address; organization certificates appear when Save fails on an untrusted certificate in the organization class, with their own approval; Responses storage keeps one checkbox.
   An approval holds for the address it was given for: a changed address asks again, and the form's one-press /v1 correction keeps it.
   Key input stays in the form until the dialog closes.
3. Save runs four stages and stops at the first problem (`inf:accounts:custom:connect`, then `check` per model, then `save`).
   It checks the form, sending nothing; it reaches the server, reading the network, preparing a draft and reading the model list; it tests each model one at a time, with progress on its line; and it saves checked and returns to the list, where first setup then asks which model the first mate answers with.
   A failure keeps the form open and saves nothing, with a plain sentence beside the field at fault: the address (unreachable, redirected, refused, untrusted certificate, or nothing at the path, with a one-press `/v1` when the path has no version), the key (refused, needed, access refused), a model's line (sizes unknown, no tool call, too slow, not offered) or above Save (rate limit, server error).
   The owner returns each failure as a closed category (`customApiFailureSchema`, and `category` on a checked model), never text the form parses; `customApiFailures.ts` places it and words it, and no raw state word reaches the screen.
   A 404 is the model's when the model list answered, and the address's when it did not.
   A server with no model list still saves: its models' checks tell.
   After a failure, a quiet **Save paused without checking** saves that attempt's draft unchecked, except on a same-address edit, which only a checked replacement may apply.
4. Listing (`GET {base}/models`) runs only on Fetch from server or Save, which are approvals to send to the address.
   It is bounded and keeps each listed ID with the context and output limits the server states (FI3-412, captain: "most expose all model info via /v1/models including limits and names").
   The limit fields read are `context_length`, `context_window`, `max_context_length`, `max_model_len` and `max_input_tokens` for context, and `max_completion_tokens` and `max_output_tokens` for output.
   They are read on the entry itself or under its `top_provider` or `metadata` object.
   A `{ data: [...] }` reply and a bare list are both accepted.
   A limit that is not a positive whole number is unknown, and so is an output limit that is not below the stated context.
   A bare `max_tokens` is not read; beside `max_input_tokens` (Anthropic's list) it is the output limit.
   A model typed without limits takes the listed ones; a typed number always stands.
   Listing never imports endpoints, headers, executable configuration, prices or capability claims.
   It never checks or activates a model, and saving still needs at least one model.
   Startup and Settings never wait for discovery.
5. A model's check uses fixed synthetic instructions and the in-memory `firstmate_echo` tool only: two text requests per offered reasoning level (once with reasoning Off) followed by an optional tool-picture request, 60 seconds total, at most 128 output tokens per request (or the smaller documented output cap).
   The two text requests must finish valid text/tool/result replay.
   The last sends a tiny synthetic picture of two digits through a tool result; only an exact answer marks that model **Reads pictures**.
   A refused, incorrect or timed-out picture answer keeps the successful text check, so Save still succeeds.
   Cancellation still prevents activation.
   The picture result is saved beside the check, bound to its fingerprint; older picture-less checks remain text-only until the next Save, with no startup request.
   No project files, real tools or first mate prompts are sent.
   Cancellation aborts and prevents late proof/activation.
6. Checked save is **unselected**.
   The Settings list shows one block per connection: name, address, an **Unencrypted** tag for HTTP, status, then Edit, Pause and Disconnect, and one line per model with its status, a **Reads pictures** tag when proved and a first mate choice; a locked control says why.
   Crew use is set only on the Models board, which shows whenever any model can be placed, a custom API's alone included.
   Paused/unchecked/unplaced custom models never enter fallback/background pools.
   Crew-only placement does not open first setup.
   The existing first mate selector/readiness refresh through the typed `inf:models:changed` push (protocol 1.41), which also refreshes the custom list.

HTTP's checkbox names exposure of the key, prompts, project code and replies, and reply tampering that can direct work on this Mac.
Public mode additionally warns about the public internet; private mode warns that a company name can resolve to someone else's private server on shared Wi-Fi.
Each HTTP row says **Unencrypted**.
Address classes and forbidden metadata/reserved ranges still apply; “any address” means public as well as private/local classes, not a bypass of these protections.
HTTPS remains preferred.

Proof binds canonical destination/mode, opaque credential revision, explicit protocol/profile, model/limits, saved capability snapshot, cache retention, certificates and storage policy.
Relevant edits invalidate it; a failed listing never establishes model departure.
Envelopes count instructions, local history and tools and honor both the role's output cap and documented limits.
These estimates/checks prove interoperability, not model quality, server capacity or absence of truncation.
Every custom turn leaves a Usage record, even when the server reports no counts; unreported categories remain unknown, never zero.
An exact model-id match in the runtime's local app catalog supplies the model's display name and listed prices; the first match in catalog order wins if multiple providers list that id.
Only descriptive and price metadata is borrowed: the approved destination, protocol, proven picture input and checked limits remain connection-owned.
Pi normalizes input, output, cache-read and cache-write counts and calculates each category once from its listed price.
A presence-only observer restores missing categories to unknown after normalization and pricing; it never invents a cache count.
When input and output are reported without a total, Pi's context-token calculation supplies the compactor's total before unknown category markers are restored.
Reported reasoning tokens remain an optional subset of output in the event and saved usage record, never another token or cost category.
An unmatched id, missing counts or missing rates leaves the estimate unavailable; nothing reprices older records.
Allowance remains unknown.

## Checked reasoning and cache settings

Each model starts with Reasoning profile Off and Cache retention None, including existing connections; a model on Anthropic Messages starts at Short, Pi's own default (`customDefaultCacheRetention`), with or without a profile.
A Messages model with no profile may choose None or Short; Long needs a profile that supports it.
Pi puts `cache_control` on the system prompt, the last tool and the last message, and reads `cache_read_input_tokens` and `cache_creation_input_tokens`; the presence observer counts those names, so neither count is reported as unknown.
A selected compatible Pi catalog profile supplies its reasoning capability, level mapping and protocol compatibility, never its address, key, protocol, model ID or limits.
The profile list is offline catalog data; the form uses the same typed reader locally or on the computer that runs work.
Only cache retentions that profile supports are offered.
Save captures the profile and checks a synthetic tool/result roundtrip at every level the existing reasoning selector can offer, plus the optional picture request.
The notice names possible charges, automatic server caching and the difference between accepted options and actual reasoning/cache hits.
A successful check proves interoperability, not that reasoning ran or a cache hit occurred.
The private connection record saves that exact capability snapshot with its proof, so a catalog refresh cannot silently change checked behavior.
Profile and retention edits require a new check; a failed replacement leaves the old connection intact.
The check, model menu and actual request share `customPiModel`; no parallel reduced definition exists.
Pi resolves supported levels, then the first mate applies its existing visible levels, duplicate suppression and downward/Quick policy.
Cache retention is opt-in and independent of Responses storage consent; no-cache requests carry no retention key, though the server may cache automatically.
A requested session cache key never becomes server-saved conversation continuation or an affinity header.

## Extra request headers

An organization's server may need headers of its own on every request: a team or tenant ID, or a gateway credential.
**Extra request headers** on the connection form takes one row per header: a name, a value and a **Secret** switch, on by default.
The connection sends them on every request it makes - the model list, all check requests and every first mate, crew and background turn - and nothing else does: built-in providers and Claude are unchanged.

- `assertCustomHeaders` in `customApiPolicy.ts` owns the rule.
  A name is a plain header token of at most 128 characters, used once in any case.
  A value is one line of printable ASCII of at most 8 KiB, with no outer whitespace, and is literal: no environment lookup or command.
  There are at most 20 headers.
- Names the transport sets or that change how a request travels or is read are refused: `Host`, `Content-Length`, `Content-Type`, `Content-Encoding`, `Accept`, `Accept-Encoding`, `Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`, `Trailer`, `Upgrade`, `Expect` and any `Proxy-` name.
  `Authorization` belongs to the key, so a header may set it only on a connection that sends no key.
- Headers may stand in for the key: like any connection, one with headers may use no key, and its `Authorization` header then carries the credential.
- Values are stored beside the key in the account's private `custom-auth.json`.
  A view returns every header's name and visibility, and only a visible header's value; a secret value never returns to the window.
  A same-address edit that leaves a secret value empty keeps the value saved under that name; a changed address never inherits one.
- A secret value joins the key in the transport's echo check, so a reply or model list that repeats it is refused.
  A visible value is not checked, so a short value such as a team name cannot block ordinary replies.
- The line above Save names the headers it sends beside the address, so Save approves them too.
- The proof binds each header's name, visibility and visible value, and a secret value through the opaque credential revision, never a hash of it.
  A connection without headers keeps the fingerprint it had before headers existed.
  Any header change is a new draft, so the models are checked again before use.

## Protocol and storage profile

All three protocols use text, pictures on models whose check proved picture input, ordinary function calls, plain system instructions, locally paired tool results and completed terminal replies.
Pi builds requests directly from its transcript and reads complete assistant messages and events, including thinking signatures, tool arguments, error flags and cache usage.
The wrapper retains paired-history checks, safe names, checked input/output limits and all pictures in the current uncompacted conversation without rewriting the saved transcript.
A tool call the app quit in the middle of reaches the paired-history check already answered as unknown, because the session answers it when the record reopens (`docs/architecture.md`, "Sessions").
Chat requests usage and a terminal finish reason; Responses keeps the checked output cap.
A narrow payload policy enforces storage consent and refuses remote continuation, background requests and service-tier changes.
The connection transport remains the only sender and ignores Pi's URL, headers and availability marker except for validating the expected operation.
The first mate holds every event until a clean finish and output validation, checks all retained fields for credential echoes, then forwards Pi's events rather than reconstructing text/tool-only replies.
A reply that uses its full output allowance and stops there is kept as a shortened answer, the same way other subscriptions keep one.
A reply cut off because the reply allowance was trimmed to fit the window is not kept: it becomes the same context refusal, so a retry that cannot recover shows the refusal instead of the cut text.
The price stays unknown when the server sends no usage.
A reply that did not stop at its output limit keeps a zero token count, so a long chat still shortens from the character estimate.
A reply that stopped at its output limit and reported no count stays unknown, so it is kept and does not become the size of the chat.
Chat's checked profile is `pi-capabilities-v4` and Responses' is `pi-capabilities-v3`, so saved models need one fresh check before use; a server rejecting the usage field fails that check without a fallback.
A saved check never counts for another profile.
When the first mate was chosen on a connection whose saved checks no longer count, the first-launch gate names that connection and runs its fresh check in place (`docs/first-launch.md`).
That check, `CustomApiAccountOwner.recheck` over `inf:accounts:custom:recheck`, sends Check model's text and optional picture requests for each unchecked model to the saved address, key and settings, which the person already approved, and changes only the proofs.
It saves each passing model at once, stops at the first failure with that model's reason, and gives the connection its runtime once every model passes, as a checked replacement does.
Disconnect or an applied replacement meanwhile ends it.
A crewmate or the first mate that cannot reach its custom connection raises the usual sign-in card, which names the connection and says to press Edit and then Save in Settings → Intelligence to check it again (`CrewTurns.signInCardBody`, `FirstmateSeat.signInCardBody`).
Like every sign-in card, it never quotes the failure: Pi's own text names its terminal sign-in and paths into the app's files, so the raw text stays on the task's timeline or the first mate turn's records.
Every consumer (turns, compaction and decision/background sessions) uses this same guarded stream; custom sessions disable automatic provider retries.
Infinitary does not estimate a request's tokens or refuse it for the documented window before it is sent.
Pi sizes each request and compacts a rolling session from the server's reported count when it sends one.
When it sends none, the token counts stay zero rather than an invalid number, and Pi compacts from its own character estimate.
A server overflow is recognized from the error reply and raised as the context refusal Pi already compacts and retries once.
Custom rolling sessions budget compaction at each prompt boundary in that same count, against the current model's window, bounded output, instructions and tool schemas.
Kept turns are a quarter of the remaining history room, and never more than Pi's default of 20,000.
The reserve is sized so the summary is that quarter, and never more than Pi's default of 16,384.
The refusal is worded as a context overflow Pi recognizes, so a rolling session compacts and retries the refused turn once instead of failing it, and the refused attempt never reaches the captain as a failed turn.
Only a request the server still refuses after that compaction, or a trimmed reply whose retry fails the same way, is shown.
Pictures stay in every request until Pi's normal compaction removes their messages; a new read does not change earlier picture or text content.
Pi sends them through its own Chat, Responses and Messages builders, and writes its capability omission note only for a text-only model.
When compaction omits picture-bearing entries, the custom rolling session annotates the active compaction summary with an accurate loss notice: a text summary does not retain visual detail, and needed pictures must be reopened.
The annotation is derived from Pi's saved boundary and original entries, so resume and later compactions retain the notice without editing original session records.
It is cached per active summary rather than rescanning the saved conversation on every request.
Compaction can rebuild the affected prompt cache; unchanged requests between those boundaries preserve prior content, excluding the provider's normal moving cache-control marker.
Retaining pictures increases request size; the transport's encoded-picture allowance and existing request protections still apply.
A picture-reading model also accepts pictures the captain attaches.

Pi parses the event stream.
Text and tool publication still wait for a clean finish and the key-echo check.
A reply may carry 16,384 events plus four per requested output token before the wrapper cuts it off, however the server splits it into chunks.
Failed/malformed partial streams and literal or ordinary escaped credential echoes cannot reach agents, feeds or tool calls.
Discovery also refuses credential echoes.
The conservative echo check can refuse coincidental matches with unusually short keys.
A hostile operator can disguise secrets in generated content; this cannot make that operator safe.

Responses sends `store:false` by default.
Rejection never causes automatic omission.
**Allow this server's storage defaults** is one explicit consent checkbox; only then is `store` omitted, never true.
The check uses that exact policy; consent persists across restart, changes invalidate proof and a new destination does not inherit it.
Neither policy uses `previous_response_id`, remote conversation objects, retrieval, polling or WebSocket continuation.
Neither policy prevents implicit server logging/caching.

## Lifecycle

- Rename preserves identity and use choices.
  Pause preserves credentials and lets admitted work finish, but subsequent requests wait for Resume.
  Valid proof is required to resume.
- Same-address replacement checks a candidate without changing the working revision.
  Apply is refused while any matching turn **or guarded background request/paused wait** is active.
  Successful apply at idle preserves Pause and use choices; failure/cancel or a paused candidate cannot replace it.
- Changed canonical host, port or base path creates a separate connection with fresh key/approval/check/use choices.
  The original stays.
- Disconnect warns, blocks new requests, closes matching transports/waits, stops matching first mate/crew work and owned background jobs, and removes only that account's files/slot-pin metadata.
  Late runtime callbacks cannot recreate them.
  History and siblings remain; the unavailable first mate choice is not silently moved.
  A pinned custom decision model also abstains rather than migrating to another account.
- Local deletion cannot revoke the server key, retract content or erase logs.

## Verification and transport trust

`customApiPolicy`, `customApiTransport`, protocol/check, account, routing and session fixtures use disposable HOME/state and synthetic keys.
Desktop journeys (`tests/e2e/custom-api.spec.ts`, through the one fill-and-save helper `tests/e2e/customApi.ts`) cover stage and Intelligence entry, the network read from the address, the one-press `/v1`, failures beside their field, paused restart, Edit in the dialog, explicit first mate placement and crew placement on the Models board, a real first mate card and crew report.
`older-profile.spec.ts` opens a custom-only profile whose checks an older release saved, for each protocol, and checks that the gate asks for that connection's fresh check right after the upgrade and that the check brings it back without a restart (`docs/saved-data-compatibility.md`, "Profiles saved by an older release").
A change to a check profile adds the new one to `CUSTOM_CHECK_PROFILES` in `tests/e2e/olderProfile.ts`, so that journey keeps opening checks the previous release saved.
The probes write fresh request transcripts, persisted views and screenshots under `test-results/`, outside committed docs.

`node scripts/test-custom-api-packaged.mjs` is an explicit macOS evidence probe, not a per-push packaging gate.
It builds the **same account owner/runtime and guarded transport** into a throwaway asar, applies the product's Electron fuses, and signs only the disposable bundle ad hoc under scratch HOME/signing paths.
It forbids keychain commands/discovery and does not use the project's local certificate or a real sign-in.
Its packaged Node performs real TLS verification; only DNS/socket selection points the validated private address at a loopback fixture.
It proves scoped acceptance, wrong-name/expired/untrusted/sibling refusal, unchanged normal trust, candidate invalidation/failure preservation, restart and removal.
This is packaged transport evidence, not a notarized release or a claim that macOS-installed CAs are recognized.
The normal roots are Node's bundled roots, not a substituted macOS trust store.
A local HTTPS peer must verify under those normal roots; local HTTP remains explicitly consented.

Public/loopback HTTPS desktop fixtures emulate a normally trusted HTTPS peer at the connector while asserting the original strict TLS options and validated class.
Private desktop TLS and packaged CA fixtures retain actual verification.
No production policy is loosened or test seam exposed by the UI.
