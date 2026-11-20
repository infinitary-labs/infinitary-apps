#!/bin/sh
# The Fedora package's %posttrans (electron-builder.linux.yml), run once its
# whole transaction is done. rpm runs this package's install script before
# it takes away Firstmate 3000's package, which this one replaces, and taking
# that package away deletes Firstmate 3000's program and command. So the
# links at that old program path are made here again, once it is gone: the
# same step as packaging/linux/scripts/after-install.tpl's (docs/linux-packages.md,
# "The old program path").
for OLD in /opt/firstmate-3000/firstmate-3000 /usr/bin/firstmate-3000; do
  case "$(readlink -f "$OLD" 2>/dev/null)" in
    /opt/infinitary/*) ;;
    *) if [ -e "$OLD" ]; then continue; fi ;;
  esac
  mkdir -p "$(dirname "$OLD")"
  ln -sfn /opt/infinitary/infinitary "$OLD"
done
exit 0
