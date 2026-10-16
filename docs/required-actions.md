# Required captain actions

A code merge finishes the code task, not the captain's required work.
A newly authored completion offer declares `required_actions`, including `[]` when there are none.
Old saved cards without the declaration remain historical unknowns.
The declaration is display-only: it grants no execution permission.

## Before merging

The host draws “After merging, you need to…” outside the body's scroller, above the buttons.
Each action names its imperative, target and consequence of waiting.
Several actions have a visible count and a keyboard-reachable disclosure; none is silently truncated.
The source task keeps the declaration and offered version before the merge.
A captain click carries the declaration from the version he actually chose, including when a newer revision is not yet shown.

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
The first mate answers help with a thread reply, keeping the app-owned instructions and confirmation controls intact.
Conversational cancellation uses the existing explicit drop with a reason.
An explicit drop records cancellation separately and does not complete dependents.
`update_task correct_required_action` reopens a mistaken confirmation while preserving its history; it does not reverse work already continued.
Ordinary crewmate continuation tasks remain separate.

## Observed completion

The supported observation is `device-version`: stable device ID, minimum app version and work compatibility.
The observer consumes only a fresh authenticated connection hello through `WorkDevices.onVersion`, never cached Settings data or an Update click.
Every requirement must match that device and version, the connection must take work, and prerequisites must already be satisfied.
Unreachable, incompatible or stale facts leave the action unconfirmed.
Observed results read “Checked by your first mate”.
There is no arbitrary remote check or command runner.
