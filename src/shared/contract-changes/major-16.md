# Major 16: the team queue's contract surface is removed

Views: keep.

The contract no longer carries the team queue, the merge line a project ran in its own CI for every approved change.
A person's own batches take its place: the app at their home combines their approved changes into one batch pull request, and the delivery value `queue-pr` stays as the saved name of batched pull requests.
The requests `inf:repos:queue-answer`, `inf:repos:queue-credential` and `inf:repos:queue-credential-create` are removed, and a home on this major refuses each as a request it does not answer.
A project's view no longer carries `queueWorkflows`, `queueAnsweredAt`, `queuePendingAt` or `queuePause`, in what `inf:repos:list`, `inf:repos:setup`, `inf:repos:configure` and `inf:devices:runs-on` answer.
The event `repo_queue` is replaced by `repo_batch`, in the `inf:event` push and in `inf:work:events`: a project's batch changed, which is the changes in line, the open batch or its hold.
The `declaration` that check_change sends through `inf:work:check-change` keeps the verdict `answered` with one meaning: it answers the host's own merge queue removing a version, and no longer the team queue's failure of one.
The host operations `plan-queue` and `keep-delivery` stay in the closed set as retired names that do nothing, so a card saved by an earlier version still reads.

Views keep working, so `VIEW_FLOOR` stays where major 15 put it.
Every removed field was optional, every removed request served only the team queue's own panels, and a view ignores an event type it does not know.
A view on major 15 of a home on this major is sent no queue pause to answer, and where it still reads a project's queue key the home refuses the read and the view shows no key.
That view does not know `repo_batch`, so it shows a batch's change at its next read of the projects rather than at once.
A view on this major ignores the queue fields and the `repo_queue` event that a home on major 15 still sends.
A computer on another major takes no work; an older paired view or phone keeps what it could do.

This major also absorbs `card-app-parts`, `card-data`, `card-put-off`, `fork-contributions`, `left-behind`, `live-validation-table`, `merge-card-since-seen`, `show-merge-card`, `story-map`, `story-part` and `task-stops`.
Each was a named wait between a home and a computer that runs its work, and work is taken only on the same major, so every admitted side has them all and the waits are gone.
A computer sends its home a card's data file before the card, a card that names an app part by reference as written, a card action's put-off choice `until`, a merge card's `sinceSeen` summary, and a story's map view, free-form part and live validation rows.
A crewmate there shows its merge card in one call through `inf:work:show-merge-card`.
A home sends a computer a task's registered `stops` with `carriedTo` and `startedAt`, reads the `leftovers` and `keptInFile` its close answers, asks `inf:computer:left-behind` for what finished tasks left there, and sends a contribution's separate push address.
A home asks none of this of a computer on another major, which takes no work.

This major also absorbs `browser-from-any-view`, `card-annotations`, `card-files`, `computer-readings-live`, `custom-token-command`, `devices-from-a-view`, `every-view-asks`, `font-choice`, `from-the-command`, `keep-going-on-credits`, `language-choice`, `panels-in-every-window`, `sign-in-return` and `streamed-events-live`.
Each crosses the view floor, so a side on this major has it by its version and a side on major 15 is still served by the name it lists (`hasSince16`, `src/shared/contractFeatures.ts`).
A desktop view on major 15 that lists none of them still receives streamed events and computer readings as numbered pushes, the look without `language` or `fonts`, cards without `files` or the Keep going on credits button, replies and threads without typed notes or `through`, and `startedByCommand: true` in its welcome.
A major that breaks views removes those older forms.
A view of a home on major 15 offers the task browser, Devices and Knowledge, the captain's panels, a sign-in's return, typed notes and a token command only when that home lists the name, and otherwise says the home needs an update.
A home refuses a sign-in whose return the asking view cannot bring back, and forwards a token command only to a computer on this major or one that lists `custom-token-command`, since sign-in orders cross majors.
A phone lists what it reads in its hello on every major, so a home still serves a phone by those names alone.
`inf:accounts:keep-going` turns an account's Keep going on credits switch on or off; an account and an allowance reading's row may carry `keepGoingOnCredits`, and an allowance catalog model and a crewmate's model choice candidate `onCredits`, with a model on credits published as the band `near_floor`.
The closed host operations hold `keep-going-on-credits`, behind the run-out cards' Keep going on credits button; a home leaves that button off every card it pushes or answers to a desktop view on major 15 that does not list the name, as it does for Allow for the rest of this task, and a home without the request refuses it as unknown.

This major also absorbs `board-without-closed`, `messages-while-reading` and `panels-on-the-phone`.
A phone reads these, with `card-annotations` and `sign-in-return`, from a home on major 16 or later by its version, and from a home on major 15 by the names in its welcome (`FOLDED_INTO_16_SINCE`).
A view reading only still sends its first mate plain words when the home is on major 16 or later, lists `messages-while-reading`, or is on a newer major than the view (`homeHearsWhileReading`); `READ_ONLY_ASKS` is unchanged.
A desktop view asks for the board without its closed rows first, and reads the whole board when an older home refuses the argument.

This major also absorbs `activity-said-here`, `feed-said-here`, `feed-said`, `after-merge-holds`, `allowance-opened`, `app-events`, `automation-event-screen`, `automation-run-found`, `batch-gate`, `batch-host-queue`, `card-logs`, `claude-access`, `decision-uses`, `fork-review-source`, `inbox-old-name-use`, `keyboard-tmux-preset`, `model-choice-turns`, `own-batches`, `own-window`, `panel-command-asks`, `provider-stuck`, `quota-credits`, `remote-sign-in-flows`, `replay-newest-lists`, `secret-approval-task`, `secrets-app-sign-in`, `secrets-last-task`, `secrets-phone-switch`, `secrets-question-in-place`, `secrets-shown`, `secrets-start-over`, `task-closed-parts`, `task-keys` and `task-pin`.
None had a named wait: each added optional fields an older side ignores, or a request an older home refuses and its asker reads as before.
Feed lines, task events, first mate notes and a project's Runs on event may carry `said`, the app's own words as a fact, and an Activity or feed line may carry `saidHere`, so a view names the first mate's computer where the line says this computer.
A change story's after-merge step may carry `holds`, a merge review may keep its source repository and host repository id, and a fork's story ledger may carry its pull request number.
A project's view may carry `batch`, this person's line of approved changes and open batch, whose open batch may carry `queued`, the version of it the host's own merge queue took; `inf:repos:batch-answer` answers a held batch, check_change may carry `batch`, and a task's `workPosture` may carry `batch` and `atProvider`.
A task's view may carry `pinnedAt`, set through `inf:task:pin`, and `children.closedIds`, its closed parts' ids in the order they closed; `inf:tasks:keys` reads tasks by their keys; and a task's `modelChoice` may carry `turns`.
`inf:cards:log` reads a proof log a merge card names.
The integrations view may carry `appEvents` and its inbox door `oldName`, an event rule may carry `waitsFor`, and an automation run may carry `screened` and `found`.
An account may carry `access`, `gateway` and its allowance reading's `credits`, the computer sign-ins view may carry `flows`, and a view sends `inf:quota:opened` when the person opens Subscriptions.
The Decisions view may carry `approvalVersion` and `uses`, switched through `inf:decisions:use:set`.
The Secrets view may carry `question`, `phones`, an entry's `kept` and `lastTask`, and a device's `paired` and `stopping`; a use may carry `signIn` and a waiting use `task`; `inf:secrets:approvals` may answer `asked`; `inf:secrets:action` takes `answer`, `ask-phone`, `cancel-phone` and `start-over`; and `inf:secrets:shown` says whether this build keeps protected storage.
The first mate's own window hears the pushes `inf:own-window:ask` and `inf:presence:dock`, and asks the home-only requests `inf:own-window:answer`, `inf:own-window:here`, `inf:own-window:focused`, `inf:voice:primed`, `inf:settings:keys:get`, `inf:settings:keys:set`, `inf:runbooks:folder` and `inf:update:hold`.
The saved keys may name the `tmux` preset with a `prefix`, and a panel manifest's command may name `asks`.
A push a later whole list replaces goes as an empty push on `inf:replaced`, and the home answers `reload` rather than a replay larger than a reload reads first.
Retiring a capability name never grants Secrets custody or use.
