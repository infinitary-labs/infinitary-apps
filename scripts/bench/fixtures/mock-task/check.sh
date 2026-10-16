#!/bin/sh
# The stub verifier's check for the dry-run task, run in the patched checkout.
test "$(cat answer.txt 2>/dev/null)" = "forty-two"
