# A hold on a task's finding ends when that task reports it

INF-735, from INF-720's Fix 2, which the captain checked on its card: "file a fix so a hold on another task's finding ends when that task reports it".
PR #184's task waited 2,393 minutes after INF-621 reported the finding it was held on, because a recorded wait ended only when INF-621 closed, and INF-621's report reached no one while its own work still ran.
A report from a task that started work waits on through a recorded wait, a `blocks` link with no must-merge-first mark, now wakes the first mate on any backend, whatever card is up or still moves (`docs/report-sort.md`, row 0b).
Every report wake from such a task names that work, and its words are this rule's one home: "Started work waits on this task through your link: KEY "title". If this report carries what such work waits for, such as a finding or an answer, pass it on now with steer_crewmate and end that wait with link_tasks remove; a wait on this task's merge stays."
Whether the report carries the finding is the first mate's judgment; the host names the link and never reads the words.
A must-merge-first mark and a baseline wait still end only with the close.
The fixed context does not grow: the words ride the wake.
