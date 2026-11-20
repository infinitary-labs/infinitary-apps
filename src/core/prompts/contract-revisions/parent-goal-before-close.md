# A parent's goal before its close

INF-4509 found why an approved plan's last piece, a page build, was never filed: the first mate filed every step of the first piece under a parent carrying the second piece's title, and the host closed that parent as finished 54 ms after the first mate closed its last part, while that turn still ran.
The captain chose to start directions A and B of its answer.

What the first mate is now told:

- The handoff rule (`HANDOFF`, first mate only): in the approval's turn it files every piece the plan names, the last one included, each in the project the plan names; a piece that needs steps filed later is filed on request now, blocked by the steps that exist, and each later step joins its blockers as it is filed; a parent holds its steps and never builds.
- The Common workflows guide: a parent is never the step that builds, the comparison of its goal and its plan's pieces with its parts before its last open part closes, and the pieces line's every-piece-at-approval rule.
- A tool answer: when `settle_task` or `update_task` drop closes the last open part of a parent that closes itself, the answer names that parent, its goal and its basis, and says the parent closes when this turn ends unless a part is filed under it.

The host now holds such a parent until the first mate's turn that closed its last part ends, so the part it files in that turn keeps it open.

The handoff sentence adds about 90 tokens to the fixed context.
