# Google as an integration

`inf:integrations:sign-in` is a new home-only change: it signs in to a kind that signs in in the person's browser, Google, and answers the new row's id with the integrations view once the browser comes back (`docs/integrations.md`, "Google").
`inf:integrations:sign-in-cancel` is a new home-only change that ends that sign-in while it waits.
The integrations view admits the kind `google`.
Every integrations request is answered only on the home, since its reach is the home, so no paired device asks for the view or sends the change.
The `inf:integrations` push still reaches a paired device unchecked, and an older view that draws it shows Google's row the way it shows GitHub's, with no way to sign in to it.
