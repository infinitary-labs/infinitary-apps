# Runbooks

A runbook is a folder of guidance, not a program runtime and not a skill.
Its `runbook.json` may name a first-mate section, a crew section, a skills folder and HTML parts or pictures.
A section is plain text, either a Markdown file or a JSON string; JSON strings let the bundled defaults share one source with both the app build and plain-Node consumers.
Skills inside it use the Agent Skills format and are read on demand.
The host does not decide which subject an ask belongs to.

## Serving and switches

`Runbooks` in `src/core/runbooks/runbooks.ts` reads the app bundle's `resources/runbooks` root through the existing self-source location.
`SettingsStore` owns the saved on/off map; absent entries are on, so an update's new built-ins start on.
Settings → Intelligence lists each runbook by its manifest's name and description, with a keyboard-operable switch and save feedback.
The first mate reads the same list and changes it through `app_state` and `app_change runbook`, an asked catalog action.
The dispatcher owns the attributed feed line, named from the manifest rather than an internal identifier, and does not report unchanged writes as changes.
The manifest may declare a replacement; enabling it turns the named runbook off in the same saved update.
Adding and editing runbooks are separate work, not installer or editing surfaces shipped here.

Enabled first-mate sections go through the appended-instructions door at each idle boundary, with `instructions_sha` over the exact joined text.
Runbooks are outside the first mate's hard fixed-context budget; the model's physical context window still applies.
A switch affects the first mate's next idle boundary and newly opened crew conversations, not a prompt already running.
No procedure is refused for exceeding the core budget.

## Typed crew reach

A crew section's manifest selectors match only the kind, project or personal place, delivery, care, backend and project id already known at dispatch.
Each supplied selector must match; an omitted selector is unrestricted, and an empty selector matches nothing.
The kinds selected by the testing runbook are data: plan, reproduce, implement, fix and chore on a project.
Research, retrieval, review, teach and the personal workspace receive none of that section.
A runbook's optional projects list restricts its crew reach by project id.
Its skills remain available on demand throughout that reach, independently of the narrower crew-section selectors.

The first mate declares the kind on spawn or create, and the task records `firstmate:declared` as its source.
A declaration uses the existing answer/change kind branches from INF-1441; the read-only fact still decides what the task delivers.
Undeclared work keeps the classifier path and its existing deliverable restriction.
The host no longer compares a relayed plan line's text to decide its kind.

The crew section enters the prompt through the crew preset and the existing prompt builder.
Project skills win a name, then opted-in personal skills, then runbook skills.
Plain skill files travel in the work session specification, so a work computer stages its own files instead of receiving an unusable path on the home computer.
A work computer must confirm the named runbooks contract change before opening a task carrying these skills.
Pi lists them through its existing resource loader, and Claude stages them through its existing explicit local-skill plugin door with settings sources off.
HTML parts stay beside their skill and can be read through the same file access.
No panel is installed just because a runbook holds panel source or parts; panels keep their own installation and consent door.

## Built-ins

Common workflows is the single switch for planning, features, bugfixes, refactors and explanations.
Its retrieval line follows INF-1441: a fact or how/why answer from what the app can read now is retrieval; comparing past runs, a reproduction, a measurement or the web is research.
Programs has its own switch, so turning Common workflows off does not remove the programs guidance.
Casual projects holds the small-project setup guidance.
Lessons holds its first-mate section and the lesson skill with its tested parts; removing the teach lifecycle special cases is a separate piece.
Testing rules supplies only its selected crew sections.
Commit and PR naming supplies guidance and the data convention read by the existing commit-range, story-title and forge title checks.
Turning naming off drops that check's convention, but a project's own instructions and release tooling are unchanged.

Runbook guidance may decide author choices on the cards it describes, such as voice, length, layout, opening and button names.
The fixed card shape, merge authorization, consent, delivery and care facts remain core.
The delivery-judgment runbook waits for the separate check-facts piece.
The panel-building runbook was not selected, so those skills and the design skill stay workspace-owned.

## Checks

`src/core/runbooks/runbooks.test.ts` drives real bundle manifests, persisted switches, typed reach, naming and staged skill parts.
`tests/e2e/runbooks.spec.ts` switches Common workflows by keyboard, relaunches, and asks the first mate to turn it back on through the shared catalog.
The fixed-context test measures the core separately from runbook guidance.
The existing lesson and workflow journeys cover the guidance's consumers, and the replay gate measures the built-in first-mate guidance.
