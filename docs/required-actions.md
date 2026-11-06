# Required captain actions

A code merge finishes the code task, not a captain-only contribution.
Declare only a part the captain alone can give, following the fleet-work principle in `docs/principles.md`.
Work the fleet can carry out after the merge is an after-merge step on the change's story instead, not a required captain action ("After-merge steps", `docs/task-graph.md`).
A newly authored completion offer declares `required_actions`, including `[]` when there are none.
Old saved cards without the declaration remain historical unknowns.
The declaration is display-only: it grants no execution permission.

## Before merging

The host draws “After merging, you need to…” outside the body's scroller, above the buttons.
Each action names its imperative, target and consequence of waiting.
Several actions have a visible count and a keyboard-reachable disclosure; none is silently truncated.
The source task keeps the declaration and offered version before the merge.
A captain click carries the declaration from the version the captain actually chose, including when a newer revision is not yet shown.

## Durable ownership

`TaskService` owns each action as an on-request `operation` with `delivery.captainAction` and a captain gate.
This operation is not a card-only row, a crewmate or a child that holds the code task's close.
The successful `merged` or `landed` close creates it in the same transaction, with a source/offer/action receipt that prevents duplicate activation.
Local merges, direct changes, automatic merges and recognition of an outside merge share that close.
Refused or unknown merges leave declarations pending; discard creates no actionable obligation.
The first mate can declare immediately required actions on an attached or standalone card using the same primitive.

Action IDs are explicit; only an explicit `sharedId` consolidates outstanding requirements.
A shared action retains every source requirement and unions its prerequisites.
A requirement added after completion creates a new operation, never inherits the old confirmation.
A changed outstanding requirement or code version changes its generation and invalidates the previous confirmation button.
An otherwise revised offer with identical requirements preserves its deferred state without another card.
Prerequisites use existing blocks links; dropped prerequisites never clear a wait.
The blocked action stays visible in its record, but its card appears only when prerequisites finish successfully.

## Confirmation and deferral

`CardService` presents the first confirmation card and records its presented generation in one transaction.
Its host button records manual completion of that generation in the closing interaction's transaction.
A submitted stale or remounted offer refuses confirmation or consequential merging before anything closes.
Manual results read “Confirmed by you”.
Instructions are inert text; a confirmation runs nothing.
Not now, the close control, navigation, replies and opening Devices do not complete the action.
Deferred actions stay under Waiting on you in Tasks, with Show the card on the record.
The existing card-button command and Tab/Enter reach the controls; reopening is a typed `show-card` task operation available to paired views too.
The record survives restart without a worker, repeated cards or a new reminder scheduler.
It failed is an ordinary action button beside the completion button, with the same action keys and submission as every other choice.
The captain can paste output into the card's field, then choose It failed to send the failure and those words together.
The choice closes its offer without completing the operation; the host offers the outstanding action again on the same card and delivers the failure to the first mate through its thread.
The first mate arranges repair through the crew and answers with repair status there.
Chat still sends a reply without choosing an action.
While the thread awaits the first mate's answer, manual confirmation is paused; the action stays outstanding and Not now remains available.
The first mate uses `emit_card` with the same id, `task_id` and `reply` for help or status; the host writes only the thread line, keeping the app-owned instructions and confirmation controls intact.
An answer does not complete the action or run the captain's instructions.
Conversational cancellation uses the existing explicit drop with a reason.
An explicit drop records cancellation separately and does not complete dependents.
`update_task correct_required_action` reopens a mistaken confirmation while preserving its history; it does not reverse work already continued.
Ordinary crewmate continuation tasks remain separate.

## Correcting the words

A required action's words can be wrong: DOP-217 named a remover the captain could not find, and the crewmate that knew the right path had no way to say it on the card.
The captain approved that the words stay correctable, with who corrected them and why (INF-2214, built by INF-2225).

The first mate corrects them with `update_task revise_required_action`, a crewmate with its own `revise_required_action` output, and both go through `CardService.reviseRequiredAction` to `TaskService.delivery.reviseRequiredAction`.
The writer names the requirement by its source task and action id, the generation it read, only the fields it changes, a reason, a stable operation id, and `same_action` true, declaring it is still the same intended action.
Only the title, consequence, instructions and criterion change, and only on that requirement.
Its target, ids, source filing, prerequisites and completion mode stay, as do the other requirements of a shared action, its state (blocked, ready or deferred) and its card's thread.
A different action is a cancellation and a new declaration instead.

A real change moves the generation by one, so a confirmation offered for the older words no longer completes the action.
The words already say what they said, and the generation stays.
The correction is kept on its requirement, with the words it replaced, who made it, when, why and the generation it made, and a task timeline line names it.
The same operation id answers its earlier correction again and writes nothing new.
A stale generation, a different action, an unknown requirement, words that do not fit a required action, and a completed, checked or cancelled action are refused, and nothing is written.

A card on the stack shows the new words and generation at once, with a host line in its thread naming who corrected it.
Under each requirement the card says where it came from and every correction in its small print: "Filed from …", then "Corrected by …: why".
The writer verifies the right words itself on the target first, and never asks the captain to find them.
`correct_required_action` stays separate: it reopens a mistaken confirmation, while a correction of the words reopens nothing.

## Observed completion

The supported observation is `device-version`: stable device ID, minimum app version and work compatibility.
The observer consumes only a fresh authenticated connection hello through `WorkDevices.onVersion`, never cached Settings data or an Update click.
Every requirement must match that device and version, the connection must take work, and prerequisites must already be satisfied.
Unreachable, incompatible or stale facts leave the action unconfirmed.
Observed results read “Checked by your first mate”.
There is no arbitrary remote check or command runner.
