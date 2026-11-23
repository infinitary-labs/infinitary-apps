---
source: 6298f79a1d1c8bf2
title: Ein Computer ohne Bildschirm
description: Starte Infinitary per Befehl auf einem Linux-Server oder einem anderen Computer, an dem niemand sitzt, damit dein erster Offizier dort lebt, und steuere ihn von deinem Mac, Linux-Computer oder Windows-PC aus.
---

Dein erster Offizier kann auf einem Computer leben, an dem niemand sitzt, etwa einem Linux-Server, den du mietest oder zu Hause betreibst.
Dort läuft Infinitary ohne Fenster und wird per Befehl gestartet.
Du steuerst deinen ersten Offizier von einem anderen Computer aus: einem Mac, einem Linux-Computer oder einem Windows-PC.

Es braucht vier Schritte auf dem Computer ohne Bildschirm, dann zwei auf deinem anderen Computer:

1. Installier Infinitary dort.
2. Starte es mit einem Befehl.
3. Lass deinen anderen Computer herein.
4. Erstell einen Link.
5. Füg den Link in Infinitary auf deinem anderen Computer ein.
6. Verbinde ein Abo von deinem anderen Computer aus.

## Was du brauchst {#what-you-need}

- **Einen Linux-Computer mit x64-Prozessor und systemd**, etwa mit Ubuntu oder Fedora.
  Unter Ubuntu 24.04 oder 26.04 und unter Fedora bringt das Paket alles andere mit, was Infinitary dort braucht.
- **Ein gewöhnliches Konto dort, nicht root.**
  Melde dich für jeden der folgenden Schritte per SSH bei diesem Konto an.
- **Ein Netzwerk, in dem beide Computer sind.**
  Infinitary öffnet einen Computer nie zum Internet, also bring beide Computer in dasselbe private Netzwerk, etwa Tailscale, außer sie teilen sich ein lokales Netzwerk.
- **Infinitary auf deinem anderen Computer, noch nicht eingerichtet.**
  Du trittst deinem ersten Offizier bei dessen erstem Start bei.
  Wenn du dort schon einen ersten Offizier eingerichtet hast, siehe [Wenn dein anderer Computer schon einen ersten Offizier hat](#if-your-other-computer-already-has-a-first-mate).
- **Ein KI-Abo.**
  Du meldest dich am Ende von deinem anderen Computer aus dabei an.
  Wenn du Claude nutzt, installier zuerst Claude Code auf dem Computer ohne Bildschirm.

## 1. Infinitary installieren {#1-install-infinitary}

Kopier auf der [Download-Seite](https://getinfinitary.com/downloads/#linux) den Link des Pakets für das System dieses Computers.
Lade es dann auf dem Computer ohne Bildschirm herunter und installier es.
Unter Ubuntu:

```sh
curl -LO <the link you copied>
sudo apt install ./infinitary-*.deb
```

Unter Fedora installierst du die .rpm-Datei genauso, mit `sudo dnf install ./infinitary-*.rpm`.
Das Paket installiert auch git und Xvfb, die Infinitary dort zum Laufen braucht.

Auf einem anderen x64-Linux-System lädst du das AppImage herunter und erlaubst ihm mit `chmod +x`, zu laufen.
Es braucht installiertes git, Xvfb und FUSE 2 sowie Bibliotheken, die ein Desktop hat und einem Server oft fehlen, etwa GTK 3.
Wo diese Seite `infinitary` sagt, tipp stattdessen den Pfad der AppImage-Datei ein.

## 2. Starten {#2-start-it}

Führ als das Konto, das deinen ersten Offizier ausführen soll, Folgendes aus:

```sh
infinitary start-at-boot
```

Infinitary startet jetzt, ohne Fenster, und wieder, sobald sich dieses Konto anmeldet.
Der Befehl sagt, wo du nachlesen kannst, was es meldet.

Damit es nach dem Abmelden weiterläuft und bei jedem Start des Computers startet, gibt der Befehl womöglich auch eine Zeile aus, die ein Administrator einmal ausführen muss:

```sh
sudo loginctl enable-linger <your account>
```

Führ diese Zeile aus, wenn sie erscheint.
Ob Infinitary läuft, prüfst du mit `infinitary status`.

Wenn Infinitary sagt, dass es Xvfb braucht, installier Xvfb mit der Software deines Systems und führ den Befehl dann erneut aus.
Wenn es sagt, dass der Computer für diesen Benutzer kein systemd hat, listet `infinitary help run` andere Wege auf, es zu starten.

## 3. Deinen anderen Computer hereinlassen {#3-let-your-other-computer-in}

Dein anderer Computer erreicht Infinitary über Port 47623.
Wenn dort eine Firewall aktiv ist, lass diesen Port einmal herein.
Mit ufw, wie unter Ubuntu:

```sh
sudo ufw allow 47623/tcp
```

Mit firewalld, wie unter Fedora:

```sh wrap
sudo firewall-cmd --permanent --add-port=47623/tcp && sudo firewall-cmd --reload
```

## 4. Einen Link erstellen {#4-make-a-link}

```sh
infinitary link
```

Er gibt einen Link aus, mit den Worten „Paste this link into Infinitary on your other computer, at its first launch.“
Der Link funktioniert einmal, zehn Minuten lang.
Führ den Befehl für einen neuen erneut aus.

## 5. Von deinem anderen Computer aus beitreten {#5-join-from-your-other-computer}

1. Öffne Infinitary zum ersten Mal auf deinem anderen Computer.
2. Wähl **Link einfügen**, füg den Link ein und drück **Weiter**.
3. Infinitary fragt einmal, ob du deinen ersten Offizier von dort aus steuern willst.
   Drück **Von hier aus steuern**.

Dein anderer Computer zeigt jetzt deinen ersten Offizier.
Seine Karten, Aufgaben und Unterhaltung bleiben auf dem Computer ohne Bildschirm.

Statt eines Links kannst du **Über die Adresse beitreten** wählen und die Adresse eintippen, mit der du dich per SSH bei diesem Computer anmeldest, etwa `you@vps`.
Infinitary bittet dann das dort laufende Infinitary von selbst um einen Link.
Von einem Windows-PC aus muss dieser Computer deinen SSH-Schlüssel hereinlassen, da ein Windows-PC nach keinem Passwort fragt.

## 6. Ein Abo verbinden {#6-connect-a-subscription}

Das Fenster sagt dann „Verbinde eins für deinen ersten Offizier auf“ und den Namen dieses Computers, und „Die Anmeldung läuft von hier aus.“
Wähl deinen Anbieter und melde dich so an, wie er es verlangt, auf dem Computer, an dem du sitzt.
Sobald ein Abo antworten kann, öffnet sich das Nachrichtenfeld und dein erster Offizier ist bereit.
Siehe [Der erste Start](/de/first-launch/#connect-a-subscription).

## Wenn dein anderer Computer schon einen ersten Offizier hat {#if-your-other-computer-already-has-a-first-mate}

Sobald auf einem Computer ein Abo antwortet, zeigt er seinen ersten Start nicht mehr und kann daher keinen Link einfügen.
Behalte stattdessen diesen ersten Offizier und zieh ihn auf den Computer ohne Bildschirm um:

1. Füg ihm den Computer ohne Bildschirm hinzu, wie unter [Einen Computer hinzufügen](/de/your-other-computers/#add-a-computer).
2. Wähl im Menü dieses Computers, den drei Punkten in seiner Zeile, [Deinen ersten Offizier hierher umziehen](/de/your-other-computers/#move-your-first-mate).

Seine Aufgaben, Karten und Unterhaltung ziehen mit.
Du meldest dich dort erneut bei deinen Abos an, und [Geheimnisse](/de/secrets/) bleiben auf dem Computer, den er verlässt.

## Aktualisieren {#update-it}

Installier das neue Paket genauso wie in Schritt 1.
Infinitary dort bemerkt die neue Version, stoppt und startet von selbst mit ihr neu.

## Stoppen {#stop-it}

```sh
infinitary start-at-boot --off
```

Das stoppt Infinitary dort und verhindert, dass es wieder startet.
Die gespeicherte Arbeit deines ersten Offiziers bleibt auf diesem Computer.

## Wenn etwas schiefgeht {#when-something-goes-wrong}

- **`infinitary link` sagt „Infinitary is not running here, as this user.“**
  Starte es wie in Schritt 2, als dasselbe Konto, und erstell den Link dann erneut.
- **Es sagt „Infinitary here controls your first mate on another computer.“**
  Dieser Computer ist schon einem anderen ersten Offizier beigetreten; erstell den Link stattdessen auf jenem Computer.
- **Dein anderer Computer erreicht die Adresse im Link nicht.**
  Prüf, ob beide Computer im selben privaten Netzwerk sind und ob Port 47623 hereingelassen wird, wie in Schritt 3.
- **Infinitary hat gestoppt und du weißt nicht, warum.**
  `infinitary status` sagt, warum es zuletzt gestoppt hat, und das Log, das `infinitary start-at-boot` genannt hat, sagt den Rest.

Siehe auch [Deine anderen Computer](/de/your-other-computers/) und [Fehlerbehebung](/de/troubleshooting/).
