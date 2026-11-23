# The two switches

Roadmap 1.4.
Diagnostics was turned on by default by the captain's decision of 2026-09-22 ("on from the first cask ... opt-out, disclosed in the notice") and, the same day, widened from one anonymous daily count to the event set below with an anonymous install ID (captain: "i need accurate accounting for user funnel and retention").
This page is the one home for what may leave this machine for us, and the code that keeps the promise.
[Infinitary’s privacy policy](https://getinfinitary.com/privacy) is the published policy for Diagnostics and phone notifications.
It does not cover Contribution, which stays hidden and off until approved terms are published.
Until then this page and the alpha notice (`packaging/alpha-notice.txt`) are what describe the build.

## The promise, in code

Two switches on Settings → General → Sharing are the only switches that send anything to us, and no feature is gated on either:

| Switch | Default | What leaves | Where it goes today |
| --- | --- | --- | --- |
| Diagnostics | **On** - the switch is the opt-out | The allowlisted events below, each with the app version and an anonymous random install ID, and nothing else | The endpoint Infinitary Labs, Inc. operates, whose ids a release build carries; a source or dev build has none and sends nowhere |
| Contribution | Off | Redacted records of the first mate's own decisions: the R2 `decided` task events, in the shapes the corpus export packages, run through the same redaction | Nowhere yet. The switch is absent from every build until the terms are published (`DATA_TERMS.published`), and there is no sender - the seam is `contributionSender` on the service |

Whatever the switches say, the update check an installed copy already makes carries a yes/no active mark ("The update check's active mark" below), and the section says so in a line under them.
The one other thing that reaches a service of ours is a card notification for a paired phone that turned them on, sealed under that phone's key so we cannot read it, through the push relay (`docs/phone-push.md`, and the draft terms' section 2).
That relay is the one service of ours a person's work passes through, and it cannot open what it forwards.
A `/feedback` report is not a switch: the person reads it whole and publishes it themselves, as a public issue on Infinitary's own project (`docs/feedback.md`).

### The policy: no personal data, no user content

`src/shared/diagnostics.ts` is its one code home.
Three rules:

1. **A closed, code-defined event set.**
   An event is a name in `DIAGNOSTIC_EVENTS` and nothing else.
2. **Allowlisted fields of three types.**
   An event's data is exactly the fields its entry declares, plus the app `version`.
   A field is an `enum` of code words, a `boolean` or a finite `number`; the version is checked as a version string.
   There is no free-form string type, so no text a person wrote or a machine names - a conversation, a prompt, code, a card, a task or repository title, a path, an account, an email, a host name - can ride any event.
   An error's message never leaves; only its kind.
3. **One identifier: the anonymous install ID.**
   A random (version 4) UUID from `crypto.randomUUID`, minted at boot the first time Diagnostics is on, derived from nothing about the person or the machine.
   Turning Diagnostics off drops it (and everything waiting); turning it back on mints a new, unrelated one.
   It is what lets daily and weekly actives, the first-run funnel and retention count per install.
   The update check reads the release feed whatever the switches say, and carries no identifier: the Mac updater library's own per-install ID is neither sent nor kept (`docs/alpha.md`, "Update channels"), and its active mark (below) is a yes/no, not an ID.

The check is `diagnosticDataViolation`; `buildDiagnosticBody` refuses to build anything that fails it, and the wire client re-checks every body it is handed against the whole shape (`diagnosticBodyViolation` in `src/core/telemetry.ts`), so nothing outside the policy leaves even through a caller that builds its own.
Widening what leaves is an edit to the allowlist, reviewed, and moves `diagnostics.test.ts`'s expectation, the alpha notice and this page together.

### The update check's active mark

The first answered read of the release feed each Pacific day carries one header, `Infinitary-Active: day`, and the first of each Pacific month `Infinitary-Active: day, month`, whatever the Diagnostics switch says.
It lets Infinitary Labs count the copies in use when Diagnostics is off: the download server passes each mark on as one count with no address, ID or version, stores nothing, and counts nothing for a request without a mark.
Days and months are Pacific, the stats page's own day, so a copy counts at most once a day there.

- `src/core/update/activeMark.ts` owns it: `createActiveMarks(dataRoot)` answers the mark the next read carries, or none once the day is marked.
  The copy keeps only the last day and month it marked, in `active-mark.json` in the data root, written once the server answered; a failed or offline read, or a missing feed, leaves the mark for the next read.
  There is no counter, no ID and no time of day.
- Only an installed copy sends it, and only to the download server: a direct Mac copy's feed read (`src/main/host/macUpdates.ts` sets it on the update library's request headers for the check alone, so a download never carries it), and a Linux package's read of the builds file, never its fallback to the tap.
  A Homebrew copy reads its tap on GitHub, a Windows copy reads nothing, and a development, source or test run marks nothing.
  The project's own checks that open a packaged copy with a fresh data folder (`scripts/check-app-launch.sh`, `scripts/check-user-data-dir.sh` and the Linux package checks' `tests/installed/installedApp.ts`) write today's `active-mark.json` there first, so they are never counted.
- `src/core/update/activeMark.test.ts`, `src/core/update/updateChecker.test.ts` and `src/main/host/macUpdateFeed.test.ts` hold the days, the months, the read it rides and the reads it never rides.

Settings → General → Sharing says it in a line under the switches, and the alpha notice and the privacy policy say it too.

### The events

Every event also carries `version` (the app version) and the install ID.

| Event | Fields | When |
| --- | --- | --- |
| `app_launch` | - | Every launch |
| `main_agent_turn_end` | `trigger`: `captain` \| `operation` | A first mate turn ended without an error - the daily-active signal (`captain` = the person asked; `operation` = the app's own work woke it) |
| `main_agent_turn_failed` | `trigger`: `captain` \| `operation`; `reason`: `sign_in` \| `time_limit` \| `provider` \| `no_session` \| `error` | A first mate turn failed; the kind of failure only |
| `ftue_first_launch` | - | The first launch |
| `ftue_gate_shown` | - | The first-run gate asked to connect a subscription |
| `ftue_signed_in` | - | The first subscription that can answer closed the gate |
| `ftue_first_turn` | - | The person's first message to the first mate |
| `ftue_first_spawn_started` | - | The first crewmate started work |
| `ftue_first_spawn_succeeded` | - | The first crewmate reported back |
| `ftue_first_disposal` | `outcome`: `landed` \| `merged` \| `released` \| `answered` \| `settled` \| `finished` \| `cancelled` \| `discarded` \| `failed` \| `superseded` | The first crewmate's task closed |
| `ios_launch` | `device`: `iphone` \| `ipad` | The phone app started |
| `ios_opened` | `device` | The phone app came to the front |
| `ios_ftue_joined` | `device` | The phone joined its computer |
| `ios_ftue_first_message` | `device` | The phone's first message to the first mate (the computer derives it from the first `ios_message_sent`) |
| `ios_message_sent` | `device` | The phone sent the first mate a message |
| `ios_card_answered` | `device` | The phone chose an action on a card |

The `ftue_*` events are the first-run funnel: each goes at most once per install, the first time it happens.
The milestone is kept on the row even while Diagnostics is off - a local fact - so turning it on later never reports an old step as new.

### A phone's events

The captain's choice on INF-2631: the phone app (Infinitary on iPhone and iPad, `docs/ios.md`) sends nothing to the endpoint itself; it hands its `ios_*` events to the computer it is paired with, and the computer sends them under the computer's own Diagnostics switch and notice.
Nothing about this shows on the phone.

- The phone keeps a short queue of what happened (`PhoneDiagnosticsQueue`) and hands it over the connection on `inf:settings:sharing:phone` only when the computer runs major 14 or later, or its welcome names the older `phone-diagnostics` change, and its access is full (`PHONE_DIAGNOSTICS_SINCE`); an older computer, or a read-only one, gets nothing and the queue is dropped.
- The connection names the asking phone (`view` on the captain actor), and only a paired phone may hand one; `SharingService.recordPhone` keeps it only while Diagnostics is on, the notice was answered and the build has a destination - otherwise it is dropped, never held for later.
- Each phone gets its own random install ID on its first event, kept on the row under `phones` by device; turning Diagnostics off drops every phone's ID, and removing a phone, or a phone leaving, drops its ID and what of it waits.
- A phone event goes out with hostname `ios`, title `Infinitary`, the url `app://infinitary-ios/<event>`, the phone app's version and the phone's install ID; the `ios_ftue_*` steps go once per phone ID.

### The body, exactly

Each event is one POST to the endpoint's `/api/send`, Umami's event shape, with this body and nothing more (`buildDiagnosticBody`):

```json
{
  "type": "event",
  "payload": {
    "website": "<the endpoint's site key>",
    "hostname": "app",
    "title": "Firstmate 3000",
    "url": "app://firstmate-3000/<event>",
    "name": "<event>",
    "data": { "<field>": "<allowlisted value>", "version": "<the app version>" },
    "timestamp": <when it happened, whole seconds>,
    "id": "<the anonymous install ID>"
  }
}
```

The request's `User-Agent` is `firstmate-3000/<version> telemetry` (it passes Umami's bot check) and it carries no cookie.
The site key is the endpoint's routing key, the same in every copy of a build.
The timestamp is the event's own time, so an event that waited (for the notice, or offline) lands on the day it happened; the endpoint sees the arrival time anyway.

`id` is how the install ID becomes Umami's session.
The endpoint runs Umami 3.1.0 (its tracker and its bundles say so), whose `/api/send` sets `sessionId = uuid(website, id)` when `id` is present and stores `id` as the session's `distinctId` - so one install is one session for as long as Diagnostics stays on, whatever its network.
(Umami 3.4 folds the address, user agent and a monthly salt into the session as well, so after an upgrade per-install counting would read `distinctId`, which every event still carries.)
The address a request comes from is the endpoint's configuration to drop, not the app's.

### Four rules the code keeps, each with its test

1. **Nothing sends before the person has been told.**
   On the first launch a notice under the input (`src/renderer/src/app/DiagnosticsNotice.tsx`) says what goes and offers "Turn off" beside "OK".
   It shows while the switch is on, the build has a destination and the person was never shown what Diagnostics sends (`viewedAt`), launch after launch, until it is answered.
   Events recorded before then wait on the row; "OK" stamps `viewedAt` and they go, oldest first.
   "Turn off" is the opt-out, and nothing is ever sent.
   Both choices keep the notice open and hold competing actions until the save answers.
   A refused save keeps its reason beside the last saved Diagnostics state, re-read through the shared `SettingSave` writer, even if a partial write has made the notice no longer due.
   If that re-read fails too, the notice says so and offers another attempt here; it never presents the last confirmed state as newly verified.
   A successful retry dismisses the notice, and saved sharing pushes still update whether it is owed.
   Opening the payload viewer in Settings stamps it too.
   The cask's caveats and every public release's notes carry the same disclosure before the first launch (`packaging/alpha-notice.txt`).
2. **Only what was shown, in order, until accepted.**
   `record` puts an event on the row's `pending` list; one send is on the wire at a time, and an event leaves the list only once the endpoint accepted it.
   A refusal (offline, the endpoint down) stops the run until the next event or the hourly retry (`DIAGNOSTICS_RETRY_MS`), across relaunches.
   At most `DIAGNOSTICS_PENDING_CAP` events wait; past it a new one is dropped, so the funnel's beginning is what stays.
   The viewer's "waiting to send" is those events built by the same function, so it is byte for byte what the wire carries; the most recent sent ones stay listed under "sent".
3. **The opt-out stops everything.**
   Off, `record` builds and keeps nothing, the install ID is gone and what waited is dropped.
   A row someone wrote "off" stays off across upgrades and relaunches, and a `sharing` row that exists but cannot be read counts as off, never as the default (`SettingsStore.getSharing`).
   The D-12 environment opt-out (`INFINITARY_TELEMETRY=0`) still empties the destination, and a build with no destination keeps nothing either.
4. **The switch is the core's.**
   The `sharing` settings row is written only by `SharingService` (`src/core/sharing/sharingService.ts`) and pushed whole as `inf:sharing` on every write, the way the captain's preferences travel.
   A relaunch reads the row; a fresh window profile cannot forget it.

## How it is built

- `src/shared/diagnostics.ts` is the allowlist and the policy check.
- `src/shared/sharing.ts` is the shape: `DATA_TERMS` (`published`, `file`, `version`), the row (`enabled`/`viewedAt`/`sentAt` per channel, Diagnostics' `installId`, `milestones` and `pending`, which default so a row from before them parses, plus the one-time ask), `DEFAULT_SHARING` (Diagnostics on, Contribution off), the view the window renders, the preview (`PROTOCOL_VERSION` 1.22.0).
- `src/core/telemetry.ts` is the wire: `buildDiagnosticBody`, `diagnosticBodyViolation` and a client whose one verb is `send(body)`, refusing any body outside the policy and resolving whether the endpoint accepted it.
- `SharingService` is the one writer and the one caller of the wire: `start()` (once at boot, `src/core/services.ts`) mints the install ID on a first launch, records `app_launch` and sends what an earlier run left; `record(event)` is the one way in; `close()` stops the retry and drains the wire on quit.
  The last `DIAGNOSTICS_SENT_KEEP` sent events stay inspectable for the session.
- The events come from three seams, each passing no content: the first mate's `onTurnSettled` (who the turn answered and, failed, only `turnFailureReason`'s kind, classified from the raw message in `firstmateAgent.ts`); `FirstRunService`'s `onStep` (gate shown, first sign-in, first turn); and `crewMilestoneFor` on the `broadcastEvent` seam (a crewmate's `task_started`, its first `task_report`, its work task closing).
  The contribution backlog is `TaskService.decisionBacklog` (the `decided` events newer than the last send), redacted with `redactDeep` on the way to the viewer and the sender alike.
- The channels are `inf:settings:sharing:get|set|viewed|preview|ask|phone` on the core surface (`phone` is reached only by a paired phone); the push is `inf:sharing`.
- The window is `src/renderer/src/settings/SharingSection.tsx`: the rows, the "What would leave this computer" viewer (the install ID, what waits, what went, and every event and field the allowlist has, read from the allowlist itself), "The terms" (the file this build ships, bundled with `?raw`, shown only once `DATA_TERMS.published` is true - the draft is not in force, so an alpha build shows no terms and the row, the viewer and the alpha notice describe it), and the ask panel `SharingAsk` at the top of Settings while an ask is pending.
  The first-launch notice is `DiagnosticsNotice`, in the design skill's strip under the input (`components/voice/VoiceInput.prompt.md`, "Under the pill").
- The ask (terms §6) is `SharingService.noteLocalModelEnabled()`: the seam the local model's own enablement calls, once, under published terms.
  No local model option exists yet, so nothing calls it today; when one lands, its enablement is the one caller.
  "Not now" is a full answer and the app never asks again on its own.

## Evidence

- `src/shared/diagnostics.test.ts`: the policy over the allowlist - only enum/boolean/number fields, code words for every name and value, the exact event set field by field, and refusals of free text, unknown fields and events, and an odd version.
- `src/core/telemetry.test.ts`: every body the allowlist can produce (every event, every value) checked key by key; the builder's refusals; the wire refusing a widened body unsent.
- `src/core/core.connection.test.ts`: a paired phone's event reaching a stand-in endpoint under its own ID, nothing while off, a new ID after, the window refused, and removal dropping the ID.
- `src/core/sharing/sharingService.test.ts`: on by default and silent until told, the launch minting the ID, sends in order and only once accepted, a refused send surviving a relaunch, each first-run step once even across an off stretch, the opt-out dropping the ID and a new one on return, a policy-refused entry dropped unsent, an older row parsing, the destination rule, the cap, the retry timer, the crew milestones, the unpublished refusal, the ask.
- `src/core/firstRun.test.ts` and `src/core/orchestrator/firstmateAgent.flagship.test.ts`: the first-run steps, and each turn's trigger and failure kind (never its message).
- `src/renderer/src/settings/SharingSection.test.tsx` and `src/renderer/src/app/DiagnosticsNotice.test.tsx`: the rows, the viewer with the install ID and the whole catalog, the notice's words and when it is owed, the words that reach no surface.
- `tests/e2e/sharing.spec.ts`: Turn off and OK refusals, pending choices, failed re-reads, partial saves, keyboard retries and their saved state across relaunch; the real wire client against a local stub endpoint - silent while the notice is unanswered; after "OK" a fresh gated install walks the funnel through the window (gate, key sign-in, welcome, first turn, a failed turn) and a second install the crew half (a crewmate started, reported and landed), every body checked key by key against the allowlist and none carrying a word typed; the viewer shows the ID and the catalog; a relaunch keeps the ID and repeats no first-run step; two installs have different IDs; and an install turned off on the notice sends nothing across a relaunch until it is turned back on, under a new ID.

## Words

"Diagnostics", "Contribution", "Sharing", "What would leave this computer", "The terms", "anonymous usage events", "a random install ID".
The words telemetry, analytics and the vendor's name reach no user surface; the e2e and the renderer tests check.

## Notes moved from AGENTS.md

Moved verbatim from `AGENTS.md` on 2026-09-24; `docs/README.md` lists this page.

- The two switches (roadmap 1.4, captain lock F4c; Diagnostics on by default and set to the event set with an anonymous install ID by the captain on 2026-09-22; `docs/sharing.md` is the one home): what may leave this machine FOR US is Settings → General → Sharing, no feature gated on either, beside the update check's yes/no active mark ("The update check's active mark" above).
  Diagnostics sends ONLY the events `src/shared/diagnostics.ts` declares (`app_launch`, `main_agent_turn_end`/`_failed`, the `ftue_*` first-run funnel, each first-run step once per install), each with allowlisted enum/boolean/number fields, the app version and the anonymous install ID (a random UUID, dropped when the switch goes off and minted anew when it comes back; Umami 3.1 makes it the session).
  THE POLICY is no personal data and no user content: there is no free-form field type, an error leaves only as its kind, `buildDiagnosticBody` (`src/core/telemetry.ts`) refuses anything else and the wire client re-checks every body (`diagnosticBodyViolation`); widening what leaves is an edit to the allowlist that moves `diagnostics.test.ts`, the alpha notice and `docs/sharing.md` together.
  `SharingService` (`src/core/sharing/sharingService.ts`) is the ONE writer of the `sharing` row and the one caller of the wire: `record(event)` is the one way in (off, nothing is built or kept; the events come from the first mate's `onTurnSettled`, `FirstRunService.onStep` and `crewMilestoneFor` on the `broadcastEvent` seam, none carrying content), events wait on the row until the endpoint accepts them, and nothing goes until the build has a destination (a dev build has none) and the person has been TOLD (`viewedAt`, stamped by the first-launch notice's "OK" - `src/renderer/src/app/DiagnosticsNotice.tsx` - or the Settings viewer painting); a row written off stays off and an unreadable row reads as off.
  The viewer shows the install ID, what waits and went (built by the same function) and the whole allowlist.
  Contribution is the redacted `decided` backlog (`TaskService.decisionBacklog`, `redactDeep`), off, absent while `DATA_TERMS.published` is false, refused on if asked, and without a sender (`contributionSender` is the seam).
  The one-time ask (terms §6) is `noteLocalModelEnabled()`; nothing calls it today.
  Every write pushes the whole view as `inf:sharing`; the words telemetry/analytics/Umami reach no user surface.
  `tests/e2e/sharing.spec.ts` runs the real wire client against a local stub through the whole first-run funnel and is the binding test.
