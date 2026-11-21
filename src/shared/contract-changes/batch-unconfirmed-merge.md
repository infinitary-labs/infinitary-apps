An open batch takes an optional `unconfirmed`: the version a merge was sent at whose outcome the host did not confirm, on a host whose merge names no version, with the host's own reference to that merge when it gave one.
The home reads how that merge ended on later passes and never sends it again.
A side without it reads the batch as checking, as before.
