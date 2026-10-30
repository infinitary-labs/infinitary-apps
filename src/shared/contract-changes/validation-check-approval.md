# Validation check approval

A card's `validationDecision` order may carry `gaps`, further gap requests of the same version that the home draws as one checklist (INF-1824).
A live-validation check may declare `resources` and `cost`, and a validation request may be of kind `check`.
An older home ignores `gaps` and shows only the first gap, and refuses a check request or a check that declares resources; the crewmate then asks as it did before.
