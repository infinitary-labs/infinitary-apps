# A reported step closes as answered, and a read outcome gets no second note

INF-1137 friction 4, which the captain chose to start now: the first mate posted 18 merged, dropped or released notes, five of them right after the captain had closed the crewmate's own outcome card, and two finished investigations (INF-1121, DOP-60) were announced as dropped.
Both investigations were internal steps whose answers the first mate passed on by a steer to a task already under way, so no task named them as basis, `settle_task answered` was refused, and the first mate discarded them.
`settle_task` mode `answered` now also closes an idle internal step once its crewmate reported its answer, with no task built on it required; the close is `done/answered` and Activity reads "Answered: its crewmate reported the answer".
A step with no report is still refused, and a basis or a blocks link still comes first, naming where the answer carries on.
The tool's description says so in one clause: "or once it reported its answer".
The host no longer puts up the first mate's closing note when the crewmate reported its work finished, which it does only after the captain closed its outcome card: their close already said what became of the work.
That rule lives in the host, so the contract gains no words for it.
The new words cost the fixed part 8 tokens by the app's count: it measures 19,769, up from 19,761, inside the boundary of 19,772.
