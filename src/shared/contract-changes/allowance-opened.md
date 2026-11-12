# Allowance opened

Adds the core request `inf:quota:opened`, which a view sends when the person opens Subscriptions.
The home answers with the quota snapshot it holds, since no allowance is read only on the person's press any more.
An older home has no such request, so a view's call fails and the view keeps the snapshot it already holds.
