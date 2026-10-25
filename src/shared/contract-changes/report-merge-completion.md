# A report declares whether a merge finishes the task

The `inf:work:report` order admits optional `declared.mergeCompletesTask`, naming the task's recorded PR number and checked head.
The home keeps this crewmate judgment until its next turn or report, and reconciles an externally confirmed matching merge only when no work remains in the task's typed state.
An older home ignores the field and retains its existing merge handling; an older computer never declares it, so the new home records an external merge without automatically closing the task and wakes its crewmate to decide what remains.
The declaration grants no permission to merge.
