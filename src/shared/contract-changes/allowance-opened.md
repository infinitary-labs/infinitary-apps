# Allowance opened

Adds the core request `inf:quota:opened`, which a view sends when the person opens Subscriptions.
The home reads every allowance it reads only on the person's press, such as Antigravity's usage report, and answers with the quota snapshot.
An older home has no such request, so a view's call fails and the view keeps the snapshot it already holds.
