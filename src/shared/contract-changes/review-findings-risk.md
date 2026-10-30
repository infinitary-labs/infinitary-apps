# Review findings and risk

The typed review record (`validationReviewSchema`) gains two optional fields: `findings`, the typed findings the code judgment rests on, and `risk`, the reviewer's risk level with one sentence why.
A change version's review (`changeReviewSchema`) gains the optional `findings` the host read for it.
An older side leaves them out and reads a review with no findings and no risk, as before.
