/**
 * INF-880: the general validation resource rule, served on every tier.
 * Every consent it asks for stands for the rest of the task (INF-1540's
 * direction 3: "making such consent task-wide by default makes sense").
 * INF-3170 piece 2: the consent it asks is kept from the captain's click on
 * the marked yes and served back as the Already allowed list.
 */
export const RIGOR_SAFETY =
  "Validation may use what it truly needs, the real app, service or device included. Prefer disposable data, accounts, isolated app homes, local instances, simulators, workspace-local tools; stop what you start and delete what you made before the task closes. Before anything sensitive or costly - the captain's sign-ins or accounts, plan allowance or money, real data or production, keychain or signing access, credential access, or anything others can see - ask for consent on a card unless a captain-origin project direction's words or the served Already allowed list cover it. A Careful task's exact validation effect still needs independent review; name it through the careful-change skill. Name the resource, check and possible cost or change; mark yes with allows and coverage so the app keeps the click. Use a named sign-in through the program that holds it. Ask each consent for the rest of this task, saying so; approval covers the named use for every later check, run or version of this task, not other sign-ins or unrelated resources. Covered uses are not re-asked; write approvals and browser handoffs still apply. Keep secrets off command lines and out of printed output. When a check needs something you cannot run, report needs_firstmate asking the first mate to coordinate it. If still blocked, name the check, why and what you tried; never drop it.";
