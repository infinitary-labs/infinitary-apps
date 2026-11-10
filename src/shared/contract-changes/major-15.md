# Major 15: protected Secrets controls

Views: break.

The closed host-action set adds `secrets-decision` for process-local, one-use approval offers, so an older side cannot safely interpret every card action.
Views read this host-action set in card snapshots, and it is not an open list in `VIEW_OPEN_LISTS`, so `VIEW_FLOOR` moves to this major.
The contract adds home-only Secrets metadata, trusted entry, exact-operation rehearsal, history and recovery actions, with no general value, native-root or recovery-key getter.
Entry replacement carries the exact sealed-record revision as well as its displayed version, preventing a stale form from replacing a recreated entry.
Secrets metadata carries no discovery links: discovery is global, and a reference grants no use.
A new entry may leave out its reference; the home makes a stable one and answers with the reference and version it saved.
Recovery chooses files only through the native host and resets permissions and device trust without making recovered history live authority.
The paired-view requests `inf:secrets:approvals`, `inf:secrets:enroll` and `inf:secrets:decide` expose waiting-use descriptions, offer an approval key for confirmation on the home, and take a signed Allow or a refusal.
A waiting use, in Settings and on a paired view, names each requested secret by name, environment label, reference and version as the use prepared them, never its value.
A task on a computer that runs work lists the same Secrets metadata through the `inf:work:secrets` read and the placed spec's `secrets`; no work request carries a use, receipt or value.
Enrollment changes nothing before the captain compares the code and confirms on the home; an Allow needs the enrolled key's signature over the exact request and its fresh challenge.
A computer on another major takes no work; an older paired view remains read-only until updated.

Every side taking work retains major 14's one merge effect: `merge`, with `after: close | continue`, optional `review`, `asksFirst` and `proceedWithOpen`.
The `settle` effect keeps only `discard`, and saved `settle` merges and `request_merge` effects convert once to `merge`.
Reports carry no `mergeCompletesTask` field; the open merge card's `after: close` owns that declaration.
Every side also includes major 13's queue delivery and the preceding named additions: `after-merge-steps`, `answer-stuck-reads`, `card-leave`, `card-origin-line`, `card-reply-interim`, `checked-out-branch`, `conversation-folds`, `files-there`, `note-done`, `open-change-branch`, `panel-arrangement`, `panel-integrations`, `phone-diagnostics`, `project-queue-facts`, `queue-choice-waits`, `shared-cards`, `task-pull-requests`, `thread-sign-off`, `update-checked-at`.
Same-major work replaces their named waits, including shared-card writes, thread sign-off, conversation folds, files, answered waits and branch selection.
A view reads shared-card contributors from major 14 on, or from an older peer that names `shared-cards` (`SHARED_CARDS_SINCE`, `src/shared/contractFeatures.ts`); older peers still receive the older thread shape.
A phone sends usage readings only to a home on major 14 or later, or an older home naming `phone-diagnostics` (`PHONE_DIAGNOSTICS_SINCE`).
The established scene-observation and current-update-sighting thresholds remain major 12 and major 13 respectively.
Retiring a capability name never grants Secrets custody or use: the remote catalog remains metadata-only and requires the current work major.

This major also absorbs `after-merge-doer`, `check-queue-answer`, `computer-github-cli`, `crewmate-programs`, `custom-api-address-exception`, `ended-cards`, `firstmate-folding`, `frame-parts`, `gitlab-queue-token`, `integration-task-allow`, `keep-cards-maximized`, `review-covers`, `shipped-queue`, `stall-card-backlog`, `story-fact-copies`, `task-place-catching-up` and `task-run-null-review`.
A task's place may carry `catchingUpSince` while its computer is connected and the home is still catching up; this optional display field grants no work or Secrets authority.
An after-merge item may name its `doer` as `crewmate` or `firstmate`; a first-mate item files no task and reaches the first mate through the merge's settled wake.
Every computer admitted to run work can start its crewmate's programs, without a separate named-feature wait.
Every admitted home compares a saved-story card's copied risk and required actions with the saved revision, leaving out exact repeats and refusing differences; this also needs no named-feature wait.
Views read the optional first-mate folding state, GitLab queue credential status and shipped queue pauses and answers.
Every view on this major reads frames sent in parts and the integration approval's task-wide Allow choice.
Older read-only views still receive those two additions only when they list their historical names; otherwise the home sends whole frames and omits task-wide Allow.
Every desktop view on this major reads an ended card's optional `ended` field; an older desktop receives it only when it names `ended-cards`, and a phone receives it regardless.
An ended card remains in the stack with no actions and one Close until the captain closes it; other core readers still see the card as closed.
Custom API address refusals may include DNS `answers` and `exceptionOffered`, and a connection's input and view may carry its canonical `addressException`.
Appearance may carry `keepCardsMaximized` and `cardsMaximized`; missing fields keep the switch off and the default card size.
A task's delivery may carry `reviewCovers` when the home knows whether a passed review covers the offered version; an older home leaves it out.
The closed host-operation set includes `backlog-task`, which parks a started task with its work kept.
The `inf:task:run` request reads a null review as absent, preserving a panel's following argument across the connection.

An admitted computer can send check_change's `declaration` verdict `answered` through `inf:work:check-change` without a named-feature wait; the home owns whether the queue failure at that exact version can be answered and requeued once.
A computer's forges may advertise `githubCli` and a sign-in row's `way: cli`; the home offers that computer's GitHub CLI sign-in only when `githubCli` is true.
The `inf:devices:forge-sign-in-cli` request asks the computer through `inf:sign-ins:forge-cli` with a host, and the answer carries only whether it kept the sign-in, never a token.
An older computer that sends no `githubCli` is still offered the code alone and is never sent that order.

This major also absorbs `card-allows`, `cost-limit`, `record-close-done`, `report-captain-words` and `task-browser-private-sites`.
A placed card may carry `allows`, naming the ordinary action whose captain-owned click the home keeps as consent and what that consent covers; merely carrying the field grants nothing.
A report may name `captainWordsFrom`, a card on its task or `crewmate-tab`, so the home reads the captain's words from their owner rather than treating the report's text as those words.
Settings can read and set the app's cost limit through `inf:settings:cost-limit:get` and `inf:settings:cost-limit:set`; the host operations `allow-cost`, `lift-cost-limit` and `stop-at-cost` answer the task's own limit card.
The task record may ask `inf:task:close-done` to close started work on the captain's word, and its optional closing `facts` and `onWord` fields describe that close.
A task browser reads the captain's private sites through `inf:work:private-sites`, and the home sends changes through `inf:task-browser:private-sites`.
Settings reads, adds and removes those sites through `inf:browser:private-sites`, `inf:browser:private-sites:add` and `inf:browser:private-sites:remove`; an open effect may name `privateSite` for Settings to add on arrival.
Every computer admitted to work on this major includes these additions without a separate named wait; the site list still grants only the browser reach its owner permits, never a Secrets use.
An older view ignores the optional closing and private-site fields, and an older home refuses the unknown close request without writing anything.

This major also absorbs `after-merge-work-counts`, `card-decline` and `cost-limit-surfaces`.
After-merge task and dependency lists accept any item count within the whole-story size guard; an older strict view may still refuse larger lists.
An optional card action `declines` marks the choice that says no to every other choice; the core supplies an ordinary Decline button on an eligible decision that has none, never on a merge card.
The task record's `dismiss-question` operation presses that choice rather than dropping the question, and an older view draws it as an ordinary button.
Project settings and views carry an optional `costLimit`, and task detail may carry family spend, unpriced responses, the effective limit and its source as `cost`.
An absent cost reading remains unknown, never a measured zero, and none of these additions grants a Secrets use.
