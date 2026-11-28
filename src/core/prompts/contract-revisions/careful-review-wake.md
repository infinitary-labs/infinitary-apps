# Careful work committed with no review open wakes the first mate

INF-7116 fix 3, the captain's "Start now" on that card.
A Careful builder committed its fix and reported it ready for its review while a notice it had already heard sat on its queue, so the report was sorted routine and nobody started the review for 31 hours; the host starts no Careful review by itself.

What the first mate is now told:

- A report wake on a Careful task whose branch holds commits of its own at a version no passed review covers, while no review of the task is open, says so: "It is Careful work committed at <sha>, and no passed review covers that version and no review of the task is open; the host starts none by itself, so start its review with review_of at that version." That report wakes the first mate (`careful-unreviewed`, docs/report-sort.md row 0e).
- The builder's row in its crew status and context block reads "waiting for its Careful review: committed at <sha>, no review open and no pass covering it".
- The care guide's review sentence names that wake beside a builder's own ask: "When a Careful builder reports its work committed and asks for its review, or its report wake says its Careful work is committed with no review open, spawn_crewmate with review_of naming that task and the user's words".

A Careful crewmate's careful-change skill now tells it to ask the first mate with needs_firstmate to start the review of its committed version; that is the crewmate's text, not the first mate's.

Home: the wake sentence is the report wake's only and the status line is the crew status's only; the care guide's sentence keeps its one home.
The core and the tool descriptions are unchanged, so the fixed context does not grow.
The host reads only typed facts: the task's care, the commits its branch holds of its own, the review record, and whether a review of the task is open.
