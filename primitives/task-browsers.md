# Task browsers

A task browser is one task's own isolated web browser, driven by its crewmate and watched, taken over and handed back by the captain, for researching, demonstrating and preparing website actions within that task.

## Intended use

Use a task's browser when a crewmate must see or use a real web page: research on a public website, play-testing a page a project serves, filling a form, comparing fares, or preparing a purchase up to its last step.
The design is the captain's (rev-10 in [`../docs/architecture.md`](../docs/architecture.md) §14, the isolated page in §4).
The browser belongs to one task, runs on the computer the task runs on, starts with nothing signed in, and stops when its task closes.
Which sites a task needs is the crewmate's judgment from its instructions; the host checks only typed rules, never what a site is for.

## When to use it, and when not

Use it for anything a person would do on a website's own pages.
Do not build a feature-specific scraper, headless browser, cookie jar or booking runner beside it: a booking, a sign-up or a game's play-test is the crewmate's knowledge composed on this primitive, and there is no booking runner and no card kind for one.
Do not use it to reach a service that has an API the person has connected: that is an [Integration](integrations.md), with declared actions and approval.
Do not use it as the person's own browser: it never reads the person's Safari or Chrome profile or the app's subscription sign-ins.
Do not add a second store of website sign-ins: each computer's signed-in sites live in its one kept browser profile, listed by one owner, reached only through `TaskBrowsers`.

## Owner and entry points

- Owner: `TaskBrowsers` ([`../src/core/browser/taskBrowsers.ts`](../src/core/browser/taskBrowsers.ts)), the one owner of every task browser and every word a crewmate reads from one.
  It composes its parts over one typed core ([`../src/core/browser/browserRecord.ts`](../src/core/browser/browserRecord.ts)): the crewmate's commands, the input actions, signed-in sites, each browser's notices, its evidence files, a site's asks and whether anything answers at a page's loopback address ([`../docs/task-browser.md`](../docs/task-browser.md), "What a crewmate has").
- One writer each: `WebSignIns` over `userData/web-sign-ins/` ([`../src/core/browser/webSignIns.ts`](../src/core/browser/webSignIns.ts)), reached only through `TaskBrowsers` ([`../docs/task-browser.md`](../docs/task-browser.md), "Signed-in sites").
- Where a page may go: `decideRequest` ([`../src/core/browser/destinations.ts`](../src/core/browser/destinations.ts)) and the connection guard `startConnectionGuard` ([`../src/core/browser/connectionGuard.ts`](../src/core/browser/connectionGuard.ts)), with `isPublicAddress` ([`../src/core/browser/addresses.ts`](../src/core/browser/addresses.ts)).
- The page itself: the host's effects only ([`../src/main/host/taskBrowser.ts`](../src/main/host/taskBrowser.ts), behind `HostTaskBrowser` in [`../src/core/host.ts`](../src/core/host.ts)); the core keeps every decision.
- Shared facts and words: [`../src/shared/taskBrowser.ts`](../src/shared/taskBrowser.ts) (the browser fact schema, `UNKNOWN_OUTCOME_WORDS`).
- Crewmate: the `infinitary-browser-axi` command and one instruction line, granted where the browser binds (`CrewToolHooks.taskCommandHooks`, [`../src/core/orchestrator/crewToolHooks.ts`](../src/core/orchestrator/crewToolHooks.ts)); `emit_card`'s `browser_button`, `browser_page` and `browser_handoff`.
- Captain: the task card's Browser tab ([`../src/renderer/src/cards/TaskBrowserView.tsx`](../src/renderer/src/cards/TaskBrowserView.tsx)) and Signed-in sites in Settings -> Secrets or Website sign-ins in Settings -> General where the Secrets tab is not offered ([`../src/renderer/src/settings/WebsiteSignInsSection.tsx`](../src/renderer/src/settings/WebsiteSignInsSection.tsx)).

## Operations and lifecycle

- A crewmate opens a public https website or an address on its computer's loopback; opening a loopback address registers that origin for that task alone.
- It reads the page as an outline (`snapshot`, `wait`), uses it with real input (`click`, `fill`, `press`, `scroll` and the rest), and photographs it into the task's evidence folder (`screenshot`).
- One command runs at a time per task, each answers within 30 seconds, and at most four task browsers run on one computer (`TASK_BROWSERS_MAX`); the next is refused, never made room for.
- A browser holds at most two pages; a page's own popup becomes its second page with the same site data.
- It stops on the crewmate's `stop`, the captain's Stop browser, its task closing, half an hour unused while nobody watches or holds it, a crashed page, or the app quitting; the next open is fresh with nothing signed in.
- The captain watches through pictures of the hidden page, never the page itself (`TaskBrowsers.watch`), on the task card's Browser tab ([`../docs/task-card-tabs.md`](../docs/task-card-tabs.md)).
- The captain's Point at marks a place on a held picture of the page, and `TaskBrowsers.places` reads once what the outline names on screen, by role, name and box, so the note says what the mark is on ([`../docs/task-browser.md`](../docs/task-browser.md), "Pointing at a page"); the read records nothing, and the picture leaves only when the captain sends the note.
- A card may carry one door to the browser (`browser_button`), or to a page from the task's project (`browser_page`, served by `TaskBrowsers.openPage`); a door answers nothing and runs no effect.
- Evidence: a picture lands in the task's evidence folder for a card to show ([`../docs/card-authoring.md`](../docs/card-authoring.md)); the timeline gets a line when a browser opens and when it stops on its own; no raw trace of a page is ever recorded.

## Authority

- Connection guard: every request a page makes is checked before it leaves, and every connection off loopback goes through the browser's own guard, which resolves the name itself, refuses it unless every address is public or the name is on the captain's private sites list, and connects to the address it checked.
- The guard answers only its own browser; a private network or plain http the captain did not list, another server on the computer the crewmate did not open, a file or an app scheme is refused and named in the next answer.
- A page's own top-level move to a server on the computer, such as a sign-in's return to a program, goes through, and then only a page at that server reaches it again, except a live socket in Google Chrome or Edge, which the guard lets through from any page (`decidePageRequest`, [`../docs/task-browser.md`](../docs/task-browser.md), "Where a page may go").
- Captain handoff: only the captain's Take control and Return control move control (`TaskBrowsers.takeControl`, `TaskBrowsers.returnControl`); nothing else does - not a click on the page, a sign-in, a redirect, Hide, a card closing or a timer.
- While the captain holds a browser the crewmate's commands refuse, and nothing the captain does or the page says is recorded or reaches the crewmate.
- A crewmate that needs a person - a sign-in, a code, a payment - asks on an ordinary decision card with `browser_handoff` and one action whose effect is `{ kind: "open", target: "browser" }`; the browser pauses before the card goes up (`TaskBrowsers.requestHelp`).
- Returning control gives the task the signed-in site, never permission to buy, pay or submit anything that matters.
- A browser handed back keeps only what the task needs (`TaskBrowsers.signedIn`): typed text the crewmate did not type reads `(value hidden)`, a picture needs a reason, and addresses lose their query and fragment.
- The final submission is the captain's: a purchase, booking or other commitment is prepared up to its last step and stops there; the review card names what the captain commits to, read from the page now, and the captain makes the step on the page (the answer `submission: captain` on the FI3-835 design).
- If the price or terms change after a review, the crewmate asks again on a new review.
- Signed-in sites: the captain signs in on a crewmate's sign-in request, which opens the computer's kept profile, and picks the site's rule on Return control; a task uses a site only after the captain's click on its own request (`TaskBrowsers.grantSavedSignIn`), or by the site's rule `Use it without asking`, and otherwise opens signed out, in an empty context of its own.
- Nothing copies a sign-in to a file, another browser or another computer; the list holds sites and rules alone.
- The crewmate never learns which sites are listed; only the host adds `Use my <site> sign-in` to a request card (`offeredSignIn`).
- The first mate never changes a site's rule or removes a signed-in site; those, and the view's control requests, are the captain's own, from any window that controls the first mate.

## Compositions

- With [Cards and consent](cards-and-consent.md): doors, help requests and final-submission reviews are ordinary cards; the click is the captain's answer.
- With durable messages: a return or a signed-in site's grant wakes the crewmate once (`browser-returned`, [`../docs/inbox.md`](../docs/inbox.md)); a browser in the captain's hands is the captain's turn to the idle ladder (`browserWithCaptain`, [`../docs/report-sort.md`](../docs/report-sort.md)).
- With [Tasks](tasks.md): the browser's fact is read from task detail, its lines go on the task's timeline, and its life ends with the task.
- With [Projects and working copies](projects-and-working-copies.md): a page from the project is served from the project folder on a loopback address of its own (`serveProjectFolder`, [`../src/core/browser/projectServer.ts`](../src/core/browser/projectServer.ts)).
- From another computer: a task on a computer that runs work has its browser there, owned by that computer's own `TaskBrowsers` with every rule above and reached through its task channel (`ComputerBrowsers`, [`../src/core/helper/browsers.ts`](../src/core/helper/browsers.ts)).
- The captain reads and drives it from the home (`PlacedBrowsers`, `HomeBrowsers`, [`../src/core/placed/placedBrowsers.ts`](../src/core/placed/placedBrowsers.ts)); that computer keeps its own signed-in sites in its own kept profile, and nothing of a sign-in crosses between computers.
- A paired view watches the page as pictures the first mate's computer sends over the connection to it alone, and takes control there as the first mate's own window does; a view of a first mate too old to send them says to update it ([`../docs/view.md`](../docs/view.md), "A task's browser on a view").

## Failure and recovery

- Unknown outcomes: if the page does not confirm a submission - an error, a page still processing, no answer, or a browser that is gone - the outcome is unknown; the crewmate never submits, reloads or resends it, checks where the site lists it, and asks the captain on a card, in the words of `UNKNOWN_OUTCOME_WORDS`.
- The browser never sends a form twice: a page that answers a sent form is never reloaded (`FORM_RESEND`), whoever asks.
- No retry replays a browser commitment: a redelivered wake is words alone, and a restart keeps no browser or form, only a stopped browser's address for Open again (`docs/task-browser.md`, "After a restart").
- A card whose browser is gone still answers on the click, and the crewmate is steered once that its browser was gone (`attachmentStanding`).
- A crash or quit while the captain holds a browser keeps nothing and wakes nobody.
- A site may end or refuse a copied session; the crewmate then asks again, and the card offers only `Sign in myself`.

## Uses

- Research and comparison on public websites, shown to the captain through a card door such as `View search`.
- A finished web project's play-test in its own browser and a note whose `Play` door opens the project's page.
- Sign-ins on a site through the captain's handoff, and signed-in sites reused by later tasks with one click or by their rule.
- A booking prepared to its review and paid by the captain on the page (`tests/e2e/task-browser-booking.spec.ts`).
- Possible: any feature that needs a website's own page, composed as crewmate instructions on this primitive rather than a host runner.

## Checks

- The `taskBrowsers.*.test.ts` files beside the owner, over one stand-in host ([`../tests/helpers/taskBrowserStandIn.ts`](../tests/helpers/taskBrowserStandIn.ts)): reading and lifecycle ([`reading`](../src/core/browser/taskBrowsers.reading.test.ts)), the captain's view and second pages ([`view`](../src/core/browser/taskBrowsers.view.test.ts)), control, help and form resend ([`handoff`](../src/core/browser/taskBrowsers.handoff.test.ts)), signed-in pages and signed-in sites ([`signIns`](../src/core/browser/taskBrowsers.signIns.test.ts)), input actions, files and downloads ([`actions`](../src/core/browser/taskBrowsers.actions.test.ts)), and what Point at reads of a page ([`places`](../src/core/browser/taskBrowsers.places.test.ts)).
- [`../src/core/browser/connectionGuard.test.ts`](../src/core/browser/connectionGuard.test.ts), [`../src/core/browser/destinations.test.ts`](../src/core/browser/destinations.test.ts), [`../src/core/browser/addresses.test.ts`](../src/core/browser/addresses.test.ts): where a page may go.
- [`../src/core/browser/webSignIns.test.ts`](../src/core/browser/webSignIns.test.ts): the list of signed-in sites: one entry per site with its rule and no cookie or page storage, a copy from before deleted unread, and a failure mark bound to its entry.
- [`../src/core/orchestrator/cardActions.browser.test.ts`](../src/core/orchestrator/cardActions.browser.test.ts), [`../src/core/orchestrator/wakes.test.ts`](../src/core/orchestrator/wakes.test.ts), [`../src/core/pi/cardTool.test.ts`](../src/core/pi/cardTool.test.ts) and [`../src/core/core.boot.test.ts`](../src/core/core.boot.test.ts): requests, wakes, card parameters and the gate.
- Journeys: [`../tests/e2e/task-browser.spec.ts`](../tests/e2e/task-browser.spec.ts), [`../tests/e2e/task-browser-view.spec.ts`](../tests/e2e/task-browser-view.spec.ts), [`../tests/e2e/task-browser-handoff.spec.ts`](../tests/e2e/task-browser-handoff.spec.ts), [`../tests/e2e/task-browser-saved-sign-ins.spec.ts`](../tests/e2e/task-browser-saved-sign-ins.spec.ts), [`../tests/e2e/task-browser-booking.spec.ts`](../tests/e2e/task-browser-booking.spec.ts), [`../tests/e2e/task-browser-sign-ins.spec.ts`](../tests/e2e/task-browser-sign-ins.spec.ts), [`../tests/e2e/task-browser-actions.spec.ts`](../tests/e2e/task-browser-actions.spec.ts) and [`../tests/e2e/task-browser-user-agent.spec.ts`](../tests/e2e/task-browser-user-agent.spec.ts).

## Where the detail lives

- [`../docs/task-browser.md`](../docs/task-browser.md): each task's own browser - what a crewmate drives, where its page may go and its connection guard, a second page, a signed-in page, the view the captain watches, taking and returning control, a final submission, the hidden page ("What a crewmate has", "Where a page may go", "A second page", "A signed-in page", "The view", "From a card", "A page from the project", "Taking control", "Asking for help", "Signed-in sites", "A final submission", "On another computer", "The page itself", "Tests").
- [`../docs/task-card-tabs.md`](../docs/task-card-tabs.md): the task card's Browser tab per page.
- [`../docs/axi-commands.md`](../docs/axi-commands.md), "The browser command": the command, its launcher, the task channel and the command process.
