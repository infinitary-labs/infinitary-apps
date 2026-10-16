# Selective filing and the after-merge check

FI3-868, grounded on FI3-845 (the captain's "Apply cleanup and selective filing" on its backlog assessment).
The assessment found crew filings arriving faster than they closed, most of them real but many optional, kept with a verdict that said only "not blocking", all at one priority, and some already met by later merges.
Crewmates are now told that only some of what they discover is filed: a concrete defect they can show on the current main line, or a credible risk to the person's data, accounts, signing material or merges.
An optional improvement stays in the report, unfiled; work the crewmate's own change needs, and the documents it makes stale, stay with that change; only the rest of its own work that must wait for a merge is a `Continue: …` filing.
A crewmate that finds a matching task names what its finding adds to it, and one whose change meets another open task's whole goal names that key and the evidence in its report.
`file_followup`'s description says what it is for, and its `why` asks for the evidence, what it breaks and for whom, and what the crewmate is unsure of.
The Firstmate's filing rule now has it search for repeats first and drop one as covered once anything it adds is in the kept task's goal, keep a filing with a verdict and the priority it deserves, and offer optional ideas only when they merit the captain's choice, together in one decision card once that task closes.
After a merge succeeds it checks the open tasks the merged task's report says it covers, and drops one as covered only when it never started and the merge met its whole goal, removing its blocks links first; partial or unsure ones stay, with a verdict.
A release review names each key it checked, its fate, and the keys left unchecked.
`update_task`'s `verdict` asks what waiting costs and who pays it, and what would start the filing; its `reason` names covered work by the key that covers it.
Nothing in the host changes: it still files whatever a crewmate files, and no queue, timer, expiry or count decides what stays.
The new words cost the fixed part about 142 tokens by the app's count; with them it measures 18,142, so the budget moves from 18,000 to 18,500, and the core's size band from 15,200 to 15,800 characters.

The ledger entry that comes with it:

FI3-868, grounded on FI3-845 (the captain's Apply cleanup and selective filing). Crewmates file defects they can show and credible safety risks, keep optional ideas in the report, finish the work their own change needs, and name the open tasks a change fully covers.
The Firstmate drops repeats as covered, keeps a filing with a verdict and a real priority, offers optional ideas together when they merit the captain's choice, checks what a merge covered, and has a release review name the keys it checked.
