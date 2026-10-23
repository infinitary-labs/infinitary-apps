# Google's notice before its sign-in

`inf:integrations:sign-in` takes an optional second element, the person's accept of the kind's notice (`{ noticeAccepted: true }`, INF-949), and a kind with a notice, Google, signs in only with it (`docs/integrations.md`, "Google's notice").
The request's reach is the home, so only the home's own window sends it, and no paired device or computer that runs work ever does.
An older window on the same home would send no accept and be refused in words before any browser opens, but the home's window always comes from the same build.
