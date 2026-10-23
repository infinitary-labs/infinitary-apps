# A model named for started work moves the task

INF-849, approved by the captain with "Approve and build" on direction A: "this card should display task key, not crewmate number. also, it should offer an option to swap the crewmate to a different provider".
Before, update_task refused a model on started work, so the first mate filed a new task under a new key to change a crewmate's provider.

update_task's `override_model_id` on started work now moves the task to that model between turns: same key, branch, working copy and record, with the routing and account records and a history line saying the first mate moved it.
A crewmate mid-turn moves once its turn ends; a model that cannot serve is refused as text and nothing changes.
Its one home is that parameter's description; update_task's own model rule now reads for any task, filed or started.
The reworded words cost no tokens: the fixed context still measures 19,772, at its derived boundary.
