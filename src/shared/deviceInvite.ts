import { COMPUTER, HERE, PLACE_SAID } from "./deviceNames";
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
  return `Add a device when the captain asks: app_change offers the captain one card whose button makes it in Settings → Devices. When the captain names another ${COMPUTER.one} to use, such as a server, without saying where you, the first mate, should live, first say the two setups in one sentence each and ask which on one decision card: you stay on ${HERE.this} and that ${COMPUTER.one} runs work for you; or you live on that ${COMPUTER.one} and ${HERE.this} becomes a window that controls you there, which takes adding it here first and then the home-move offer once it is in reach. When they have not said which way to add it, never pick one for them: first ask them on one decision card, with every way as an option - the ${COMPUTER.one}'s address over SSH, a link, a command, or another user on ${HERE.this} - ${recommend}; say a link suits a ${COMPUTER.one} they sit at or a Windows PC, and a command one where they can type in Terminal but SSH is off; then pass their choice. how "address" with the address they gave, with the account name there, such as sam@mini.local: ${HERE.this} sets that ${COMPUTER.one} up over SSH with their own SSH key. When the address they gave has no account name, ask them for it before you offer, since SSH would otherwise sign in with their user name on ${HERE.this}, which a server rarely has. how "address" with no address, when they chose it without naming one: a card that opens the address form, with the ${COMPUTER.many} on their network to pick from. how "link" (the default): a one-use link to paste into Infinitary on a ${COMPUTER.one} they sit at. how "command": a command they run once in Terminal on a ${COMPUTER.one} with no screen, which gets Infinitary from ${HERE.this}. Each of those three adds a ${COMPUTER.one} that can control you from Infinitary opened there and can run the work of projects set to run on it. how "phone": a one-use link whose code they scan inside Infinitary on their phone, which then shows their cards. how "another-user": a command they run once as another macOS user on ${HERE.this}, so work runs as that user, with sign-ins of its own, and cannot control you; like every user on a ${COMPUTER.one}, that user can still read files in their home folder outside private folders such as Documents. Only the captain's click makes a link or a command, or reaches a ${COMPUTER.one}, and you never see a link or a command. Pass the ${COMPUTER.one}'s name as the captain said it.`;
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

/**
 * The device-invite card for an address: what the add makes (the first mate
 * stays here and that computer runs work for it), that it goes over SSH, and,
 * for an address with no account name, that SSH signs in with this
 * computer's user name unless the captain says another. Catalog words, so
 * each view words it in its own language.
 */
export function addressOffer(address: string) {
  const words = {
    title: said("devicesAddressCardTitle", { address }),
    paragraphs: [
      said("devicesAddressCardResult", { address, computer: PLACE_SAID.this }),
      said("devicesAddressCardSetUp"),
      ...(namesAccount(address)
        ? []
        : [said("devicesAddressCardNoAccount", { computer: PLACE_SAID.this })]),
      said("devicesAddressCardAsk"),
    ],
    label: said("devicesAddressCardAdd"),
    decline: said("devicesAddressCardNotNow"),
  };
  return {
    cardId: "app-device-invite",
    title: englishOf(words.title),
    paragraphs: words.paragraphs.map(englishOf),
    label: englishOf(words.label),
    decline: englishOf(words.decline),
    said: words,
    arrival: { add: address },
  };
}

/** Whether an address names the account to sign in as, as `sam@mini.local` or `ssh://sam@mini.local:2222` do. */
function namesAccount(address: string): boolean {
  return address.includes("@");
}
