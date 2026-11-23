---
name: feedback-report
description: Draft a /feedback report as an issue for Infinitary's makers, with the app's diagnostics and no personal details, and publish it only on the captain's click. Read only when your task is a feedback report.
---

# A feedback report

Your task turns the captain's `/feedback` words into one issue, or one comment on a matching issue, on Infinitary's own public project.
Nothing is published before the captain presses the button on your card, and the issue goes under their own GitHub account.
Your shell's `infinitary-feedback-axi` reads diagnostics, looks for similar issues and keeps the draft; it knows which project, so never name one or send it another way.

## Gather

1. Read your brief for the captain's words and where they typed them.
   When it names a task or card, read that task's record with `tasks` for what happened: the kinds of steps, failures and check states.
2. Run `infinitary-feedback-axi diagnostics`, adding `--task <key>` for the task the report is about, to see the facts the draft will carry.
3. Run `infinitary-feedback-axi similar <a few words>` with words describing the problem, never the captain's project names.
   A close match that is still open makes your draft a comment on it.

## Write

Write in English, in your own words, as a stranger would need to read it.
Use a short title, at most 80 characters.
For a problem, say what happened, what the captain expected, and the steps that lead to it; for an idea, say the problem it solves and what would help.
Leave out every personal detail: names, emails, logins and accounts, computer and phone names, folders and file paths, project, repository, task and card names, card text, quotes of conversations or code, keys and secrets, and network addresses.
Say what kind of thing it was instead: a GitHub project, a Mac, a crewmate's merge card.
Never paste the diagnostics yourself: the draft adds them and a hidden mark.

Put the body in a Markdown file in your temporary folder, then run:

`infinitary-feedback-axi draft --kind bug|idea --title "<title>" --body-file <file> [--comment-on <issue number>]`

A refusal names each personal detail it found and its kind: rewrite those sentences and draft again.
Without the captain's words to go on, write a one-line draft that says so and ask on the card what went wrong.

## Ask

The draft answers one of two ways.

- With a GitHub sign-in, it keeps the issue as a write and names its ask.
  Emit a card titled "Send this feedback to Infinitary's makers?" whose body says in one sentence whether a similar issue is open, naming it, and that a reply changes any word.
  Give it one action whose effect is `{"kind":"request_write","ask":"<ask>"}`, the default, beside your own Not now; the app draws the exact title and body and names the button.
  For a comment on a matching issue, add an action "Send as a new issue instead"; on that choice, draft again without `--comment-on` and revise the same card.
- Without one, it gives a filled-in link to the project's new-issue page.
  Emit the same card with the link as "Open the filled-in issue on GitHub" and the exact title and body in the body, with the actions "I published it", the default, and "Not now".

On a reply asking for changes, draft again and revise the same card with the new ask: only the newest draft can be sent.

## Finish

After the captain's click, you hear GitHub's answer once.
Report the issue's or comment's number and link, then finish; the first mate tells the captain.
On Not now, report that nothing was sent and finish.
Never publish, edit or comment on GitHub another way, and never send a draft the captain did not see.
