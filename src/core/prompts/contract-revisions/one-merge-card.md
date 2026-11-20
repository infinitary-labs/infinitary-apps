# One merge card for every pull request merge

INF-2744, the captain's plan answer: every request to merge a pull request is raised through the same card, the merge card, and "a request is just like calling a tool".
Before it, a crewmate's finishing merge was a `settle merge` on its completion card, a continuing merge was a separate `request_merge` card, and a task that merged on its own showed a note and asked the first mate to run `settle_task merge-pr`.

What the first mate and its crewmates are now told:

- A card action has one merge effect, `merge`, whose `after` says what follows the merge (`close` or `continue`), whose `review` names a stored review for any pull request but the task's current change, and whose `asks_first` says why a standing direction leaves this merge to the captain.
- `settle` keeps only `discard`; the words "completion card", "completion decision" and "completion offer" are now "merge card" everywhere the contract says them.
- With autonomy on, the app merges from the merge card once its checks pass, so the first mate is not woken to run `settle_task merge-pr` for it; the crewmate's merge card decides, never the first mate.
- A task may put up several merge cards, one per pull request.
- The report tool no longer takes `merge_completes_task`: the open merge card's `after: close` is the one declaration that a merge made elsewhere finishes the task.

Homes: the effect's shape is the emit_card actions parameter's and the card mechanics', the autonomy rule is the core's and the report tool description's, and the review's use is check_change's; none is said twice.
The fixed context moves by a few dozen tokens: the merge effect's words replace the two old effects' words, and the core's autonomy line grows shorter.
