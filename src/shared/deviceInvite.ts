import { COMPUTER, HERE } from "./deviceNames";
import { englishOf, said } from "./i18n/said";

/**
 * The device-invite line: the address is the way to recommend, since the
 * home keeps that computer updated by itself, except on a Windows PC, which
 * adds no computer by its address and recommends the link instead.
 */
export function deviceInviteLine(windows: boolean): string {
  const recommend = windows
    ? // i18n-exempt: served only to the first mate, which stays English
      `leaving the address out, since ${HERE.this} is a Windows PC, which adds no ${COMPUTER.one} by its address, and recommending a link`
    : // i18n-exempt: served only to the first mate, which stays English
      `recommending the address, because ${HERE.this} then keeps that ${COMPUTER.one} updated and reaches it by itself, with no visit there after setup`;
  // i18n-exempt: served only to the first mate, which stays English
  return `Add a device when the captain asks: app_change offers the captain one card whose button makes it in Settings → Devices. When they have not said which way, never pick one for them: first ask them on one decision card, with every way as an option - the ${COMPUTER.one}'s address over Remote Login, a link, a command, or another user on ${HERE.this} - ${recommend}; say a link suits a ${COMPUTER.one} they sit at or a Windows PC, and a command one where they can type in Terminal but Remote Login is off; then pass their choice. how "address" with the address they gave, such as sam@mini.local: ${HERE.this} sets that ${COMPUTER.one} up over Remote Login with their own SSH key. how "address" with no address, when they chose it without naming one: a card that opens the address form, with the ${COMPUTER.many} on their network to pick from. how "link" (the default): a one-use link to paste into Infinitary on a ${COMPUTER.one} they sit at. how "command": a command they run once in Terminal on a ${COMPUTER.one} with no screen, which gets Infinitary from ${HERE.this}. Each of those three adds a ${COMPUTER.one} that can control you from Infinitary opened there and can run the work of projects set to run on it. how "phone": a one-use link whose code they scan inside Infinitary on their phone, which then shows their cards. how "another-user": a command they run once as another macOS user on ${HERE.this}, so work runs as that user, with sign-ins of its own, and cannot control you; like every user on a ${COMPUTER.one}, that user can still read files in their home folder outside private folders such as Documents. Only the captain's click makes a link or a command, or reaches a ${COMPUTER.one}, and you never see a link or a command. Pass the ${COMPUTER.one}'s name as the captain said it.`;
}

/**
 * The device-invite card for the address chosen without one: it opens + A
 * computer's address form, with the computers nearby to pick from, and keeps
 * its catalog words so each view words it in its own language.
 */
export function addressFormOffer(name: string | null) {
  const words = {
    title: name
      ? said("devicesAddressFormTitleNamed", { device: name })
      : said("devicesAddressFormTitle"),
    paragraphs: [said("devicesAddressFormSetUp"), said("devicesAddressFormOpen")],
    label: said("devicesAddressFormOpenButton"),
    decline: said("devicesAddressFormNotNow"),
  };
  return {
    cardId: "app-device-invite",
    title: englishOf(words.title),
    paragraphs: words.paragraphs.map(englishOf),
    label: englishOf(words.label),
    decline: englishOf(words.decline),
    said: words,
    arrival: { addressForm: true as const },
  };
}
