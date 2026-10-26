# Handed-on results close as done

INF-1426 implements the captain's Start now choice on INF-1389 finding 4.
The `settle_task` description owns the instruction to use answered for reported, idle results handed on through verified file delivery or a result-card choice, and never discard completed results.
The task owner records those receipts without interpreting report prose or action labels.
The settle owner keeps open questions, relationships, pending work, proposed changes and unmerged work from being bypassed.
A plain result choice on a change task records a receipt but does not stop its crewmate; the first mate still judges completion after its report.
The new clause replaces the earlier internal-step explanation rather than adding a second instruction.
The replacement adds about three tokens to the fixed context and fits its existing budget (`tests/firstmate-fixed-context.test.ts`).
