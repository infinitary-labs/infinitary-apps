/**
 * The words of every wake a crewmate hears, and of a card choice either lane
 * hears, byte for byte (INF-2625's plan, the wakes row;
 * `tests/helpers/wakeWords.ts` says why), except the offered change's wakes in
 * `wakes.words.crewmate.forge.test.ts` and the checks' in
 * `wakes.words.crewmate.checks.test.ts`. The first mate's wakes are in
 * `wakes.words.firstmate.test.ts`.
 */

import { secretsReceipt } from "../../../tests/helpers/secretsReceipt";
import {
  type CrewmateOtherWakeKind,
  WAKE_PICTURE as PICTURE,
  pinWakeWords,
  WAKE_TASK as TASK,
  type WordsCases,
} from "../../../tests/helpers/wakeWords";
import { SECRET_ASK_WORDS, SECRET_BRING_WORDS } from "../secrets/commandWords";

const completedSecret = await secretsReceipt("completed");
const unknownSecret = await secretsReceipt("unknown");

const CASES: WordsCases<CrewmateOtherWakeKind> = {
  "review-handoff": [
    {
      name: "a passed review goes directly to its builder (session audit finding E)",
      wake: {
        facts: {
          kind: "review-handoff",
          from: "Review: repair the saved merge",
          head: "0123456789abcdef0123456789abcdef01234567",
          stage: "ship",
          excerpt: "The approval remains bound to the offered change.",
        },
      },
      words:
        "Host handoff from Review: repair the saved merge at 0123456789abcdef0123456789abcdef01234567: The approval remains bound to the offered change.\nThe review passed. Follow your brief's delivery for the reviewed version, then show its completion card. A local-only change needs no push or pull request. Do not bring it up to date merely because the default branch moved. Passing review grants no merge consent. A finding the review settled without asking the captain - its text, or the reviewer's report, says Settled without asking - is listed on your merge card, in a saved story as checked facts, several in one fact when they would not fit: one line of a few words each for what was found, what was done and why it needed no decision, in words for a stranger, such as a project rule, the approved scope or better on every count, never the whole finding again. If you judge a settled fix wrong, leave it unmade and say why in your report; when that report brings no new commit, or the review has already passed, also name the dispute in needs_firstmate, so it reaches the reviewer or the captain as a question. A reply under your merge card that overturns a settled finding is the captain's decision: make that change.",
    },
    {
      name: "a code pass keeps its reader for proof (F8, replaces the retired first-mate pass)",
      wake: {
        facts: {
          kind: "review-handoff",
          from: "INF-2762",
          head: "4be7c1d90a2f",
          stage: "proof",
          excerpt: "Every pinned word matches; the planned proof has not run.",
        },
      },
      words:
        "Host handoff from INF-2762 at 4be7c1d90a2f: Every pinned word matches; the planned proof has not run.\nThe code passed. Run live proof once after this code review, then report without pushing. The host returns the proof to this reviewer. If this reviewer already read it and found it short, repair the reported gap and rerun only affected proof. If the only missing proof requires a pushed branch, push and finish it beside the checks before the merge card. Resource consent and every captain decision still apply.",
    },
    {
      name: "a new assignment goes to the same reader (F8, replaces the retired first-mate pass)",
      wake: {
        facts: {
          kind: "review-handoff",
          from: "INF-2761",
          head: "4be7c1d90a2f",
          stage: "reread",
          excerpt: "The committed repair is ready.",
        },
      },
      words:
        "Host handoff from INF-2761 at 4be7c1d90a2f: The committed repair is ready.\nRead the builder's changed head, evidence revision or validation state assigned to this turn, and the captain's newest answer on your Review finding card in the history. A code pass already recorded at this head makes this a proof read only. A finding you settled without asking that the builder's report disputes becomes an ask-user finding in your review. Read only the difference after an earlier code pass. The review history carries the captain's latest decisions. Report your typed review; the host delivers it directly to the builder. Escalate only a decision or a handoff you cannot complete.",
    },
    {
      // INF-4338: the captain's choice on the reviewer's own card reaches the
      // builder with no first mate turn.
      name: "the captain's answer on a Review finding card goes to the builder",
      wake: {
        facts: {
          kind: "review-handoff",
          from: "INF-2761",
          head: "4be7c1d90a2f",
          stage: "decision",
          excerpt: 'The captain chose "Keep the copy" on "Keep the Later copy?".',
        },
      },
      words:
        'Host handoff from INF-2761 at 4be7c1d90a2f: The captain chose "Keep the copy" on "Keep the Later copy?".\nThe captain answered your reviewer\'s question; the history carries the answer word for word, and it governs. Make the change it chose, if it chose one, under the review\'s fix rules; commit and report without pushing. The host returns your report to your reviewer, who reads the answer and any new head. Do not ask the first mate to relay it.',
    },
    {
      // INF-4338's review: after the review closed, no reviewer reads the
      // answer, so the builder delivers a chosen change as a new version.
      name: "the captain's answer after the review closed asks the builder to deliver",
      wake: {
        facts: {
          kind: "review-handoff",
          from: "INF-2761",
          head: "4be7c1d90a2f",
          stage: "decided",
          excerpt: 'The captain chose "Change it" on "Keep the Later copy?".',
        },
      },
      words:
        'Host handoff from INF-2761 at 4be7c1d90a2f: The captain chose "Change it" on "Keep the Later copy?".\nThe captain answered your reviewer\'s question after its review closed; the history carries the answer word for word, and it governs. If it chose a change, make it under the review\'s fix rules, commit it, then push and follow your brief\'s delivery for the new version: a new merge card, with a new review as your rigor asks. If it kept the code as built, nothing more is needed. Do not ask the first mate to relay it.',
    },
  ],
  // INF-1109: completion is metadata, never new permission; an unknown effect must not repeat.
  "secrets-use-ended": [
    {
      name: "a completed protected recipient",
      wake: { facts: { kind: "secrets-use-ended", receipt: completedSecret } },
      words: `[fm-op] Secrets request ${completedSecret.request}: completed. The recipient exited with status ${completedSecret.exitCode}. This is a receipt, not permission for another use or an external action.`,
    },
    {
      name: "an unknown protected effect",
      wake: { facts: { kind: "secrets-use-ended", receipt: unknownSecret } },
      words: `[fm-op] Secrets request ${unknownSecret.request}: unknown. This is a receipt, not permission for another use or an external action. Do not repeat this request; reconcile what happened before depending on it.`,
    },
  ],
  "secrets-ask-ended": [
    {
      name: "a kept ask",
      wake: {
        facts: {
          kind: "secrets-ask-ended",
          ended: {
            ask: "stripe-key",
            state: "kept",
            secrets: [{ ref: "s-4f2a", name: "Stripe key", place: "test", version: 1 }],
          },
        },
      },
      words:
        "[fm-op] Your ask to keep a secret stripe-key: kept in Secrets: Stripe key (place test) as reference s-4f2a, version 1. Use a secret by its reference; each use still asks the captain unless a saved decision allows it. You never receive a value.",
    },
    {
      name: "an ask the captain did not keep",
      wake: {
        facts: { kind: "secrets-ask-ended", ended: { ask: "stripe-key", state: "not-kept" } },
      },
      words:
        "[fm-op] Your ask to keep a secret stripe-key: the captain chose not to keep it, and nothing was kept. Do not ask again for the same secret unless the captain says to; say in your answer or report that the work still needs it.",
    },
    {
      name: "a withdrawn ask",
      wake: {
        facts: {
          kind: "secrets-ask-ended",
          ended: { ask: "stripe-key", state: "withdrawn", why: SECRET_ASK_WORDS.cancelled },
        },
      },
      words: `[fm-op] Your ask to keep a secret stripe-key ended with nothing kept: ${SECRET_ASK_WORDS.cancelled}`,
    },
  ],
  "secrets-bring-ended": [
    {
      name: "a bring that kept one and skipped one",
      wake: {
        facts: {
          kind: "secrets-bring-ended",
          ended: {
            bring: "vault",
            state: "kept",
            secrets: [
              {
                name: "Vault token",
                place: "Staging",
                outcome: "kept",
                ref: "vault-token",
                version: 1,
              },
              { name: "DB_PASSWORD", place: "", outcome: "skipped" },
            ],
          },
        },
      },
      words:
        "[fm-op] Your bring of secrets from another tool vault ran. Vault token (place Staging): kept as reference vault-token, version 1; DB_PASSWORD: skipped. The copy in the other tool is unchanged. Report each name kept and skipped. Use a secret by its reference; each use still asks the captain unless a saved decision allows it. You never receive a value.",
    },
    {
      name: "a failed bring, by its exit code alone",
      wake: {
        facts: {
          kind: "secrets-bring-ended",
          ended: { bring: "vault", state: "failed", exitCode: 3, why: SECRET_BRING_WORDS.failed },
        },
      },
      words: `[fm-op] Your bring of secrets from another tool vault failed with exit code 3: ${SECRET_BRING_WORDS.failed} Do not run the tool's command yourself to see why; say in your report what failed.`,
    },
    {
      name: "a bring the captain did not make",
      wake: {
        facts: { kind: "secrets-bring-ended", ended: { bring: "vault", state: "not-brought" } },
      },
      words:
        "[fm-op] Your bring of secrets from another tool vault: the captain chose not to bring them, and nothing was kept. Do not ask again unless the captain says to.",
    },
  ],
  "responses-cancelled": [
    {
      name: "over prose guidance",
      wake: {
        facts: {
          kind: "responses-cancelled",
          requests: ["rq-41", "rq-42"],
          guidance: "Stop the comparison; the captain chose the first option.",
        },
      },
      words:
        "Stop the comparison; the captain chose the first option.\n\nThe first mate cancelled response requests rq-41, rq-42. Their history remains; do not submit new answers for those requests.",
    },
    {
      name: "over typed guidance",
      wake: {
        facts: {
          kind: "responses-cancelled",
          requests: ["rq-43"],
          guidance: { kind: "crewmate-tab-line", words: "Skip the iOS part." },
        },
      },
      words:
        "The captain typed this to you in your task's Crewmate tab, where they read your session as you work.\nTreat it as their direct guidance: do what their words need, and answer through your work and your next report, never with an acknowledgement or a card about having read it.\nPutting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate, so the first mate runs it.\nWhen their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming the Crewmate tab, so the first mate records them as their standing override; carry on with what their words already allow.\nThe captain's words, verbatim:\nSkip the iOS part.\n\nThe first mate cancelled response requests rq-43. Their history remains; do not submit new answers for those requests.",
    },
  ],
  "response-request": [
    {
      name: "over prose guidance",
      wake: {
        facts: {
          kind: "response-request",
          requestId: "rq-41",
          guidance: "Which of the two splits keeps the replay numbers still?",
        },
      },
      words:
        "Which of the two splits keeps the replay numbers still?\n\nResponse requested: rq-41. In report.responses name request_id, a stable response_id, and status answered or not-yet-answered. The report text is your exact response. Submission saves it and queues the first mate immediately, even while work continues. Ordinary reports do not answer this request.",
    },
    {
      name: "over typed guidance",
      wake: {
        facts: {
          kind: "response-request",
          requestId: "rq-44",
          guidance: { kind: "crewmate-tab-line", words: "How long will the journeys take?" },
        },
      },
      words:
        "The captain typed this to you in your task's Crewmate tab, where they read your session as you work.\nTreat it as their direct guidance: do what their words need, and answer through your work and your next report, never with an acknowledgement or a card about having read it.\nPutting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate, so the first mate runs it.\nWhen their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming the Crewmate tab, so the first mate records them as their standing override; carry on with what their words already allow.\nThe captain's words, verbatim:\nHow long will the journeys take?\n\nResponse requested: rq-44. In report.responses name request_id, a stable response_id, and status answered or not-yet-answered. The report text is your exact response. Submission saves it and queues the first mate immediately, even while work continues. Ordinary reports do not answer this request.",
    },
  ],
  "away-copy-kept": [
    {
      name: "back with unmerged work, the task now on the computer that holds the ref",
      wake: {
        facts: {
          kind: "away-copy-kept",
          computer: "Mac mini",
          folder: "/Users/builder/Library/Application Support/infinitary/work/worktrees/479823ee",
          kept: {
            sha: "9f2c1e4b7a0d3c5e8f1a2b4c6d8e0f1a3b5c7d9e",
            ref: "refs/infinitary/away-copy/479823ee/1795000000000",
          },
          here: true,
        },
      },
      words:
        "Mac mini, which your task moved off while it was out of reach, is back. Its conversation there is closed, so it no longer runs your task. The working copy your task left there stays there, at /Users/builder/Library/Application Support/infinitary/work/worktrees/479823ee. What it held that never merged - its later commits and its uncommitted edits, saved as one commit 9f2c1e4 - is in your project's repository at refs/infinitary/away-copy/479823ee/1795000000000. Compare it with your working copy (git diff HEAD refs/infinitary/away-copy/479823ee/1795000000000) and take what your task still needs; nothing of it is applied for you. Keep working without restarting; this notice changes nothing else.",
    },
    {
      name: "back with unmerged work, the task on another computer that cannot reach the ref",
      wake: {
        facts: {
          kind: "away-copy-kept",
          computer: "Mac mini",
          kept: {
            sha: "9f2c1e4b7a0d3c5e8f1a2b4c6d8e0f1a3b5c7d9e",
            ref: "refs/infinitary/away-copy/479823ee/1795000000000",
          },
          here: false,
        },
      },
      words:
        "Mac mini, which your task moved off while it was out of reach, is back. Its conversation there is closed, so it no longer runs your task. The working copy your task left there, if any, stays there. What it held that never merged - its later commits and its uncommitted edits, saved as one commit 9f2c1e4 - is kept at refs/infinitary/away-copy/479823ee/1795000000000 in your project on the computer the first mate lives on, which your working copy cannot reach. If your task still needs it, report that with needs_firstmate, naming the ref. Keep working without restarting; this notice changes nothing else.",
    },
    {
      name: "back holding nothing unmerged",
      wake: {
        facts: { kind: "away-copy-kept", computer: "Mac mini", here: true },
      },
      words:
        "Mac mini, which your task moved off while it was out of reach, is back. Its conversation there is closed, so it no longer runs your task. The working copy your task left there, if any, stays there. It held nothing that never merged beyond what your working copy started from. Keep working without restarting; this notice changes nothing else.",
    },
  ],
  "task-policies-changed": [
    {
      name: "with the guidance the new facts select",
      wake: {
        facts: {
          kind: "task-policies-changed",
          task: { id: TASK.id, key: "INF-2696", title: TASK.title },
          policies: {
            delivery: { value: "direct-pr", source: "project" },
            autonomy: { value: true, source: "task" },
            rigor: { value: "reviewed", source: "task", requested: "reviewed" },
            revision: 2,
          },
          guidance: ["# Careful\nAn independent review reads the committed version."],
        },
      },
      words:
        'Current policies for INF-2696: {"delivery":{"value":"direct-pr","source":"project"},"autonomy":{"value":true,"source":"task"},"rigor":{"value":"reviewed","source":"task","requested":"reviewed"},"revision":2}. These replace earlier delivery/care/merging instructions, not scope. Keep working without restarting; never start queued work from this notice. Before the next push or merge, perform any validation/review the new care requires. Retain published work, the existing pull request, evidence, repair counts and all unrelated holds. A lower care removes only policy-owned requirements. Explicit self-merging permission can release an already-ready result: the first mate rechecks every requirement and uses the existing settle path, without another approval click. It grants no permission past other decisions, explicit withdrawal holds, dependencies, caps or failed checks. Ask-first cancels unsent merges; a merge already sent cannot be stopped. Read the current record before acting.\n\nGuidance the new facts select, which your instructions did not carry:\n\n# Careful\nAn independent review reads the committed version.',
    },
    {
      name: "with no key and no guidance",
      wake: {
        facts: {
          kind: "task-policies-changed",
          task: { id: TASK.id, key: "", title: TASK.title },
          policies: {
            delivery: { value: "direct-pr", source: "project" },
            autonomy: { value: false, source: "project" },
            rigor: { value: "standard", source: "project", requested: "standard" },
            revision: 1,
          },
        },
      },
      words:
        'Current policies for 479823ee: {"delivery":{"value":"direct-pr","source":"project"},"autonomy":{"value":false,"source":"project"},"rigor":{"value":"standard","source":"project","requested":"standard"},"revision":1}. These replace earlier delivery/care/merging instructions, not scope. Keep working without restarting; never start queued work from this notice. Before the next push or merge, perform any validation/review the new care requires. Retain published work, the existing pull request, evidence, repair counts and all unrelated holds. A lower care removes only policy-owned requirements. Explicit self-merging permission can release an already-ready result: the first mate rechecks every requirement and uses the existing settle path, without another approval click. It grants no permission past other decisions, explicit withdrawal holds, dependencies, caps or failed checks. Ask-first cancels unsent merges; a merge already sent cannot be stopped. Read the current record before acting.',
    },
  ],
  "task-override-changed": [
    {
      name: "standing",
      wake: {
        facts: {
          kind: "task-override-changed",
          task: { id: TASK.id, key: "INF-2696", title: TASK.title },
          override: { words: "merge it once it is green", holds: ["asks-first"], until: "task" },
        },
      },
      words:
        "The captain's standing override on this task, recorded by the first mate: their words pass asking first for the rest of this task: \"merge it once it is green\". Where their words reach a consent ask of your own, such as their plan's allowance, they are that consent and you do not ask again; for a check that declares what it uses or a validation effect these words cover, name standing as the request's allowance. An effect still needs exact independent clearance. Keychain or signing access, writes outside the project and browser handoffs still ask. Only their words take it back.",
    },
    {
      name: "taken back",
      wake: {
        facts: {
          kind: "task-override-changed",
          task: { id: TASK.id, key: "INF-2696", title: TASK.title },
          override: { words: "merge it once it is green", holds: ["asks-first"], until: "version" },
          withdrawn: true,
        },
      },
      words:
        "The captain took back their standing override on this task: asking first hold again, and their earlier words no longer stand in for your consent asks.",
    },
  ],
  // INF-3170 piece 2: the captain's yes on a crewmate's card, served as one list.
  "task-allowed-changed": [
    {
      name: "a yes beside the override, one carried from the attempt it retries",
      wake: {
        facts: {
          kind: "task-allowed-changed",
          task: { id: TASK.id, key: "INF-2696", title: TASK.title },
          allowed: {
            override: { words: "merge it once it is green", holds: ["asks-first"], until: "task" },
            allowances: [
              {
                words: 'Use my account, on the card "Run the sign-in check on your account"',
                covers: "Signing in with the captain's own account for the sign-in check",
                card: "card-1",
                at: 1,
                from: { key: "INF-2695", title: "Fix the sign-in check" },
              },
            ],
          },
        },
      },
      words: [
        "Already allowed, as the app recorded it from the captain's own words and clicks on this task:",
        "- The captain's standing override on this task, recorded by the first mate: their words pass asking first for the rest of this task: \"merge it once it is green\". Where their words reach a consent ask of your own, such as their plan's allowance, they are that consent and you do not ask again; for a check that declares what it uses or a validation effect these words cover, name standing as the request's allowance. An effect still needs exact independent clearance. Keychain or signing access, writes outside the project and browser handoffs still ask. Only their words take it back.",
        '- The captain\'s yes on INF-2695 "Fix the sign-in check", whose work this is (card-1): "Use my account, on the card "Run the sign-in check on your account"". What it covers, as its card said it: "Signing in with the captain\'s own account for the sign-in check".',
        "Where an ask of yours falls inside an entry, it is that consent: do not ask again. A write kept for their click, a browser handoff and anything no entry names still ask. Only the captain's words take an entry back.",
      ].join("\n"),
    },
    {
      name: "the last yes taken back",
      wake: {
        facts: {
          kind: "task-allowed-changed",
          task: { id: TASK.id, key: "INF-2696", title: TASK.title },
          allowed: { allowances: [] },
          takenBack: {
            words: "Yes, use it",
            covers: "The captain's plan's allowance for the load test",
          },
        },
      },
      words:
        'The captain took back their yes "Yes, use it", which covered "The captain\'s plan\'s allowance for the load test": ask again before anything it covered.\n\nNothing is recorded as already allowed on this task now.',
    },
  ],
  "idle-nudge": [
    {
      name: "plain",
      wake: { facts: { kind: "idle-nudge", thread: false } },
      words:
        "You stopped with nothing running and nothing up for the captain to decide. Either finish - report under the five headings and emit your merge card - or say what blocks you.",
    },
    {
      name: "a thread naming its cards",
      wake: {
        facts: {
          kind: "idle-nudge",
          thread: true,
          waiting: [
            { id: "card-a", title: "Guardrails ready" },
            { id: "card-b", title: "Split plan" },
          ],
        },
      },
      words:
        'The captain wrote under your cards "Guardrails ready" (card-a) and "Split plan" (card-b) and you have not answered: answer in each card\'s thread with reply, naming its card_id, or pass your answer as the reply of its emit_card revision under the same id, naming their message in answers_message.',
    },
    {
      name: "a thread naming none",
      wake: { facts: { kind: "idle-nudge", thread: true } },
      words:
        "The captain wrote under your card and you have not answered: answer in the thread with reply, or pass your answer as the reply of your emit_card revision, naming their message in answers_message.",
    },
    {
      name: "a thread outranking a note and a step",
      wake: {
        facts: {
          kind: "idle-nudge",
          thread: true,
          note: { id: "card-n", title: "Coverage measured" },
          step: true,
        },
      },
      words:
        "The captain wrote under your card and you have not answered: answer in the thread with reply, or pass your answer as the reply of your emit_card revision, naming their message in answers_message.",
    },
    {
      name: "a note up on a step",
      wake: {
        facts: {
          kind: "idle-nudge",
          thread: false,
          note: { id: "card-n", title: "Coverage measured" },
          step: true,
        },
      },
      words:
        'You stopped with nothing running, and the note "Coverage measured" (card-n) is up, asking the captain nothing. This task is a step whose answer the next step builds on: your report is that answer, and it takes no merge card - a card is only for something the captain must decide or see before the next step can start. If that note is your outcome and only the captain can act next, report with waiting_on_captain naming it; do not post it again. Otherwise either report the whole answer, if your report does not carry it yet, or say what blocks you. If it already does, nothing is left for you: say so in one line, and the first mate decides the next step.',
    },
    {
      name: "a note up on an answer task",
      wake: {
        facts: {
          kind: "idle-nudge",
          thread: false,
          note: { id: "card-n", title: "Coverage measured" },
          answer: true,
        },
      },
      words:
        'You stopped with nothing running, and the note "Coverage measured" (card-n) is up, asking the captain nothing. This task\'s deliverable is an answer, shown on your card marked answering; it takes no merge card. If that note is your outcome and only the captain can act next, report with waiting_on_captain naming it; do not post it again. Otherwise, when nothing is left for you, report with finished true - saying so in words does not close the task - or say what blocks you.',
    },
    {
      name: "a note up on ordinary work",
      wake: {
        facts: {
          kind: "idle-nudge",
          thread: false,
          note: { id: "card-n", title: "Coverage measured" },
        },
      },
      words:
        'You stopped with nothing running, and the note "Coverage measured" (card-n) is up, asking the captain nothing. If that note is your outcome and only the captain can act next, report with waiting_on_captain naming it; do not post it again. Otherwise either finish - report under the five headings and emit your merge card - or say what blocks you.',
    },
    {
      name: "a step",
      wake: { facts: { kind: "idle-nudge", thread: false, step: true } },
      words:
        "You stopped with nothing running and nothing up for the captain to decide. This task is a step whose answer the next step builds on: your report is that answer, and it takes no merge card - a card is only for something the captain must decide or see before the next step can start. Either report the whole answer, if your report does not carry it yet, or say what blocks you. If it already does, nothing is left for you: say so in one line, and the first mate decides the next step.",
    },
    {
      name: "an answer task",
      wake: { facts: { kind: "idle-nudge", thread: false, answer: true } },
      words:
        "You stopped with nothing running and nothing up for the captain to decide. This task's deliverable is an answer, shown on your card marked answering; it takes no merge card. Either post that card, or when nothing is left for you, report with finished true - saying so in words does not close the task - or say what blocks you.",
    },
  ],
  "card-choice": [
    {
      name: "the captain's choice to the first mate, with a value and answers",
      wake: {
        facts: {
          kind: "card-choice",
          to: "firstmate",
          card: { title: "Restructure 39 files", id: "card-plan", taskId: "bc46286c" },
          source: "chrome",
          choice: {
            id: "approve",
            label: "Approve and build",
            value: '{"lanes":2}',
            answers: [
              {
                name: "direction",
                values: ["owners"],
                labels: ["Split along owners and delete as it goes"],
                changed: true,
              },
            ],
          },
        },
      },
      words:
        '[user]\nApprove and build\nChoice on card "Restructure 39 files" (card-plan) on task bc46286c.\nCard action value (JSON): {"lanes":2}\nThe user\'s answers to the card\'s questions:\n- direction: "Split along owners and delete as it goes" (owners), changed',
    },
    {
      name: "a script's choice to the first mate",
      wake: {
        facts: {
          kind: "card-choice",
          to: "firstmate",
          card: { title: "Restructure 39 files" },
          source: "frame",
          choice: {
            id: "approve",
            label: "Approve and build",
            answers: [{ name: "scope", values: ["all"], changed: false }],
          },
        },
      },
      words:
        '[fm-op] a script chose "Approve and build" (approve) on card "Restructure 39 files".\nThe script submitted answers to the card\'s questions:\n- scope: "all", as proposed',
    },
    {
      name: "the captain's choice to a crewmate",
      wake: {
        facts: {
          kind: "card-choice",
          to: "crewmate",
          card: { title: "Guardrails ready", id: "card-a" },
          choice: { id: "keep", label: "Keep going" },
        },
      },
      words: 'Card "Guardrails ready": the user chose "Keep going" (keep).',
    },
    {
      name: "a script's choice to a crewmate",
      wake: {
        facts: {
          kind: "card-choice",
          to: "crewmate",
          card: { title: "Guardrails ready", id: "card-a" },
          source: "frame",
          choice: { id: "keep", label: "Keep going", value: '"fast"' },
        },
      },
      words:
        'Card "Guardrails ready": a script chose "Keep going" (keep).\nCard action value (JSON): "fast"',
    },
    {
      name: "an open-browser choice whose browser had stopped",
      wake: {
        facts: {
          kind: "card-choice",
          to: "crewmate",
          card: { title: "Sign in to the store", id: "card-b" },
          choice: { id: "open", label: "Open browser and sign in" },
          browserGone: "stopped",
        },
      },
      words:
        'The captain chose to open your browser from your card "Sign in to the store", but the browser that card named had stopped, so the captain got no page and nothing the card asked for was done there. Nothing from that browser was kept, and any browser you have now is a newer one. If you still need the captain on the page, open the site again with `infinitary-browser-axi open <url>` and ask again on a new card with browser_handoff. If the card was about something whose outcome is unknown, such as a payment the site never confirmed, it still is: never submit, reload or resend it, and check where the site lists it, such as its bookings, before you ask. Until the seller or its payment service shows the result, say plainly you do not know whether it went through: a missing booking or charge proves nothing, so never guess either way or suggest trying again.',
    },
    {
      name: "an open-browser choice whose browser ended at quit",
      wake: {
        facts: {
          kind: "card-choice",
          to: "crewmate",
          card: { title: "Sign in to the store", id: "card-b" },
          source: "frame",
          choice: {
            id: "open",
            label: "Open browser and sign in",
            answers: [{ name: "site", values: ["store"], changed: false }],
          },
          browserGone: "quit",
        },
      },
      words:
        'The captain chose to open your browser from your card "Sign in to the store", but the browser that card named stopped when Infinitary quit, so the captain got no page and nothing the card asked for was done there. Nothing from that browser was kept, and any browser you have now is a newer one. If you still need the captain on the page, open the site again with `infinitary-browser-axi open <url>` and ask again on a new card with browser_handoff. If the card was about something whose outcome is unknown, such as a payment the site never confirmed, it still is: never submit, reload or resend it, and check where the site lists it, such as its bookings, before you ask. Until the seller or its payment service shows the result, say plainly you do not know whether it went through: a missing booking or charge proves nothing, so never guess either way or suggest trying again.\nThe script submitted answers to the card\'s questions:\n- site: "store", as proposed',
    },
  ],
  "card-closed": [
    {
      name: "as a duplicate",
      wake: {
        facts: {
          kind: "card-closed",
          card: { id: "card-b", title: "Guardrails ready" },
          duplicateOf: { id: "card-a", title: "Guardrails are ready" },
        },
      },
      words:
        'The captain closed your card "Guardrails ready" (card-b) as a duplicate of "Guardrails are ready" (card-a), without choosing.',
    },
    {
      name: "a note's Got it",
      wake: {
        facts: {
          kind: "card-closed",
          card: { id: "card-n", title: "Coverage measured" },
          read: true,
        },
      },
      words:
        'The captain pressed Got it on your note "Coverage measured" (card-n). Got it on an ordinary note acknowledges it, not task completion. After Got it, report finished if nothing remains. Aside is not acknowledgement; a marked saved answer waits for Done.',
    },
    {
      name: "put aside",
      wake: { facts: { kind: "card-closed", card: { id: "card-n", title: "Coverage measured" } } },
      words: 'The captain closed your card "Coverage measured" (card-n) without choosing.',
    },
  ],
  "thread-reply": [
    {
      name: "a reply naming its message, with answers",
      wake: {
        facts: {
          kind: "thread-reply",
          card: { id: "card-a", title: "Guardrails ready", messageId: 412, lifecycle: "lc-3" },
          words: "Also pin the saved rows.",
          answers: [{ name: "scope", values: ["all"], labels: ["Every kind"], changed: true }],
        },
      },
      words:
        "The captain replied in the thread on your card. Do the work their words need first, then answer at once, before unrelated work: always give one short answer in the thread, one to three sentences, whether or not the card changes, with reply(card_id, text) - prose only - and, when their words change what the card should say, also revise it with emit_card under the same id (pass the answer as its reply parameter to do both in one call, saying what you changed and under which heading; every revision while you answer needs its own). Your answer names their message in answers_message, by its number below; until a line does, the card keeps showing them the version they replied under. Then report. Their reply keeps your card on their screen beside its thread, and the thread shows what you are doing as you work; never acknowledge their words or announce a plan: they read your answer. When the work will take more than a few minutes, first post one line with reply and interim true saying what you are doing; it keeps their reply waiting for your answer. On your merge card, when their words change the work, post that one interim line, then answer with the revised card once the checks on the version you pushed pass: the app keeps the card from them until then, and a question the rework raises goes on a card of its own. On your answering card of an answer task, when their words, however put, say they need nothing more from your answer and ask, correct or approve nothing, answer naming answers_message with signs_off true: it closes the card as read and the task as answered, and nothing more is owed. Putting the change in, discarding it, a stronger model, or unrelated work is not yours: close your card with close_card and report the captain's words verbatim with needs_firstmate naming this card's id, so the first mate runs it. When their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming this card's id, so the first mate records them as their standing override; carry on with what their words already allow.\nCard \"Guardrails ready\" (card-a). This is the captain's message 412 in lifecycle lc-3; a line on this card answers it only when it names it in answers_message.\nThe captain's words, verbatim:\nAlso pin the saved rows.\nCurrent settings (context, not permission):\n- scope: \"Every kind\" (all), changed",
    },
    {
      name: "a message with no lifecycle",
      wake: {
        facts: {
          kind: "thread-reply",
          card: { id: "card-a", title: "Guardrails ready", messageId: 413 },
          words: "Thanks.",
        },
      },
      words:
        "The captain replied in the thread on your card. Do the work their words need first, then answer at once, before unrelated work: always give one short answer in the thread, one to three sentences, whether or not the card changes, with reply(card_id, text) - prose only - and, when their words change what the card should say, also revise it with emit_card under the same id (pass the answer as its reply parameter to do both in one call, saying what you changed and under which heading; every revision while you answer needs its own). Your answer names their message in answers_message, by its number below; until a line does, the card keeps showing them the version they replied under. Then report. Their reply keeps your card on their screen beside its thread, and the thread shows what you are doing as you work; never acknowledge their words or announce a plan: they read your answer. When the work will take more than a few minutes, first post one line with reply and interim true saying what you are doing; it keeps their reply waiting for your answer. On your merge card, when their words change the work, post that one interim line, then answer with the revised card once the checks on the version you pushed pass: the app keeps the card from them until then, and a question the rework raises goes on a card of its own. On your answering card of an answer task, when their words, however put, say they need nothing more from your answer and ask, correct or approve nothing, answer naming answers_message with signs_off true: it closes the card as read and the task as answered, and nothing more is owed. Putting the change in, discarding it, a stronger model, or unrelated work is not yours: close your card with close_card and report the captain's words verbatim with needs_firstmate naming this card's id, so the first mate runs it. When their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming this card's id, so the first mate records them as their standing override; carry on with what their words already allow.\nCard \"Guardrails ready\" (card-a). This is the captain's message 413; a line on this card answers it only when it names it in answers_message.\nThe captain's words, verbatim:\nThanks.",
    },
    {
      name: "an older row",
      wake: {
        facts: {
          kind: "thread-reply",
          card: { id: "card-a", title: "Guardrails ready" },
          words: "Go ahead.",
        },
      },
      words:
        "The captain replied in the thread on your card. Do the work their words need first, then answer at once, before unrelated work: always give one short answer in the thread, one to three sentences, whether or not the card changes, with reply(card_id, text) - prose only - and, when their words change what the card should say, also revise it with emit_card under the same id (pass the answer as its reply parameter to do both in one call, saying what you changed and under which heading; every revision while you answer needs its own). Your answer names their message in answers_message, by its number below; until a line does, the card keeps showing them the version they replied under. Then report. Their reply keeps your card on their screen beside its thread, and the thread shows what you are doing as you work; never acknowledge their words or announce a plan: they read your answer. When the work will take more than a few minutes, first post one line with reply and interim true saying what you are doing; it keeps their reply waiting for your answer. On your merge card, when their words change the work, post that one interim line, then answer with the revised card once the checks on the version you pushed pass: the app keeps the card from them until then, and a question the rework raises goes on a card of its own. On your answering card of an answer task, when their words, however put, say they need nothing more from your answer and ask, correct or approve nothing, answer naming answers_message with signs_off true: it closes the card as read and the task as answered, and nothing more is owed. Putting the change in, discarding it, a stronger model, or unrelated work is not yours: close your card with close_card and report the captain's words verbatim with needs_firstmate naming this card's id, so the first mate runs it. When their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming this card's id, so the first mate records them as their standing override; carry on with what their words already allow.\nCard \"Guardrails ready\" (card-a).\nThe captain's words, verbatim:\nGo ahead.",
    },
    {
      name: "while the captain holds the card's browser",
      wake: {
        facts: {
          kind: "thread-reply",
          card: { id: "card-a", title: "Sign in to store.example.com", messageId: 414 },
          words: "Which email should I use?",
          browserHeld: true,
        },
      },
      words:
        "The captain replied in the thread on your card. Do the work their words need first, then answer at once, before unrelated work: always give one short answer in the thread, one to three sentences, whether or not the card changes, with reply(card_id, text) - prose only - and, when their words change what the card should say, also revise it with emit_card under the same id (pass the answer as its reply parameter to do both in one call, saying what you changed and under which heading; every revision while you answer needs its own). Your answer names their message in answers_message, by its number below; until a line does, the card keeps showing them the version they replied under. Then report. Their reply keeps your card on their screen beside its thread, and the thread shows what you are doing as you work; never acknowledge their words or announce a plan: they read your answer. When the work will take more than a few minutes, first post one line with reply and interim true saying what you are doing; it keeps their reply waiting for your answer. On your merge card, when their words change the work, post that one interim line, then answer with the revised card once the checks on the version you pushed pass: the app keeps the card from them until then, and a question the rework raises goes on a card of its own. On your answering card of an answer task, when their words, however put, say they need nothing more from your answer and ask, correct or approve nothing, answer naming answers_message with signs_off true: it closes the card as read and the task as answered, and nothing more is owed. Putting the change in, discarding it, a stronger model, or unrelated work is not yours: close your card with close_card and report the captain's words verbatim with needs_firstmate naming this card's id, so the first mate runs it. When their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming this card's id, so the first mate records them as their standing override; carry on with what their words already allow.\nThe captain has control of your browser and wrote this from beside its page, where your card stays docked. You cannot see the page or use the browser until they return control: answer from what you know, and revise the card under the same id when the steps or values on it should change.\nCard \"Sign in to store.example.com\" (card-a). This is the captain's message 414; a line on this card answers it only when it names it in answers_message.\nThe captain's words, verbatim:\nWhich email should I use?",
    },
  ],
  "crewmate-tab-line": [
    {
      name: "its one wording",
      wake: { facts: { kind: "crewmate-tab-line", words: "Skip the iOS part." } },
      words:
        "The captain typed this to you in your task's Crewmate tab, where they read your session as you work.\nTreat it as their direct guidance: do what their words need, and answer through your work and your next report, never with an acknowledgement or a card about having read it.\nPutting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate, so the first mate runs it.\nWhen their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming the Crewmate tab, so the first mate records them as their standing override; carry on with what their words already allow.\nThe captain's words, verbatim:\nSkip the iOS part.",
    },
  ],
  "timed-wait-over": [
    {
      name: "with a reason and a job",
      wake: {
        facts: {
          kind: "timed-wait-over",
          reason: "the journeys run",
          job: { command: "pnpm e2e critical-path", runMs: 1_260_000 },
        },
      },
      words:
        'The time this task was waiting for has come (the journeys run). Your background job is still running after 21m: "pnpm e2e critical-path". Read its output so far: if it is stuck or waiting on something that will not come, stop it and say so; if it is still making progress, report again with check_back for your next look. Carry on from where you stopped.',
    },
    {
      name: "bare",
      wake: { facts: { kind: "timed-wait-over" } },
      words: "The time this task was waiting for has come. Carry on from where you stopped.",
    },
  ],
  "check-back-ask": [
    {
      name: "its one wording",
      wake: {
        facts: {
          kind: "check-back-ask",
          command: "pnpm vitest run",
          runMs: 420_000,
          boundMs: 7_200_000,
        },
      },
      words:
        'Your turn ended while your background job is still running after 7m: "pnpm vitest run". Nothing tells you if it stalls until it ends or runs for 2h. Report again with check_back: how many minutes until you look at it again, and what you wait for. The app wakes you then with the job\'s facts. If you are not waiting on it, say so in that report.',
    },
  ],
  "turn-resumed": [
    {
      name: "after an update on a named computer",
      wake: { facts: { kind: "turn-resumed", stopped: "update", computer: "Builder" } },
      words:
        "Your last turn stopped part way while Infinitary on Builder was updated; it is back now. Carry on where you left off. Before you repeat a step, check what already took effect - your working copy and branch, a push, a pull request, a job or workflow you started, a card you showed - rather than doing it twice.",
    },
    {
      name: "after an update here",
      wake: { facts: { kind: "turn-resumed", stopped: "update" } },
      words:
        "Your last turn stopped part way while Infinitary was updated; it is back now. Carry on where you left off. Before you repeat a step, check what already took effect - your working copy and branch, a push, a pull request, a job or workflow you started, a card you showed - rather than doing it twice.",
    },
    {
      name: "after a quit",
      wake: { facts: { kind: "turn-resumed", stopped: "quit" } },
      words:
        "Your last turn stopped part way when the app closed - a quit or an update; it is open again. Carry on where you left off. Before you repeat a step, check what already took effect - your working copy and branch, a push, a pull request, a job or workflow you started, a card you showed - rather than doing it twice.",
    },
  ],
  "browser-returned": [
    {
      name: "after a sign-in, with what comes next",
      wake: {
        facts: {
          kind: "browser-returned",
          site: "store.example.com",
          after: "Add the order to the basket.",
        },
      },
      words:
        "The captain returned control of this task's browser, on store.example.com. Your earlier refs are gone: run `infinitary-browser-axi` for a fresh look at the page as it is now, including anything the captain signed in to, and check what changed before you carry on. You said that next you would: Add the order to the basket. If you asked the captain to pay or submit something, read what the page says happened and keep only the result, such as a reference. If the page does not confirm it - an error, a page still processing, no answer, or a browser that is gone - the outcome is unknown: never submit, reload or resend it; check where the site lists it, such as its bookings, and ask the captain on a card to check in the browser. Until the seller or its payment service shows the result, say plainly you do not know whether it went through: a missing booking or charge proves nothing, so never guess either way or suggest trying again. Returning control gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first. A browser outside the kept profile keeps nothing past its stop: what the captain signed in to there is gone once this browser stops. Tell the captain a sign-in stays only when your browser said it opened the site in the kept profile.",
    },
    {
      name: "with the kept sign-in",
      wake: {
        facts: {
          kind: "browser-returned",
          site: "store.example.com",
          after: "Read the order history",
          saved: true,
        },
      },
      words:
        "The captain let this task use the sign-in kept on this computer for store.example.com, and your browser is yours again: its page opened with that sign-in. Your earlier refs are gone: run `infinitary-browser-axi` for a fresh look at the page as it is now, and check that it is signed in before you carry on. You said that next you would: Read the order history. If the site still asks for a sign-in, the kept one has ended: ask the captain again on a card with browser_handoff carrying saved_failed true and browser_sign_in true, so the next card leads with the captain signing in. A kept sign-in gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first.",
    },
    {
      name: "with words the captain left beside the page",
      wake: {
        facts: {
          kind: "browser-returned",
          site: "store.example.com",
          after: "Add the order to the basket.",
          words: "I chose Individual, but should this use my company?",
        },
      },
      words:
        "The captain returned control of this task's browser, on store.example.com. Your earlier refs are gone: run `infinitary-browser-axi` for a fresh look at the page as it is now, including anything the captain signed in to, and check what changed before you carry on. You said that next you would: Add the order to the basket. If you asked the captain to pay or submit something, read what the page says happened and keep only the result, such as a reference. If the page does not confirm it - an error, a page still processing, no answer, or a browser that is gone - the outcome is unknown: never submit, reload or resend it; check where the site lists it, such as its bookings, and ask the captain on a card to check in the browser. Until the seller or its payment service shows the result, say plainly you do not know whether it went through: a missing booking or charge proves nothing, so never guess either way or suggest trying again. Returning control gives this task the signed-in site, not permission to buy, pay or submit anything that matters: ask on a card first. A browser outside the kept profile keeps nothing past its stop: what the captain signed in to there is gone once this browser stops. Tell the captain a sign-in stays only when your browser said it opened the site in the kept profile.\nAs they returned control, the captain left you these words in your request card's reply field. Do what they need first, and answer them in your next card or report. Their words, verbatim:\nI chose Individual, but should this use my company?",
    },
  ],
  "page-unanswered": [
    {
      name: "the captain waits at a page nothing answers at",
      wake: {
        facts: {
          kind: "page-unanswered",
          site: "localhost:5173",
          url: "http://localhost:5173/settings",
        },
      },
      words:
        "The captain opened your task's page in its browser at http://localhost:5173/settings and is waiting there, but nothing answers at localhost:5173: a connection to it was refused on the computer that runs this task, so the program that served it has stopped. If the captain should still see it, start it again, running it in the background so it outlives your command, and open http://localhost:5173/settings again with `infinitary-browser-axi open <url>`, or with `infinitary-browser-axi open <url> --start '<command>' --within <seconds>` so Infinitary starts it itself next time; the captain's view shows the page once it loads. You are told this once for this outage.",
    },
    {
      name: "the start the crewmate saved exited before anything answered",
      wake: {
        facts: {
          kind: "page-unanswered",
          site: "localhost:5173",
          url: "http://localhost:5173/settings",
          start: { command: "pnpm dev", exit: 1, log: "/tasks/t1/temp/page-start.log" },
        },
      },
      words:
        "The captain opened your task's page in its browser at http://localhost:5173/settings and is waiting there, but nothing answers at localhost:5173: a connection to it was refused on the computer that runs this task, so the program that served it has stopped. Infinitary ran the --start command you saved for it, `pnpm dev`, but it exited (code 1) before anything answered; its output is in /tasks/t1/temp/page-start.log. If the captain should still see it, start it again, running it in the background so it outlives your command, and open http://localhost:5173/settings again with `infinitary-browser-axi open <url>`, or with `infinitary-browser-axi open <url> --start '<command>' --within <seconds>` so Infinitary starts it itself next time; the captain's view shows the page once it loads. You are told this once for this outage.",
    },
    {
      name: "the start the crewmate saved ran out of time",
      wake: {
        facts: {
          kind: "page-unanswered",
          site: "localhost:5173",
          url: "http://localhost:5173/settings",
          start: { command: "pnpm dev", ranOut: true, log: "/tasks/t1/temp/page-start.log" },
        },
      },
      words:
        "The captain opened your task's page in its browser at http://localhost:5173/settings and is waiting there, but nothing answers at localhost:5173: a connection to it was refused on the computer that runs this task, so the program that served it has stopped. Infinitary ran the --start command you saved for it, `pnpm dev`, but nothing answered within the seconds you gave, so it stopped it; its output is in /tasks/t1/temp/page-start.log. If the captain should still see it, start it again, running it in the background so it outlives your command, and open http://localhost:5173/settings again with `infinitary-browser-axi open <url>`, or with `infinitary-browser-axi open <url> --start '<command>' --within <seconds>` so Infinitary starts it itself next time; the captain's view shows the page once it loads. You are told this once for this outage.",
    },
  ],
  "attachments-dropped": [
    {
      name: "over prose",
      wake: { facts: { kind: "attachments-dropped", guidance: "Match this screenshot." } },
      words: "[image attachments could not be kept - ask to resend]\n\nMatch this screenshot.",
    },
    {
      name: "over typed guidance",
      wake: {
        facts: {
          kind: "attachments-dropped",
          guidance: { kind: "crewmate-tab-line", words: "Match this screenshot." },
        },
      },
      words:
        "[image attachments could not be kept - ask to resend]\n\nThe captain typed this to you in your task's Crewmate tab, where they read your session as you work.\nTreat it as their direct guidance: do what their words need, and answer through your work and your next report, never with an acknowledgement or a card about having read it.\nPutting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate, so the first mate runs it.\nWhen their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming the Crewmate tab, so the first mate records them as their standing override; carry on with what their words already allow.\nThe captain's words, verbatim:\nMatch this screenshot.",
    },
  ],
  "attachments-kept": [
    {
      name: "over prose",
      wake: {
        facts: {
          kind: "attachments-kept",
          guidance: "Match this screenshot.",
          attachments: [PICTURE],
        },
      },
      words: "Match this screenshot.\n\n[attached: 1 picture: settings.png]",
    },
    {
      name: "over typed guidance",
      wake: {
        facts: {
          kind: "attachments-kept",
          guidance: { kind: "crewmate-tab-line", words: "Match this screenshot." },
          attachments: [
            PICTURE,
            { ...PICTURE, id: "a2", name: "after.png", file: "m-118/after.png" },
          ],
        },
      },
      words:
        "The captain typed this to you in your task's Crewmate tab, where they read your session as you work.\nTreat it as their direct guidance: do what their words need, and answer through your work and your next report, never with an acknowledgement or a card about having read it.\nPutting the change in, discarding it, a stronger model, or unrelated work is not yours: report the captain's words verbatim with needs_firstmate, so the first mate runs it.\nWhen their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming the Crewmate tab, so the first mate records them as their standing override; carry on with what their words already allow.\nThe captain's words, verbatim:\nMatch this screenshot.\n\n[attached: 2 pictures: settings.png, after.png]",
    },
  ],
  "kept-merge-guidance": [
    {
      name: "over prose",
      wake: { facts: { kind: "kept-merge-guidance", guidance: "Rename the test too.", mark: 3 } },
      words:
        "Rename the test too.\n\n[kept merge] The captain's merge approval on this task stands, so these words of theirs hold its merge until you declare their impact: check_change captainGuidance with mark 3 - none if they leave the approved work as it was, changed-work if they change it (then put up a new merge card when the work is ready).",
    },
    {
      name: "over typed guidance",
      wake: {
        facts: {
          kind: "kept-merge-guidance",
          guidance: {
            kind: "thread-reply",
            card: { id: "card-a", title: "Split the wakes file" },
            words: "Rename the test too.",
          },
          mark: 4,
        },
      },
      words:
        "The captain replied in the thread on your card. Do the work their words need first, then answer at once, before unrelated work: always give one short answer in the thread, one to three sentences, whether or not the card changes, with reply(card_id, text) - prose only - and, when their words change what the card should say, also revise it with emit_card under the same id (pass the answer as its reply parameter to do both in one call, saying what you changed and under which heading; every revision while you answer needs its own). Your answer names their message in answers_message, by its number below; until a line does, the card keeps showing them the version they replied under. Then report. Their reply keeps your card on their screen beside its thread, and the thread shows what you are doing as you work; never acknowledge their words or announce a plan: they read your answer. When the work will take more than a few minutes, first post one line with reply and interim true saying what you are doing; it keeps their reply waiting for your answer. On your merge card, when their words change the work, post that one interim line, then answer with the revised card once the checks on the version you pushed pass: the app keeps the card from them until then, and a question the rework raises goes on a card of its own. On your answering card of an answer task, when their words, however put, say they need nothing more from your answer and ask, correct or approve nothing, answer naming answers_message with signs_off true: it closes the card as read and the task as answered, and nothing more is owed. Putting the change in, discarding it, a stronger model, or unrelated work is not yours: close your card with close_card and report the captain's words verbatim with needs_firstmate naming this card's id, so the first mate runs it. When their words pass one of the app's holds or tell you to go on without asking them, report them verbatim with needs_firstmate naming this card's id, so the first mate records them as their standing override; carry on with what their words already allow.\nCard \"Split the wakes file\" (card-a).\nThe captain's words, verbatim:\nRename the test too.\n\n[kept merge] The captain's merge approval on this task stands, so these words of theirs hold its merge until you declare their impact: check_change captainGuidance with mark 4 - none if they leave the approved work as it was, changed-work if they change it (then put up a new merge card when the work is ready).",
    },
  ],
  "conversation-restart": [
    {
      name: "renewed instructions, with its brief and transcript",
      wake: {
        facts: {
          kind: "conversation-restart",
          restart: { from: "s-77", changed: ["prompt"] },
          taskKey: "INF-2696",
          brief: "Bring wakes.ts under 2,000 lines.",
          earlier: "crewmates/479823ee/s-77.jsonl",
        },
      },
      words:
        "Your conversation has restarted: the app was updated, and the instructions and tools you started this task under changed. A reopened conversation would have kept the old ones, so you continue in a new conversation on the current ones. Your earlier conversation is not in this one.\n\nYou are continuing your task, not starting it. What you committed and changed is in your working copy, and your reports, your last card and your brief are on your task's record: read it with tasks (key INF-2696) before you act, and do not redo work it shows done. If you need more, the transcript of your earlier conversation is saved at crewmates/479823ee/s-77.jsonl; read only the parts you need.\n\nYour task's brief, as you first received it:\n\nBring wakes.ts under 2,000 lines.\n\nThe message that brought you back follows.",
    },
    {
      name: "a conversation that would not open",
      wake: {
        facts: {
          kind: "conversation-restart",
          restart: { from: "s-77", changed: "unopenable" },
          taskKey: "INF-2696",
        },
      },
      words:
        "Your conversation has restarted: your earlier conversation could not be reopened, so you continue in a new one. Your earlier conversation is not in this one.\n\nYou are continuing your task, not starting it. What you committed and changed is in your working copy, and your reports, your last card and your brief are on your task's record: read it with tasks (key INF-2696) before you act, and do not redo work it shows done.\n\nThe message that brought you back follows.",
    },
    {
      name: "a task moved to another computer",
      wake: {
        facts: {
          kind: "conversation-restart",
          restart: { from: "s-77", changed: "computer", to: "Builder" },
          taskKey: "INF-2696",
        },
      },
      words:
        "Your conversation has restarted: your task moved to Builder, where your working copy, your evidence, your card bodies and your handed files were moved with it, in the folders your instructions name now. Paths in your earlier messages and your brief name the folders on the computer it left, so use the ones your instructions name now. Your earlier conversation is not in this one.\n\nYou are continuing your task, not starting it. What you committed and changed is in your working copy, and your reports, your last card and your brief are on your task's record: read it with tasks (key INF-2696) before you act, and do not redo work it shows done.\n\nThe message that brought you back follows.",
    },
    {
      name: "a task moved off a computer out of reach",
      wake: {
        facts: {
          kind: "conversation-restart",
          restart: {
            from: "s-77",
            changed: "computer",
            to: "this computer",
            leftBehind: { on: "Mac mini", head: "9f2c1e4b7a0d3c5e8f1a2b4c6d8e0f1a3b5c7d9e" },
          },
          taskKey: "INF-2696",
        },
      },
      words:
        "Your conversation has restarted: your task moved to this computer while Mac mini, where it ran, was out of reach, so nothing came from Mac mini. Your working copy starts at commit 9f2c1e4, the newest of your commits that the computer the first mate lives on held, and your task folders hold only what that computer had of them. What only Mac mini held stays there: commits after that one, edits you had not committed, files git did not track, and the evidence and card bodies you wrote there. Check your working copy against your record before you act, and redo what it lacks. When Mac mini is back, the app keeps that copy and tells you where it is. Paths in your earlier messages and your brief name the folders on Mac mini, so use the ones your instructions name now. Your earlier conversation is not in this one.\n\nYou are continuing your task, not starting it. What you committed and changed is in your working copy, and your reports, your last card and your brief are on your task's record: read it with tasks (key INF-2696) before you act, and do not redo work it shows done.\n\nThe message that brought you back follows.",
    },
  ],
};

pinWakeWords("every wake a crewmate hears, byte for byte", CASES);
