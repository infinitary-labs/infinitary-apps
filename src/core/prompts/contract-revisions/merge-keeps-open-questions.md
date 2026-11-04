# A merge keeps open questions

INF-2532, the build of INF-2525's plan and INF-2533's plan.
INF-2525: the captain saw a question card and a merge card up together and asked that a merge never take the question down; their answers were "words" for prevention, "keep-open" for the fallback, and, written in, "it should become the agent's judgment for what's the appropriate next steps".
INF-2533: a task that merges on its own shows its story note once, after the merge has a result; when only the captain can pass a hold, the first mate sets the task to ask first (the captain's answer "agent").

What the first mate is now told:

- `settle_task` merge-pr closes a task as merged only once nothing else on it, a question or another pull request, is open; a merge with one open keeps the task open, and its crewmate judges what comes next. Its home is the tool description.
- When only the captain can pass a hold on a task that merges on its own, the first mate sets the task's autonomy off, so its crewmate shows the usual completion card. Its home is the core, beside the line on a standing direction's exception.

The fixed context grows by about 30 tokens.
