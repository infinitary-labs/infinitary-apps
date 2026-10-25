#!/bin/bash
# The Ubuntu and Fedora packages' removal script (electron-builder.linux.yml):
# electron-builder 26.15.3's own templates/linux/after-remove.tpl, with one
# steps added after its command link, marked below. electron-builder fills in
# each dollar-brace name it knows and refuses any other, so the added step
# writes its shell variables without braces.

# Delete the link to the binary
# update-alternatives --remove <name> <path>: 'path' must be the registered alternative binary,
# not the generic symlink — see https://man7.org/linux/man-pages/man1/update-alternatives.1.html
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# Added: the links after-install.tpl left at Firstmate 3000's program path go
# with this package on a removal alone - the Ubuntu package's remove or
# purge, the Fedora package's 0 - never on an upgrade, and only while they
# still lead into this package's folder (docs/linux-packages.md, "The old
# program path").
case "$1" in
    0|remove|purge)
        for OLD in /usr/bin/firstmate-3000 /opt/firstmate-3000/firstmate-3000; do
            case "$(readlink "$OLD" 2>/dev/null)" in
                '/opt/${sanitizedProductName}/'*) rm -f "$OLD" ;;
            esac
        done
        rmdir /opt/firstmate-3000 2>/dev/null || true
        ;;
esac

# Added: the inbox's command link after-install.tpl made goes on a removal
# alone, and only while it still leads into this package's folder
# (docs/linux-packages.md, "The inbox's command").
case "$1" in
    0|remove|purge)
        case "$(readlink /usr/bin/infinitary-inbox-axi 2>/dev/null)" in
            '/opt/${sanitizedProductName}/'*) rm -f /usr/bin/infinitary-inbox-axi ;;
        esac
        ;;
esac

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove and unload apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  # Unload the profile from the running kernel before deleting the file so the
  # policy is not left enforced until the next reboot.  Mirror the chroot guard
  # used in the after-install script — live AppArmor operations are not
  # meaningful inside a chroot.
  # https://wiki.debian.org/AppArmor/HowToUse
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi