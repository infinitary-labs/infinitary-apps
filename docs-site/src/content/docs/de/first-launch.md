---
source: c16d193883332656
title: Der erste Start
description: Was Infinitary beim ersten Öffnen zeigt, wie du wählst, wo dein erster Offizier lebt, wie du ein Abo verbindest und wie du dein erstes Projekt hinzufügst.
---

Prüf vor dem Start, [was du brauchst](/de/install/).
Diese Seite führt durch das erste Öffnen von Infinitary und zeigt, was sich danach ändert.

## Was das Fenster zeigt {#what-the-window-shows}

Wenn du Infinitary zum ersten Mal öffnest, begrüßt dich dein erster Offizier in der Mitte des Fensters.
Darunter steht **Willkommen an Bord von Infinitary, Kapitän**, mit einer Zeile von deinem ersten Offizier:

> Ich bin dein erster Offizier.
> Ich helfe dir, den Rest der Crew zu führen.

Dann fragt dein erster Offizier, wo er wohnen soll:

> Wo soll ich wohnen?
> Wähl einen Computer, der möglichst immer eingeschaltet bleibt.

Es folgen drei Möglichkeiten, und jede sagt, was sie bewirkt:

- **Dieser Computer**: Du meldest dich hier bei einem Abo an, und dein erster Offizier wohnt und arbeitet auf diesem Computer.
- **Ein anderer Computer**: Dein erster Offizier läuft auf einem anderen Computer, und du steuerst ihn von diesem aus.
- **Einer, der schon läuft**: Du verbindest dich mit einem ersten Offizier, der schon auf einem anderen Computer läuft, und steuerst ihn von hier aus.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="Der erste Start: der erste Offizier in der Mitte des Fensters, die Willkommensworte, die Frage, wo er wohnen soll, und die drei Möglichkeiten „Dieser Computer“, „Ein anderer Computer“ und „Einer, der schon läuft“ über dem abgeblendeten Nachrichtenfeld." width="1233" height="694" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="Der erste Start: der erste Offizier in der Mitte des Fensters, die Willkommensworte, die Frage, wo er wohnen soll, und die drei Möglichkeiten „Dieser Computer“, „Ein anderer Computer“ und „Einer, der schon läuft“ über dem abgeblendeten Nachrichtenfeld." width="1233" height="694" />

Wähl eine Möglichkeit, um sie zu öffnen.
Über die Tastatur erreichst du mit der Tabulatortaste jede Möglichkeit, die Pfeiltasten wechseln zwischen ihnen, und die Eingabetaste oder die Leertaste öffnet eine.
**‹ Wo ich wohne** über einer geöffneten Möglichkeit bringt dich zurück zu allen dreien.
Unter den Möglichkeiten sagt dein erster Offizier, dass du ihn später unter Einstellungen → Geräte auf einen anderen Computer umziehen kannst.

Das Nachrichtenfeld unten ist abgeblendet und sagt „Verbinde zuerst ein Abo“.
Nichts anderes funktioniert, bis ein Abo deinem ersten Offizier antworten kann.

## Ein Abo verbinden {#connect-a-subscription}

Wähl **Dieser Computer**, damit dein erster Offizier hier bleibt.
Für jeden Anbieter, den dein erster Offizier nutzen kann, erscheint eine Schaltfläche: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock und Eigene API.

1. Wähl die Schaltfläche deines Anbieters.
2. Melde dich so an, wie dieser Anbieter es verlangt.
   Manche öffnen die Anmeldeseite in deinem Browser.
   Copilot und Kimi Code zeigen einen Code: Drück **Code kopieren** und gib ihn dann auf der Seite des Anbieters ein.
   OpenRouter nimmt einen API-Schlüssel, den du einfügst.
   Bei Amazon Bedrock wählst du eine Region und nutzt ein AWS-Profil auf diesem Computer oder fügst einen Bedrock-API-Schlüssel ein.
   Ein Anbieter, der beides anbietet, fragt, ob du dich **Mit deinem Browser anmelden** oder einen **API-Schlüssel** einfügen willst.
3. Warte, solange das Fenster sagt, dass es verbindet.
   Sobald das Abo antworten kann, blendet der Willkommensbildschirm aus und das Nachrichtenfeld öffnet sich.

Wenn du Claude nutzt, verwendet Infinitary das Claude Code, das du auf diesem Computer installiert hast.
Ohne es sagt die Schaltfläche von Claude, dass du zuerst Claude Code installieren sollst.

Wenn ein Abo verbunden ist, aber trotzdem nicht antworten kann, steht im Fenster **Richte deinen ersten Offizier auf diesem Computer ein**, das Fenster öffnet sich bei „Dieser Computer“ und sagt, was noch fehlt.

## Auf einem anderen Computer einrichten {#set-it-up-on-another-computer}

Wähl **Ein anderer Computer**, damit dein erster Offizier auf einem Computer lebt, der eingeschaltet bleibt, etwa einem Desktop-Computer oder einem Server, während du ihn von diesem aus steuerst.
Das Fenster zeigt **Richte mich auf einem anderen Computer ein**.

1. Tipp das Konto und den Computer so ein, wie du dich mit SSH dort anmeldest, etwa `you@mini.local`, und seinen Port, falls er nicht 22 ist.
   Dort muss die „Entfernte Anmeldung“ aktiviert sein; unter Linux sein SSH-Server.
   Computer im selben Netzwerk stehen unter **In diesem Netzwerk**, du kannst also einen auswählen.
2. Drück **Weiter**.

Infinitary richtet deinen ersten Offizier dann dort ein, Schritt für Schritt, unter „Dein erster Offizier wird auf … eingerichtet“ mit dem Namen jenes Computers:

1. **Seinen SSH-Schlüssel lesen**: Es zeigt die Schlüsselzeile des Computers und bittet dich, sie zu bestätigen, bevor es sich anmeldet.
2. **Mit deinem SSH-Schlüssel anmelden**: Nimmt der Computer deinen Schlüssel nicht an, fragt es einmal nach dem Passwort dieses Kontos.
3. **Sein System prüfen**.
4. **Infinitary senden**.
5. **Deinen ersten Offizier dort starten**, damit er nach jedem Neustart wieder startet.
6. **Von hier aus verbinden**.
7. **Ein Abo dafür verbinden**.

Jeder abgeschlossene Schritt sagt, was er gefunden hat.
Hält ein Schritt an, sagt er, was ihn angehalten hat und was du versuchen kannst, mit **Erneut fragen**, **Mit Befehlen einrichten** und **Zurück**.
Läuft Infinitary dort schon, bietet es **Stattdessen verbinden** an.
Meldet dich ein Linux-Computer als root an, bietet Infinitary dort ein gewöhnliches Konto namens `infinitary` für deinen ersten Offizier an, da Infinitary nicht als root läuft.
**Abbrechen** stoppt beim nächsten Schritt; ist dein erster Offizier dort noch nicht gestartet, wird die Kopie von Infinitary gelöscht, die es geschickt hat.

Sobald es verbunden ist, zeigt dieses Fenster den ersten Offizier auf jenem Computer.
Dort steht **Verbinde ein Abo, um anzufangen**: Wähl einen Anbieter und melde dich von hier aus an, wie unter [Ein Abo verbinden](#connect-a-subscription).

### Mit Befehlen {#with-commands}

**Mit Befehlen einrichten** zeigt dieselbe Einrichtung als Befehle, die du auf dem anderen Computer ausführst:

1. Installiere dort Infinitary.
2. Starte deinen ersten Offizier dort:

   ```sh
   infinitary start-at-boot
   ```

3. Erstelle dort einen Link für diesen Computer:

   ```sh
   infinitary link
   ```

4. Füge den ausgegebenen Link hier ein: Drück **Link einfügen**.

Jeder Befehl hat sein eigenes **Kopieren**.
Auf einem Mac tippst du `/Applications/Infinitary.app/Contents/MacOS/Infinitary` statt `infinitary`.
Siehe [Ein Computer ohne Bildschirm](/de/a-computer-with-no-screen/) für einen Server, den du nur über SSH erreichst.

## Wenn dein erster Offizier schon auf einem anderen Computer lebt {#if-your-first-mate-already-lives-on-another-computer}

Wähl **Einer, der schon läuft**.
Eine Gruppe mit der Überschrift „Dein erster Offizier ist auf einem anderen Computer“ bietet diese Wege an:

- **Vom Computer deines ersten Offiziers einrichten**, auf einem Mac oder einem x64-Linux-Computer, steht an erster Stelle.
  Es zeigt die Adresse dieses Computers, die du auf dem Computer eintippst, auf dem dein erster Offizier lebt.
  Sobald jener Computer diesen hinzufügt, öffnet dieses Fenster deinen ersten Offizier von selbst, solange darin noch nichts eingerichtet wurde, etwa eine Anmeldung oder ein Projekt.
- **Link einfügen**: Füge einen Link ein, der auf dem Computer erstellt wurde, auf dem dein erster Offizier lebt, in Einstellungen → Geräte oder indem du deinen ersten Offizier darum bittest, und drück dann **Weiter**.
- **Über die Adresse beitreten**: Tipp die Adresse ein, mit der du dich per SSH an jenem Computer anmeldest.
  Ist Infinitary dort nicht geöffnet, richtet **Von hier aus einrichten** stattdessen deinen ersten Offizier dort ein, wie unter [Auf einem anderen Computer einrichten](#set-it-up-on-another-computer).

Infinitary fragt einmal, ob du deinen ersten Offizier von dort aus steuern willst; drück **Von hier aus steuern**.

Ein Fenster, in dem du schon etwas eingerichtet hast, behält seinen eigenen ersten Offizier: Steuere dann mit **Link einfügen** oder **Über die Adresse beitreten** stattdessen jenen ersten Offizier von hier aus.
War Infinitary geschlossen, als jener Computer diesen hinzugefügt hat, öffnet es beim nächsten Start deinen ersten Offizier, egal was darin eingerichtet wurde.
Ein Fenster neben einem Infinitary, das du selbst im Terminal gestartet hast, behält dessen ersten Offizier und bietet keinen der beiden Wege an; beende zuerst jenes Infinitary, um sie zu nutzen.
Ein Windows-PC und ein Arm-Linux-Computer zeigen nur **Link einfügen** und **Über die Adresse beitreten**.
Siehe [Deine anderen Computer](/de/your-other-computers/).

## Der Hinweis zur Diagnose {#the-diagnostics-notice}

Ein Hinweis unter dem Nachrichtenfeld sagt, was die Diagnose sendet und dass sie nie enthält, was du tippst.
Er erscheint, ob ein Abo verbunden ist oder nicht, und bleibt, bis du ihn beantwortest.
Wähl **OK**, um sie eingeschaltet zu lassen, oder **Ausschalten**.
Du kannst das später in den [Einstellungen](/de/settings/#general) ändern.
Siehe [Was deinen Computer verlässt](/de/what-leaves-your-computer/).

## Die Willkommenskarte {#the-welcome-card}

Sobald dein erster Offizier antworten kann, erscheint eine Karte mit dem Titel **So arbeiten wir**.

<img class="picture-dark" src="/pictures/first-launch-welcome-dark.webp" alt="Die Karte „So arbeiten wir“: ein kleines Bild des Fensters mit dem ersten Offizier über dem Nachrichtenfeld, darunter fünf Punkte mit „Zurück“ und „Weiter“, die drei Einstiege und „Verstanden“." width="930" height="523" />
<img class="picture-light" src="/pictures/first-launch-welcome-light.webp" alt="Die Karte „So arbeiten wir“: ein kleines Bild des Fensters mit dem ersten Offizier über dem Nachrichtenfeld, darunter fünf Punkte mit „Zurück“ und „Weiter“, die drei Einstiege und „Verstanden“." width="930" height="523" />

Sie ist ein kleines Bild des Fensters, das jeweils einen Teil zeigt.
Mit **Weiter** und **Zurück** siehst du das Nachrichtenfeld, eine Karte, links die Aktivität, wo Crewmitglieder berichten, und rechts die Aufgaben, wo jede Bitte ein Protokoll bekommt.

Unter dem Bild steht „Drück zum Anfangen auf einen und vervollständige den Satz:“, mit drei Einstiegen:

- **Ein Projekt klonen** setzt „Klone das Projekt unter“ ins Nachrichtenfeld.
- **Ein neues Projekt starten** setzt „Starte ein neues Projekt namens“ ins Nachrichtenfeld.
- **In einem Ordner auf meinem Computer arbeiten** öffnet die Ordnerauswahl deines Computers.
  Der Ordner, den du wählst, wird ein Projekt, und eine Zeile unter dem Titel der Karte nennt ihn.
  Nutzt der Ordner noch kein git, bekommt er git, mit einem leeren ersten Commit.

Vervollständige den Satz und sende ihn ab.
Ein Einstieg sendet von sich aus nichts.
Auf einem Computer, der einen ersten Offizier auf einem anderen Computer steuert, setzt **In einem Ordner auf meinem Computer arbeiten** stattdessen „Arbeite im Ordner“ ins Nachrichtenfeld, da die Ordnerauswahl die Ordner dieses Computers zeigen würde.

Die Willkommenskarte hat kein Antwortfeld: Das Nachrichtenfeld darunter ist der Ort, an dem du tippst.
Drück **Verstanden**, um sie wegzulegen, wann immer du willst.

## Dein erstes Crewmitglied {#your-first-crewmate}

Wenn dein erster Offizier zum ersten Mal eine Bitte an ein Crewmitglied gibt, erscheint eine Karte mit dem Titel **Ein Crewmitglied ist dran**.

<img class="picture-dark" src="/pictures/first-launch-crewmate-dark.webp" alt="Die Karte „Ein Crewmitglied ist dran“: der erste Offizier, der ein Crewmitglied losschickt, ein Bereich „Jetzt“, der sagt, dass ein Crewmitglied arbeitet und du nicht zusehen musst, ein Bereich „Später“, der sagt, dass eine Karte mit einer Antwort oder einer Entscheidung hierher zurückkommt, und „Verstanden“." width="1070" height="602" />
<img class="picture-light" src="/pictures/first-launch-crewmate-light.webp" alt="Die Karte „Ein Crewmitglied ist dran“: der erste Offizier, der ein Crewmitglied losschickt, ein Bereich „Jetzt“, der sagt, dass ein Crewmitglied arbeitet und du nicht zusehen musst, ein Bereich „Später“, der sagt, dass eine Karte mit einer Antwort oder einer Entscheidung hierher zurückkommt, und „Verstanden“." width="1070" height="602" />

Sie sagt, dass das Crewmitglied im Hintergrund arbeitet, was eine Weile dauern kann, und dass du nicht zusehen musst.
Wenn das Crewmitglied eine Antwort hat oder du etwas entscheiden musst, kommt das als Karte zurück.
Nur die Karten brauchen dich.

Ist die Karte „So arbeiten wir“ noch offen, tritt diese Karte an ihre Stelle.
Sie erscheint nur einmal.
Drück **Verstanden**; die Arbeit geht weiter, und du kannst in der Zwischenzeit um etwas anderes bitten.
Siehe [Deine erste Aufgabe](/de/your-first-task/).

## Dein erstes Projekt hinzufügen {#add-your-first-project}

Dein erster Offizier braucht ein Projekt, in dem er arbeiten kann.
Am einfachsten geht das mit einem Einstieg auf der Willkommenskarte oder mit denselben Worten in deiner eigenen Nachricht.

**In einem Ordner auf meinem Computer arbeiten** fügt den gewählten Ordner sofort hinzu.
Bei den anderen Einstiegen zeigt dein erster Offizier eine Karte, die das Projekt nennt und wie es eingerichtet wird.
Prüf die Auswahl auf der Karte und drück dann **Projekt hinzufügen**, oder **Nicht jetzt**, um es sein zu lassen.
Nichts wird hinzugefügt, bevor du **Projekt hinzufügen** drückst.

Du kannst ein Projekt auch selbst hinzufügen, in Einstellungen → Projekte mit **Projekt hinzufügen**.
Siehe [Projekte](/de/projects/) für die dortigen Optionen.

## Spätere Starts {#later-launches}

Wenn ein Abo antworten kann, öffnet sich Infinitary direkt beim Nachrichtenfeld.
Deine Karten, Aufgaben und deine Crew sind dort, wo du sie gelassen hast.

Nach einem Update von Infinitary nennt eine Karte die neue Version und was sich geändert hat.
Du kannst sie später in den [Einstellungen → Allgemein](/de/settings/#general) unter „Version“ noch einmal lesen.
Auf einem Mac öffnet sie auch **Neu in Infinitary** im Hilfe-Menü.

Wenn dein letztes Abo nicht mehr funktioniert, zum Beispiel weil du dich abgemeldet hast, kommt der Willkommensbildschirm zurück, bis wieder eines antworten kann.
Wenn das Kontingent deines Tarifs aufgebraucht ist, zeigt dein erster Offizier stattdessen eine Karte, die das sagt, und hebt deine Nachrichten auf, bis er wieder antworten kann.
Siehe [Abos und Kontingent](/de/subscriptions-and-quota/).

Damit sich Infinitary öffnet, wenn du dich an deinem Computer anmeldest, schalte in Einstellungen → Allgemein **Bei Anmeldung starten** ein.
