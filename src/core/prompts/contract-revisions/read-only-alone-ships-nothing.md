# Only read-only makes a task ship nothing

INF-990 friction 7, the captain's choice "Replace PR #376 with the cleaner fix": INF-945 was a build whose goal asked for a preview first, the classifier called it a plan, its brief said answer only, and the captain's choice on the preview closed the build mid-work.
For work the first mate commissions, the host no longer reads the deliverable off the classifier's kind: the typed `read-only` constraint is the only thing that makes a task an answer, and the kind only routes (`deliverableFor`).
The constraints parameter's description now says a task without read-only ships a change; that description is the rule's one home.
The sequences document marks a research step read-only beside the plan, reproduce and retrieval steps, and its retrieval line says read-only once instead of "pass typed read-only", so the fixed context stays inside its boundary (`tests/firstmate-fixed-context.test.ts`).
