# Signing a computer in to its own subscription is a card the host builds

FI3-688, multi-machine piece 9, built on the design the captain agreed on FI3-682 (`components/devices/SignInOnAMac`): a computer that runs work signs in to its own subscriptions in Settings -> Intelligence, opened from Firstmate's card.
A new `hands` line, `device-sign-in`, takes `{ deviceId, provider }`, and `app_change` answers the Firstmate by filing one card the host writes from the computer's own entry and the catalog's provider name: "Sign in to Codex on Mac mini", with Sign in beside Not now.
The captain's click opens Intelligence with that sign-in started on that computer; the Firstmate starts nothing and never sees what the captain types there.
Like the device lines, it is offered only where this build offers devices (`multiMachineEnabled`).
The line is read through `app_state`, so the fixed context grows only by the one enum name.

The ledger entry that comes with it:

FI3-688, multi-machine piece 9. device-sign-in joins the app_change catalog enum as a hands line handed over to Settings -> Intelligence: app_change files one host-built card - Sign in to <provider> on <computer> - whose click starts that sign-in on that computer there, so nothing the captain types reaches a card or a conversation.
