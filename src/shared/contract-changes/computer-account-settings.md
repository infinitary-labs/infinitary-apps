Adds the orders `inf:sign-ins:rename`, `inf:sign-ins:set-enabled` and `inf:sign-ins:pin`, which rename, pause or resume, and prefer one of a computer that runs work's own accounts, saved only on that computer.
Adds the order `inf:sign-ins:read-allowance`, which has that computer read its accounts' allowance now.
Adds an optional last element to `inf:accounts:rename`, `inf:accounts:set-enabled`, `inf:accounts:pin`, `inf:accounts:remove` and `inf:forges:sign-out`, the computer that runs work whose account or sign-in it is.
Adds an optional `accountSettings` field to each computer of `inf:devices:sign-ins`, saying it takes the new orders.
A computer without the change is never sent the new orders: the home shows its items dim, saying to update Infinitary there, and a refresh only asks it for its sign-ins again.
A home without the change never says `accountSettings`, so a view sends it no computer.
