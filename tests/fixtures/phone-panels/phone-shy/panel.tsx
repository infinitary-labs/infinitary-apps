import type { PanelProps, StoreValue } from "@infinitary/contracts";
import { useEffect, useState } from "react";

/**
 * The phone's panel that decides for itself whether it shows (ios/Infinitary/InfinitaryUITests/PhoneJourney+Panels.swift,
 * INF-3830 piece 2, the captain's answer W3 (c)): it is on its rail only while its own store's "show" is true, so the
 * phone's Panels tab appears only once it says it shows, and leaves when it says it does not. It writes what it said to
 * its store, so the computer hears that its page ran on the phone.
 */
export default function Panel({ id, rail, store }: PanelProps) {
  const [show, setShow] = useState<StoreValue | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = () => void store.get("show").then((value) => live && setShow(value));
    read();
    const off = store.subscribe(() => read());
    return () => {
      live = false;
      off();
    };
  }, [store]);
  useEffect(() => {
    if (!rail) return;
    const shown = show === true;
    if (shown) rail.show(true);
    else rail.show(false, "Nothing to show yet");
    // What it said goes to its store too, so the computer hears that its page ran.
    void store.set("said", shown);
  }, [rail, show, store]);
  return (
    <p data-fixture={id} style={{ margin: 0 }}>
      Shy is showing
    </p>
  );
}
