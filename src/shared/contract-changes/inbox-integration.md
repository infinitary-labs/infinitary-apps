# The inbox as an integration

The integrations view admits the kind `inbox`, and an integration's row may carry `door`: the full line a program runs to drop an event, and where the short name's link stands (`docs/integrations.md`, "The inbox").
`inf:integrations:inbox-link` is a new home-only change that links the inbox's command into `/usr/local/bin` where that folder is free and writable, and answers the integrations view.
`inf:integrations:sign-in` takes the kind `inbox` too, and turns the inbox on at once.
The `inf:integrations` push still reaches a paired device unchecked, and an older view that draws it shows the inbox's row the way it shows another kind's, with no line to copy.
