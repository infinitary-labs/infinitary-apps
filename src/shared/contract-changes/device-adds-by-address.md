# The first mate's computer says when it cannot add a computer by its address

The answer to the device addresses read (`deviceAddressesSchema`) adds `addsByAddress: false` where the first mate's computer cannot add another computer by its address, as on a Windows PC.
A window then offers only the link and the command under **+ A computer**, instead of the address form.
A first mate from before has no field of that name, so its window keeps the address form it had.
A window from before this change never receives the field: its first mate's computer leaves it out of the read's answer, out of the answer to setting an address and out of the pushed addresses, so a strict older window still reads them.
