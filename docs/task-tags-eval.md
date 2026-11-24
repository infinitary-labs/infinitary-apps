# The task tags eval

The tagging question decides which of a project's tags fit a task.
This page covers how it is asked and how `pnpm score:tags` measures it against a hand-labelled set of this project's own tasks.

## The question

`src/core/decisions/tagQuestion.ts` builds one yes-or-no question per tag from the tag's name and description alone, so a project's own tags need no code.
`tagQuestions` keys them `tag1`, `tag2`, ... in name order, so a set answered in one reply reads back line by line, and `ids` maps each key back to its tag.
`tagState` gives every question the same task: its project, title, goal, its parent's title, and the person's own words, clipped to task classification's limits.
Each question offers `unsure` as its abstention.

A person's own chat models answer the whole set in one call when the asker sets `together` (`docs/decision-models.md`, "The implementations").
A native decision model answers a question set in one request whatever it is asked.

Changing any served word in the question raises `TAG_QUESTION_VERSION` and calls for scoring the set again.

## The eval set

`tests/fixtures/task-tags/tags.json` holds this project's tags, and `tests/fixtures/task-tags/eval.jsonl` holds the labelled tasks.
Each row keeps a task's title, goal, the person's words and its parent's title, how the task was filed (`way`), the month it ran, and the tags it fits.
Names, computer names and private paths are removed from the text.
The kind tags (`bug`, `feature`, `idea`) are exclusive: a task fits at most one of them.
The part tags can stack, and a task may fit no tag at all.

Two labelling passes read each task's whole record, its brief and its final report, against the tags' descriptions.
A task the two passes tagged differently is left out of the set.
Each tag has at least 20 rows that fit it, and at least 60 rows fit no tag.

## The scorer

`scripts/score-task-tags.ts` asks four ways:

| way | question | requests per task |
| --- | --- | --- |
| a | one yes-or-no question per tag, the whole set together | 1 |
| b | one yes-or-no question per tag, each on its own | one per tag |
| c | one multiple-choice question over every tag plus `none`, keeping its one pick | 1 |
| d | the same multiple-choice question, keeping every tag whose probability clears a floor | 1 |

Way (c) can keep at most one tag, so it can never tag a task with two tags exactly right; it shows what one pick gives up.
Way (d) needs a native decision model, because only it returns a probability for each option.
The scorer reads those probabilities from the model's own reply and never through the app's decision interface, which keeps confidence inside.
It sweeps the floor from 0.05 to 0.95 and keeps the floor that tags the most tasks exactly right, ties going to higher precision and then to the lower floor.

For each way and model it reports, per tag and overall, precision and recall, the share of tasks tagged exactly right, unsure and failed answers with their reasons, requests and tokens per task, and time.
A failed or unsure answer keeps no tag.

```sh
pnpm score:tags --dry
pnpm score:tags --models <models.json> --provider <p> --model <m> --api-key-env <NAME> --out chat.json
pnpm score:tags --decision-model jev --out jev.json
pnpm score:tags --decision-model openrouter:<model id> --api-key-env <NAME> --out openrouter.json
```

`--dry` prints the set and the served questions and calls no model.
A chat model is bound through a Pi `models.json`, and a native model through its own key: TypeSafe's from `TYPESAFE_API_KEY`, OpenRouter's from the variable `--api-key-env` names.
A key is set on the runtime in memory and never written to disk or passed on the command line.
`--ways` picks ways, `--limit` scores the first rows only, and `--concurrency` sets how many tasks are asked at once.
Like `pnpm score:kinds`, the scorer runs only behind Observe's development gate.
