# Fixed-context restatements

FI3-1268 restores room under the fixed-context budget, filed from FI3-1258 when its checks failed on untouched main.
The all-card demo wording and the bounded fact retrieval guidance each fit the 19,700 ceiling alone, but together the Firstmate's fixed context measured 19,710.
FI3-1253's tighter `update_task` wording then brought it to 19,695, five tokens under the ceiling.
The ceiling cannot rise past 19,772 without failing the smallest local window's conversation-space check, so three tool sentences the Firstmate is already told elsewhere are gone.
`emit_card` no longer says a note about no existing work asserts standalone; its `standalone` parameter and the persona's one-off rule still do.
`spawn_crewmate`'s `escalate_from` no longer repeats that an escalation never follows a crewmate's own report or an operational wake; the persona's escalation rule still does.
`check_pr_ci` no longer says to call it on a crewmate's PR report; the persona's CI rule still opens with that call.
The fixed context falls by 36 tokens, to 19,659, and `tests/firstmate-fixed-context.test.ts` ledgers each sentence's remaining home.
