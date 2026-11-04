# Panel arrangement

Adds the optional field `arrangement` to the layout that `inf:settings:layout:get` answers, `inf:settings:layout:set` takes and `inf:shell:preferences` pushes: every panel's slot on the rails and its order there (INF-2344).
Adds the optional field `morePick` beside it, the panel last chosen from a full rail's More row.
Adds an optional second part to `inf:settings:layout:set`, `{ moved }`, the one panel the captain's own write moved, which the Activity line names.
A layout set without `arrangement` keeps the saved one, so an older side that sends the layout it knows moves no panel.
An older reader ignores both fields and places each panel from `placements` and `panelOrder` as before, which the core no longer writes.
