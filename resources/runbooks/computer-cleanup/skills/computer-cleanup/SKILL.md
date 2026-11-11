---
name: computer-cleanup
description: Look into a computer short on memory after the captain agrees; measure memory by owner, offer leftovers by task, and stop only the captain’s picks. Read before a cleanup look.
---

# A cleanup look

The captain chose ask first: the first mate offers a read-only look before starting you, naming this computer and the use of the captain’s plan’s allowance.
Confirm that permission in the task’s brief or card choice; if missing, ask before looking and start no investigation until yes.
Permission to look is not permission to stop anything.
Use the computer named in the brief; a shell on another computer cannot inspect it, so report needs_firstmate to coordinate a crewmate there rather than guessing from local readings.
Keep one look per computer, no project, and reuse its card and task while open.
After an answer, another offer waits for fresh evidence of recovery and renewed pressure; missing readings prove neither.
No pressure notice authorizes killing, pausing, slowing or moving running work.

## Read without changing anything

Record pressure, available memory, swap and the largest memory owners using local read-only tools.
On macOS, use `vm_stat`, `sysctl vm.swapusage` and `ps` for the initial reading; use `vmmap -summary <pid>` or `footprint` only for the specific candidates that need attribution.
Never use sudo or inspect credentials, environment variables, private documents or real keychains.
Keep raw readings private in the evidence folder and remove incidental arguments and identities from the card.
Do not search the whole disk or home folder: use task-named folders and the program’s own list command.

Treat process RSS as a rough ranking, not memory you can promise to free: shared pages can occur in several processes.
Prefer physical footprint for an owner; do not add footprint and RSS, a parent’s aggregate and its children, or a virtual machine host and the memory inside its guest.
Count each container runtime or simulator host once, not once per container or device.
Separate private/reclaimable memory from shared or unattributed memory where the reading supports it; otherwise label the estimate and overlap unknown instead of inventing a total.
Name the reading’s scope, units and uncertainty.
A configured virtual machine size is not measured use, and memory freed can differ from an estimate.

Inspect virtual machines, simulators, containers and stray shells, not just the app’s recorded processes.
Check that a runtime’s service or host process is already running before asking it for a list.
Use only installed programs’ read-only listings: for example, `xcrun simctl list devices booted`, `docker ps --no-trunc`, Apple’s `container list`, and the virtual machine manager’s list or status.
Do not start a stopped runtime, machine, simulator or container merely to list it.
If a command might start a service, omit it and report the visibility gap.
Match a candidate’s working folder, parent tree, recorded stop, identifier or named scratch disk against task records and evidence.
Include the app’s named `work/worktree-trash/` folder when a candidate’s working folder points there; do not sweep other folders to find it.
A retired folder keeps its original basename with a random suffix; task temporary folders can include `<task-id>-temp-<suffix>`, and older folders can include a timestamp before the original basename.
Treat the original task id as a lookup lead, not the random suffix; confirm it with tasks and the task’s recorded paths or timeline.
A folder name that resolves to no task has no established owner, uncertain: do not infer finished ownership or offer it just because it is in the trash.
Read the actual task’s status with tasks; age and idleness alone never mean finished.
Check for a shared service’s dependents before proposing to stop it.

Classify each owner as a finished task, an open task, CI, or no established task owner, keeping evidence and uncertainty explicit.
A close report is a lead, not a current process reading or authority to rerun its stop command.
Programs of open tasks and CI are named with their owner, never offered as picks, even if idle.
An uncertain program might belong to open work: name that uncertainty and do not offer it until resolved.
Programs genuinely outside task ownership may be offered, never recommended, with what they do and the cost of stopping them.
Unowned does not mean idle or abandoned: the captain’s interactive agent sessions in another terminal tool can be live work.
State that stopping such a session interrupts that work and may lose unsaved progress; if its role or stopping cost cannot be established, name the uncertainty and do not offer it.
Do not offer macOS services that need an administrator password, or the app and programs this look needs to remain reachable.
Report missing access rather than bypassing it.

## One card, grouped by task

If there is nothing eligible to offer, show no cleanup card: report what holds memory, the evidence and any visibility gaps.
Otherwise lead with what can be freed, honestly estimated, and show one card grouped by finished task, then programs no task owns.
For each item say what it is, its measured memory or unknown, the ownership evidence, what stopping it interrupts, and whether you will delete something created for a finished task or merely stop something borrowed.
Show open-task and CI owners separately as information, without controls.
Use short plain labels and a compact table or still figure for the owners and memory; follow the app’s card and design rules, not a new screen.

Give every candidate a stable checkbox value and an associated label, all under a fieldset whose legend asks what to stop.
Leave every checkbox unchecked; mark eligible finished-task leftovers data-inf-recommended, but never mark unowned programs recommended.
This is a closed list of measured candidates, so use data-inf-options-only: a new candidate needs another read, not a free-form stop command.
The footer offers Stop selected and Leave running; the body’s controls send nothing and stop nothing.
Mark Stop selected with allows, naming the offered candidates, their stopping/deletion costs, and that the permission covers only the captain’s explicit picks for the rest of this task.
An empty selection stops nothing.
Keep the mapping from stable values to program identity, start time, ownership evidence, stop method and created or borrowed resources in private task evidence.
Never interpret an unchecked recommendation, Got it, a dismissal or permission to look as a selection.

## Stop only the submitted picks

Read the actual submitted values; never fill in defaults or widen a pick to other programs sharing a name.
Immediately before each stop, re-read the program’s start time and identity, its owner’s current task status and any shared dependents.
Use `ps -p <pid> -o lstart=,command=` to compare a process’s start time and executable with your saved reading; for a managed resource also recheck its stable manager identifier and backing process.
A reused process number, changed identity, newly active owner or new dependent invalidates that pick: leave it running and report why.
If a tool cannot establish identity safely, do not stop it; report the gap rather than acting on a name alone.

Use the program’s graceful stop or shutdown command scoped to that exact identity; never broad pkill, killall, a wildcard, or a runtime-wide shutdown for a single selected guest.
If the command fails or the result is unknown, re-read status and report it; do not escalate to a force stop or repeat an uncertain effect without new permission.
Delete only the exact disposable resource a finished task created when its deletion was disclosed in the selected item.
Only stop what a task borrowed; never delete shared disks, images, volumes, simulator sets or personal data.
A selected unowned program is stopped, not deleted, unless the captain separately authorizes deletion.

Recheck all offered identities, selected and unselected, and take another pressure and memory reading.
Report which selections stopped, which remained and why, that unselected programs were left alone, and the observed memory change without promising it all came from these stops.
Keep evidence of the before reading, selection, identity check and after reading.
Stop and remove this look’s own disposable proof resources before closing; use registered stops for anything the look itself starts.
The first mate receives the result on this task, not through another cleanup task.
