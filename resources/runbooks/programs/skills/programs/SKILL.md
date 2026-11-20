---
name: programs
description: The script start_program runs - host functions, bound, shapes. Read before using it.
---

# Programs

A program is a task whose steps a script decides: you write plain JavaScript, and the host runs it, filing each `task()` call as a part - a child task with its own crewmate - and handing the script each part's checked result.
Use one when your task's work is repeated or parallel and a script can decide its steps: a loop toward a stop condition, an audit, deep research (never a single research step), a migration of each item, or a workflow of plan, build and check.

## Before you start one

Read the code first, so the script's `args` are real: the files, areas, questions or items each part works on.
Choose `bound`, your upper bound on the script's `task()` calls.
A program spends the captain's plan's allowance, one crewmate per part: when the bound is large, ask the captain on a card first, saying what each part does and the bound you propose.
Call `start_program` with a sentence-case `title`, a one-sentence `goal`, the `script`, its `args` and the `bound`.
It is filed in your project, found on your task, and starts at once; your task waits on it and cannot merge until it closes.
End your turn: the program's end steers you once, and then you read its result with `tasks` and its key.
A program keeps the captain's words from your task on its own record, and its parts get none: each part's own goal is its ask.
Parts are premium only when your task carries the captain's premium request.
A part of a program starts no program of its own: it says the need in its result, and the script decides.

## The dialect

The script runs in a fresh realm with only these names beyond the language: no require, files, network, timers, `Date.now()` or `Math.random()`.

- `task(prompt, {label, schema, from, after, intelligence})` files one part and resolves to its answer: its checked result when `schema` (JSON Schema, object root) declared a result shape, its report text when not, or `null` when the part was dropped.
  `label` names the part; `from` names an earlier part whose last commit its working copy starts at (`null` or none starts at the default branch); `after` names earlier parts whose results it builds on.
  `intelligence` requests `low`, `medium`, `high` or `premium` for this part; omitted, the default routing chooses.
  Medium suits narrowed work; high suits open or final work.
  To the captain a level is how hard the part is: say high as Hard, medium as Normal and low as Simple; premium stays Premium, since high, medium and low are also reasoning words.
- `ask(prompt, schema)` is one tool-less typed question, answered as JSON that fits the schema, or `null`.
- `log(text)` and `phase(name)` write a line on the program's own timeline; a phase also sets its plan dots.
- `args` is the JSON you passed; a name `args` does not carry is not there.
- Parallel parts are `Promise.all` over `task()` calls.

The script's return value is the program's result.
Return `{ branch: label, ... }` to name the part whose saved work is the program's branch; report that part's key, and shipping it is the first mate's.
A thrown error, or a `branch` naming no part that finished done, stops the program with the reason.

## Bounds

Parts open at once follow the computer's processors; a call past that waits for a part to close.
A call past `bound` is held and nothing more is filed, and you hear it once.
Ask the captain on a card whether it may go on, saying what has run and the new bound; on their words call `start_program` with `program` (its key) and the larger `bound`, or with `program` and `stop` true to drop it.
Once your task has closed, the first mate hears it instead.

## Five shapes

Adapt each to the work, and write the intelligence into each `task()` call.

- Workflow: a high planner, a medium builder that follows the plan, and a high checker that challenges the result; each `from` the previous; return the checker as the `branch`.
- Loop: one part a round up to `args.rounds`, awaited, each `from` the last round's label, its schema `{done, stuck, learned}`, its prompt `args.goal` plus the last round's learned note; high for the first round and after a stuck one, else medium; stop on done; return the last round as the `branch`.
- Audit: `Promise.all` over high finders, one per area or angle, then a medium verifier per finding to check one located claim, with one high recheck when a verifier cannot settle it.
- Deep research: `Promise.all` over medium researchers, one per narrow question, each citing sources, then one high writer `after` them all that reconciles conflicting evidence.
- Migrate: a medium part per item applying an established recipe, each `from` the previous item's label; return the last as the `branch`.

```js
let last = null;
let learned = "";
let stuck = false;
for (let i = 1; i <= args.rounds; i++) {
  await phase("round " + i);
  const round = await task(args.goal + learned, {
    label: "r" + i,
    from: last,
    intelligence: i === 1 || stuck ? "high" : "medium",
    schema: { type: "object", required: ["done", "learned"], properties: { done: { type: "boolean" }, stuck: { type: "boolean" }, learned: { type: "string" } } },
  });
  if (!round) break;
  last = "r" + i;
  stuck = Boolean(round.stuck);
  learned = "\nThe last round learned: " + round.learned;
  if (round.done) break;
}
return { branch: last };
```
