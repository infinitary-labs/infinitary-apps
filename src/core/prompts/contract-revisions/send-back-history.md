# A sent-back change keeps its approval and carries its history

INF-5097 piece 1, from the captain's approved plan for changes that bounce between batches, with their answer Keep on whether an approval survives a send-back.
A change sent back from a batch of the captain's own now keeps the captain's merge approval, as the only change of a failed batch does: its crewmate repairs it and declares the repair with check_change conflictRepair, an unchanged repair goes back in line once its branch's checks pass, and a changed one comes back to the captain on a new merge card.
The first mate is told so beside that wait: `FAILED_BATCH_NOTE` now names a batch that failed with the change alone or sent it back, and still says never to offer or ask for Merge anyway there.
The `batch-held` wake now lists each change's earlier send-backs from batches, with the checks that never ran there, and asks the first mate to put them in the repair's brief.
The app counts nothing and decides nothing from that history; the repair and the crewmate judge it.
The rule's homes are that wait's words, the `batch-held` wake, the batch-repair skill and check_change's `batch` parameter, whose send-back now says the change keeps its approval, with its two repair outcomes; the core is unchanged.
The fixed context does not grow: the words ride only those wakes.
