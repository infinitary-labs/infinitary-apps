# The first mate writes one sentence when it closes started work

INF-547 planned an update for work that closes without the captain's click, after their words: "the tasks were done but i never got any update."
They chose direction C, the crewmate's own story put up before the merge, for every started task that closes without their click, with one sentence the first mate writes as it closes the task, gone only when they close it, and a "Dropped: …" feed line.
`settle_task` gains a top-level `closing_sentence`, required for every mode except `answered`: one plain sentence for the captain on what became of the work and why.
`interrupt_crewmate` gains the same parameter, required with `cancel`, and its description points at `settle_task`'s.
Both tools refuse such a close without the sentence and say what is missing.
The host puts the sentence up as the first mate's own note when the close leaves nothing of the task on the stack, and Activity's line for a drop reads `Dropped:` and the sentence.
The core's autonomy merge line no longer says the crewmate's report comes with no card, since that crewmate now shows its story on a note before it asks for the merge.
Each rule has one home: the sentence on `settle_task`'s parameter, the cancel's on `interrupt_crewmate`'s, and the merge on a crewmate's request in the core.

To stay inside the fixed context's boundary, repeats came out, each recorded in the fixed-context ledger where it is still said.
The core's settle step no longer says to take the id from `crew_status`, which `settle_task`'s description says.
`settle_task`'s description opens with "Close a task." and says its record and session stay in four words, its merge-pr and land sentences share one ending, and its released sentence names `release_evidence`, whose parameter says what to pass.
The fixed context measures 19,767 tokens by the app's count, inside the boundary of 19,772.
