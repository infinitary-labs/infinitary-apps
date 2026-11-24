# Recorded proof with no reader started wakes the first mate

INF-6536 finding 3, the captain's "Start a task now to build it".
A takeover's crewmate recorded live validation and reported; no review of the task was open to read the proof, and nothing told the first mate, so the work sat until someone noticed.
The same finding has a takeover at the very commit an earlier task's review passed carry that pass and its accepted proof.

What the first mate is now told:

- A report wake on a task whose latest live validation run waits for an independent reader at its committed version, while no review of the task is open, says so: "Its live validation run N at <sha> waits for an independent reader, and no review of the task is open to read it; a review started with review_of at that version reads it." That report wakes the first mate (`proof-unread`, docs/report-sort.md row 0d).
- A crewmate's show_merge_card answer on a takeover at the reviewed commit names the task whose review it carries; that line is the crewmate's, not the first mate's.

Home: the sentence is the report wake's only; the core and the tool descriptions are unchanged, so the fixed context does not grow.
The host reads only typed facts: the run's acceptance naming the reviewer as what is missing, and whether a review child of the task is open.
