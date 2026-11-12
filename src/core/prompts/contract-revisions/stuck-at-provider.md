# A task stuck at its provider asks the first mate

INF-3714, approved by the captain with "Approve and build" on direction A: "Ask the first mate, and stop the retry after three identical refusals".
Before, a crewmate's guidance was retried at its provider forever, and the first mate heard only that the host keeps retrying.

After the same provider refusal three times in a row the host stops retrying and keeps the guidance, and the first mate hears it once in the new `provider-stuck` wake, which names the ways that can work.
update_task gains a top-level `unstick` parameter: `restart` continues the task in a fresh conversation, and `move` moves it to the app's pick off the refusing provider, which the first mate may do without the captain's words for a stuck task only.
The wake is the rule's one home; the parameter's description says only what each value does.
The parameter description adds about 30 tokens to the first mate's fixed context; the wake's words are served only with the wake.
