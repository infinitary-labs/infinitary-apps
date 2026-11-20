# A card can offer Not until, and the app raises it again

INF-3846 piece 3, approved by the captain with "Approve and build" on direction a, "Begun work always has a next move".
Before, a choice such as "Decide after the settings task closes" was an ordinary button, the reminder lived only in its author's words or a scheduled prompt, and nothing asked the captain again when the moment came.

An action with no effect may now carry `until`: the close of a named task, whatever closed it, a time, any event an Automation rule can wait for, or the captain's word.
The captain chose a task's close over a merge as the awaited moment, since a close is how a dependency between tasks is said everywhere else, and ruled that the moments are Automation's events, with a task's close added as one.
The click reaches the card's author as usual; the host keeps the put-off on the closed card and saves an Automation rule that raises the same card again when its moment comes.
A task with a put-off card counts as stopped by the captain: it raises no stall and no idle wake.
update_task gains a top-level `raise_put_off` parameter, which raises a task's put-off cards now on the captain's words.
The emit_card actions parameter is the rule's one home; the update_task parameter's description says only what it does.
The two descriptions add about 80 tokens to the first mate's fixed context.
