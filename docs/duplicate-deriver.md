# Duplicate-candidate deriver

Interaction-system program P3 (WI-20).
`scripts/derive-duplicate-candidates.ts` reads the `cards` table (and `tasks` for titles) and emits weak candidate duplicate-card pairs as JSONL.
It is offline, reads tables only, and has no UI - the same shape as the miss deriver (`docs/miss-deriver.md`).

```
pnpm derive:duplicates --db /path/to/firstmate.db --out candidates.jsonl
pnpm derive:duplicates --user-data /path/to/exported/userData
pnpm derive:duplicates --db tests/fixtures/replay/sep14/tables.json
```

## The rule

A card pairs with an earlier card when three things hold:

- **Same task.**
  Both cards are on the same task.
  Cards with no task never pair.
- **Inside the window.**
  The earlier card was emitted at most `--window-minutes` before it (default 30).
- **Similar enough.**
  Their title overlap or whole-card overlap reaches `--threshold` (default 0.5).

A card that offers a settle - an action with a `settle` effect, or one of the reserved ids a card from before cards/tasks/agents P1 carried (`merge-pr`, `land`, `keep`, `discard`) - never pairs.
It is the task's settle moment, and on the real database a task's plan decision and its settle decision were the only false positive: same task, similar words, two different questions.

Overlap is a Jaccard measure over topic words.
Each later card pairs with its most similar earlier card only, so a thread of N restatements is N-1 pairs.

The similarity and the pairing are `cardSimilarity` and `duplicatePairs` in `scripts/interaction-metrics.ts`.
The replay harness scores `duplicate_card_pairs` with the same functions (`docs/replay-harness.md`).

## What it never does

- **It never writes.**
  Not the captain's `duplicate_of` / `duplicate_note` / `duplicate_at` stamp (WI-14), and not anything else.
  The database is opened read-only.
- **A candidate is not a verdict.**
  Every record is labelled `weak: true, confirmed: false`.
  A card the captain already stamped is observed as `captain_stamped: true` and still stays unconfirmed - the stamp is its own captain-gated path.
- **An unpaired card is not a confirmed negative.**
  Similar wording is not the same card, and different wording can be.
