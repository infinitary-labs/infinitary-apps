# Connecting and removing a device is a card the host builds

FI3-683, multi-machine piece 5, built on the design the captain agreed on FI3-681 and FI3-682 (`components/devices/DevicesTab`).
Settings gains a Devices tab, and asking Firstmate to connect a Mac, or to remove one, now yields one card whose button acts there.
`device-invite` and `device-remove` move from tier `yours` to `hands` with Settings -> Devices as their handover, so `app_change` answers the Firstmate by filing that card instead of only explaining the control.
The host writes each card from typed facts - the Mac's name as the captain said it for `device-invite`, the list's own entry for `device-remove` - so its button does what its words say, and the Firstmate still can neither make a link nor remove a device.
`device-invite`'s value is now `{ name? }` instead of `{ kind }`, and both lines say what the Firstmate is to pass.
A new `hands` line, `device-address`, names where devices find this Mac, so the `app_change` enum gains one name.
The lines are read through `app_state`, so the fixed context grows only by the one enum name.

The ledger entry that comes with it:

FI3-683, multi-machine piece 5. device-invite and device-remove are hands actions handed over to Settings -> Devices: app_change files one host-built card - Connect your <Mac> with Make a link, or Remove <Mac>? with a danger Remove <Mac> - whose click makes the link or removes the device there, so no link reaches a card or a conversation.
device-invite takes the Mac's name; device-address joins the catalog enum as the hands line for where devices find this Mac.
