# Feedback

`/feedback <words>` turns a person's report of a problem or an idea into an issue on Infinitary's own public project, which the person reads whole and publishes with one click.
Nothing is published before that click: the one thing sent earlier is the search for similar issues, whose words pass the same guard.
The issue goes under the person's own GitHub account, or through GitHub's own new-issue page when the app has no GitHub sign-in.
It is not one of the Sharing switches (`docs/sharing.md`): the person writes it, reads it and sends it themselves.

## Where it starts

A message that starts with `/feedback`, in any letter case, reaches the first mate as a feedback request from every message box:

- the main message box (`inf:converse`), on the desktop and the phone alike;
- a card's reply (`inf:cards:reply`): the reply stays in the card's thread, and the first mate, not the card's author, answers it, and the card's author owes it no answer (`replyToCard`, `src/core/orchestrator/cardActions.ts`; `owesNoAnswer`);
- a task's crewmate tab (`inf:task:steer`): the line goes to the first mate with the task's id, never to the crewmate (`src/core/dispatcher.ts`).

The phone's connection runs the same handlers, so a phone's `/feedback` takes the same path.
`isFeedbackRequest` (`src/shared/feedback.ts`) is the one reader.
The first mate's turn carries the words as the captain typed them, with one added note, `FEEDBACK_REQUEST_NOTE` (`src/core/orchestrator/wakes.ts`), that names the request and points at the Feedback runbook.

Two more ways start it:

- Typing `/` as the first word of the main message box shows the slash hint in its foot row: "/feedback: tell Infinitary's makers about a problem or an idea" (`typingSlashCommand`, `src/shared/composer.ts`; `docs/composer.md`, "Growth and reflow").
  Tab is never taken.
- Send Feedback… in the Help menu, and the window command `feedback.start` ("Send feedback"), go home and start `/feedback ` in the main message box with the caret after it (`docs/keyboard.md`).

The first mate also suggests `/feedback` when someone describes a problem with Infinitary itself.

## The Feedback runbook

The built-in Feedback runbook (`resources/runbooks/feedback/`) holds every judgment:

- its first-mate guide starts one feedback task at once, with no card, on this computer and in no project, passing the words verbatim, where they were typed, and the context in the first mate's own words, never a personal detail;
- its `feedback-report` skill is the crewmate's procedure: gather the diagnostics and similar issues, write a title and body a stranger can follow, keep the draft, and ask on one card.

Turning the runbook off stops the first mate from starting feedback tasks; the command stays.

## The command

`infinitary-feedback-axi` (`src/core/axi/feedbackCommands.ts`, `src/core/feedback/`) goes to every task on this computer.

- `diagnostics [--task <key>]` prints the facts a report carries.
- `similar <words>` searches the project's issues, open and closed, through the sign-in or GitHub's public search.
- `draft --kind bug|idea --title <title> --body-file <file> [--comment-on <number>] [--task <key>]` runs the guard, adds the diagnostics block and the hidden mark `<!-- infinitary-feedback v1 kind=… version=… -->`, and keeps the draft.

With a GitHub sign-in the draft is a kept write (`GithubGatewayService.keepFeedback`) to `POST /repos/<project>/issues`, or to an issue's comments with `--comment-on`, sent only by the captain's click on the crewmate's card.
It is always kept, even for a task in Infinitary's own project (`docs/forge.md`, "A write that asks").
Without a sign-in the draft answers a link to GitHub's new-issue page with the title and body filled in, at most 8,000 characters: the task's steps are shortened first, then the words are cut with a line saying so (`newIssueLink`).
The destination is the build's own release project (`releaseSource.repository`), never one a crewmate names.

## What a report holds

The crewmate's words, then a folded block of typed facts (`FeedbackDiagnostics`, `src/core/feedback/diagnostics.ts`):

- the app's version, update channel, kind of installation and language;
- this computer's system, its version as the system names it (the kernel's, marked as such, where that is all that is known) and chip;
- the other computers by system and app version, the phones by app version;
- model connections by provider kind, and project hosts by kind;
- with `--task`, that task's kind, state, how it closed, care and delivery, its pull request's check summary and each check's state (never a check's name, which can name the project), and its steps as minute and kind; the earliest go first when the issue would pass GitHub's 65,536 characters, or the link its 8,000.

Each fact is a short code word or version; anything else prints as "unknown", so no name, path or words can ride the block.

## The guard

Before anything is kept, the host refuses a title or body that holds an identifier it knows about the person (`src/core/feedback/guard.ts`): the account name, the home folder, the computer and device names, every sign-in, each project's name, folder and repository, secret names and connection names.
It refuses closed patterns too: an email address, a home-folder path, a network address and a key in a known format.
It compares curly and straight apostrophes and quotes as the same, and holds a computer's network name (name.local) bare as well.
The words `similar` searches with pass the same guard, since that search reaches GitHub before the click.
It names each match and its kind, and the crewmate rewrites the sentence: the guard refuses rather than replaces, so what the captain reads is exactly what goes.
It finds only what it holds and what the patterns name; anything else rests on the crewmate and the captain's review.

## The review card

The crewmate's card shows the kept write as its strip (`feedbackAskStrip`, `src/core/orchestrator/requestStrips.ts`): "Your click publishes this on GitHub, publicly, once", whether it is a new problem report, a new idea or a comment on an issue, the title and the body as readable text, the call, and the GitHub account it goes under.
A close open match makes the draft a comment on it, and the card offers "Send as a new issue instead".
Without a sign-in the card shows the link with "I published it" and "Not now".
A revision keeps a new write; an earlier one stays unsent and drops when the task closes.

## Triage

`.github/workflows/feedback-labels.yml` labels a new issue whose body carries the mark "from-app" and its kind, "bug" or "idea".
It reads only the issue's body from the event, checks out nothing and holds only a token that may label issues.
Anyone can type the mark, so the labels sort issues and grant nothing.

## Tests

- Unit: `src/shared/feedback.test.ts` (the request reader), `src/core/feedback/*.test.ts` (the guard per identifier kind, the search guarded, the link's limit, the draft kept or linked, the facts the home reads), `src/core/orchestrator/requestStrips.test.ts` (the strip), `src/core/orchestrator/feedbackReply.test.ts` (a reply under a crewmate's card).
- Integration: `src/core/core.feedback.test.ts` (the main message box and a phone's crewmate tab reach the first mate over the real connection).
- Journey: `tests/e2e/feedback.spec.ts` (nothing reaches the GitHub stand-in before the click; exactly the shown text after).
