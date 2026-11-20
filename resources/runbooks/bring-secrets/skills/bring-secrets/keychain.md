# The macOS Keychain

A password the captain keeps in the login keychain is printed by `security find-generic-password -s '<service>' -a '<account>' -w`, or `find-internet-password` with `-s '<server>'` for a website's password.
Only a bring runs that command; never run it, or anything with `-w`, `-g` or `dump-keychain -d`, in your own shell.

This recipe has not been tried through a bring yet, so say in your report what happened at each step.

## Names

Move the items the captain names, by service (or server) and account.
To confirm an item exists, run the same command without `-w` or `-g`: `security find-generic-password -s '<service>' -a '<account>'` prints the item's attributes and never its password.
Never list the whole keychain.

## Bring

One bring per item, read as one value with its line end dropped:

```sh
infinitary-secrets-axi bring --id keychain-npm --reason 'Move the npm token the captain keeps in the Keychain into Secrets' --from '{"tool":"macOS Keychain","source":{"run":["/usr/bin/security","find-generic-password","-s","npm","-a","me","-w"]},"reads":"value","trim":"newline","secrets":[{"name":"NPM_TOKEN"}]}'
```

The Keychain item has no variable name: choose the name a program reads it by, such as `NPM_TOKEN`, or the one the captain gave, and a project's place where it belongs.
macOS may show its own window asking whether `security` may use the item; the captain answers it there, and Allow is enough.
A password that is not text arrives from `security` as hexadecimal digits, which a program cannot use: report it rather than bringing it.
