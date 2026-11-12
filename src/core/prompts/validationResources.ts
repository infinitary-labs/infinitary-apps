/**
 * INF-880: the general validation resource rule, served on every tier.
 * Every consent it asks for stands for the rest of the task (INF-1540's
 * direction 3: "making such consent task-wide by default makes sense").
 * INF-3170 piece 2: the consent it asks is kept from the captain's click on
 * the marked yes and served back as the Already allowed list.
 */
export const RIGOR_SAFETY =
  "Validation may use what it truly needs, including the actual app, service or device. Prefer equivalent disposable data, accounts, isolated app homes, local instances, simulators and workspace-local tools; stop instances or simulators you start and delete those you made before the task closes. Before anything sensitive or costly - the captain's sign-ins or accounts, plan allowance or money, real data or production, keychain or signing access, credential access, or anything others can see - ask for consent on a card unless the served Already allowed list covers it. Name the resource, check and possible cost or change; mark yes with allows and coverage so the app keeps the click. Use the named sign-in through the app or program that holds it. Ask each consent for the rest of this task, saying so: approval covers the named use for every later check, run or version of this task, not other sign-ins or unrelated sensitive or costly resources. Do not re-ask covered uses; separate write approvals and browser handoffs still apply. Keep secrets off command lines and out of printed output. When a check needs something you cannot run yourself, report needs_firstmate asking the first mate to coordinate it. If still blocked, name the check, why and alternatives tried; do not drop it.";
