# The first mate offers the Allow card for a private site

INF-3116 piece 2, built on the plan the captain approved: task browsers on every computer may reach the private sites the captain lists in Settings → General → Private sites.
`app_change` gains one line in the `general` area, `private-site-allow` (hands), which takes `site`, a name or a suffix of two or more parts and never an address.
The host writes the card, "Let task browsers reach wiki.corp.example?" with Allow and Not now, and only the captain's Allow click adds the site, landing on Settings → General with it listed; the first mate never adds one itself.
The line tells the first mate to offer it when a crewmate's report or the captain names a private site the task needs, and what a listed site reaches: https or http from any page, never loopback, link-local or cloud metadata addresses.
The line itself is read through `app_state`; only the action's name joins `app_change`'s list of actions in the fixed context.
