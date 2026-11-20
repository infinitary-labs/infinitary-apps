# Adding a Mac by its address over Remote Login, and updating Firstmate there

FI3-692, multi-machine piece 13, built on the design the captain agreed on FI3-682 (`components/devices/AddAMac`, "By its address"): this Mac reaches another Mac with the captain's own SSH key, in batch mode, copies its own Firstmate there, and has it join as a computer that runs work.
The `device-invite` line takes `how: "address"` with `address`, the address the captain gave, such as `sam@mini.local`; `app_change` files one card the host writes, "Add the Mac at sam@mini.local", with Add it, and only the captain's click reaches that Mac, from Settings -> Devices.
A new `device-update` line offers the same kind of card for a Mac added by its address, "Update Firstmate on Mac mini", with Update it: the click copies this Mac's Firstmate there again and starts it.
It refuses a Mac added any other way, which the home cannot reach.
A value a hands line does not read is now refused as `app_change`'s answer instead of being offered as the line's default card, so an address that is not one never becomes a card for a link.
Like every device line, both are offered only where this build offers devices (`multiMachineEnabled`), and both are read through `app_state`, so the fixed context does not grow.

The ledger entry that comes with it:

FI3-692, multi-machine piece 13. device-invite gains how "address" with the captain's address, a host-built card whose click adds that Mac over Remote Login in Settings -> Devices; device-update offers the card that updates Firstmate on a Mac added that way; a hands line refuses a value it does not read instead of offering its default card.
