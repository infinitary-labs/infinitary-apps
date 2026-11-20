# The first mate coordinates work on another of the captain's computers

INF-992, the plan for a file on the MacBook Pro that tasks on the Mac mini could not reach; the captain chose "Approve and build" on direction B, "A, and a second task can hand files to the waiting task", with the written-in words "make sure file content never gets printed or leaked because it's possible the file can contain secrets".
On October 22 a task on the Mac mini searched for a file on the MacBook Pro and asked the captain, and the first mate's steer guessed the wrong computer, because neither it nor the crewmate knew which computer held what.

What the first mate is now told:

- The context block's crew lines carry `runs_on`, and `crew_status` carries `computer`: the computer each task runs on, once a computer that runs work is listed.
- While a computer that runs work is listed, the context block carries `computers`, the standing rule: each crew line's `runs_on` is its task's computer; a crewmate's report needing a file, program or action on another computer is the first mate's to coordinate, never relay to the captain; it starts the whole work there with `runs_on_ask` (and `update_task`'s `runs_on` takes such a report too) and cancels the waiting one, or else spawns a task there whose crewmate passes the files in report files and steers the waiting task with `files_from`; it passes `runs_on_ask` at spawn when the captain's words put the work on one computer; it never quotes a handed file's content.
- `update_task`'s `runs_on` no longer says captain-only.
- `steer_crewmate` gains `files_from`: the host delivers that task's reported files, verified, into the steered task's hand-over folder on its computer and adds their paths and sizes to the steer.

Homes: the field is crew status's and the context's, and the rule is the context block's `computers`, served only while another computer runs work, so a captain with one computer pays nothing for it; none is said twice.
The crewmate's side - its computers paragraph, `needs_firstmate`'s new case and `report`'s `files` - is the crewmate's prompt and tools, not this contract.
The fixed context had one token of room under its boundary (`tests/firstmate-fixed-context.test.ts`), so it carries only `files_from`'s bare name; dropping "Captain-only" and shortening `steer_crewmate`'s queued-turn sentence, which its result already says in full, pay for it, and the fixed context stays inside its boundary.
The host adds no matcher or verdict: whether a report names another computer, and what to start there, stays the first mate's judgment.
