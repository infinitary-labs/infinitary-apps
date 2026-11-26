---
source: 9c71f435cc6524a0
title: Abos und Kontingent
description: Wie du deine KI-Abos hinzufügst, das Kontingent deines Tarifs ablesen kannst und was deine Crew tut, wenn es aufgebraucht ist.
---

Dein erster Offizier und deine Crew arbeiten über die KI-Abos, die du schon hast.
Du verwaltest sie in den Einstellungen unter **Intelligenz** in der Liste **KI-Abos**.

## Ein Abo hinzufügen {#add-a-subscription}

1. Öffne die Einstellungen und wähl **Intelligenz**.
2. Wähl am Ende von **KI-Abos** unter **Konto hinzufügen** deinen Anbieter: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter oder Amazon Bedrock.
3. Melde dich so an, wie der Anbieter es verlangt.
   Manche öffnen deinen Browser, manche zeigen einen Code, den du auf ihrer Seite eingibst, und manche nehmen einen Schlüssel, den du einfügst.
4. Wenn die Anmeldung abgeschlossen ist, erscheint das neue Konto in der Liste.

Du kannst mehr als ein Konto desselben Anbieters hinzufügen.
Die Schaltfläche heißt dann zum Beispiel **Weiteres Codex-Konto hinzufügen**.

## Deinen Konten Namen geben {#name-your-accounts}

Jedes Konto hat eine Bezeichnung, damit du ein privates von einem Arbeitskonto unterscheiden kannst.
Nennt die Anmeldung das Konto nicht, öffnet sich ein Namensfeld, in das du einen Namen tippen kannst.
Um ihn später zu ändern, öffne das Menü des Kontos und wähl **Umbenennen**.

Ein Claude-Konto ist anders.
Es folgt der Claude-Code-Anmeldung auf deinem Computer, daher zeigt seine Zeile, wer dort gerade angemeldet ist.
Es hat kein **Umbenennen**, und wenn du die Claude-Code-Anmeldung wechselst, folgt die Zeile.

## Das Kontingent deines Tarifs ablesen {#read-your-plans-allowance}

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Einstellungen, Bereich Intelligenz: zwei Konten in KI-Abos, Codex und Claude, jedes mit einer Sitzungsanzeige und einer Wochenanzeige, und ein gespeicherter Reset beim Codex-Konto, darunter die Schaltflächen „Konto hinzufügen“, die Zeile Verbindungsdatei und Modell des ersten Offiziers." width="1048" height="524" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Einstellungen, Bereich Intelligenz: zwei Konten in KI-Abos, Codex und Claude, jedes mit einer Sitzungsanzeige und einer Wochenanzeige, und ein gespeicherter Reset beim Codex-Konto, darunter die Schaltflächen „Konto hinzufügen“, die Zeile Verbindungsdatei und Modell des ersten Offiziers." width="1048" height="524" />

Jedes Konto zeigt für jedes Kontingent, das sein Anbieter hat, eine kleine Anzeige, etwa für eine Sitzung und eine Woche.
Die Zahl sagt, wie viel übrig ist.
Halt den Zeiger auf eine Anzeige, um zu sehen, wann sie zurückgesetzt wird.

- Der Balken wird gelb, wenn du der Uhr voraus bist: Du verbrauchst schneller, als es bei gleichmäßigem Tempo bis zum Zurücksetzen reichen würde.
- Die Zahl wird unter der Hälfte gelb und unter einem Fünftel rot.
- Neben den Anzeigen fasst ein Wort das Konto zusammen: **im Plan**, **leer in** einer Zeitangabe oder **jetzt leer**.
- **Stand: vor 3 Std.** heißt, dass die letzte Ablesung alt ist, deshalb sind ihre Zahlen abgedunkelt.
- Ein Strich bedeutet, dass dieses Kontingent nicht gelesen wurde.
- Ein Codex-Konto mit [gespeicherten Resets](#saved-codex-resets) sagt unter seinen Anzeigen, wie viele es hat.

**Aktualisieren** oben in der Liste liest jedes Kontingent erneut.
Infinitary liest kein Kontingent für OpenRouter oder eine eigene API, und die Zeile sagt das.
Amazon Bedrock wird nach Nutzung über dein AWS-Konto abgerechnet; seine Zeile zeigt die Schätzung dieses Monats aus der Arbeit, die Infinitary erfasst hat.

## Wählen, welches Konto was tut {#choose-which-account-does-what}

Öffne das Menü eines Kontos, die drei Punkte in seiner Zeile, für diese Auswahl.
Seine Einstellungen stehen oben, jede mit einem Schalter, der zeigt, ob sie an ist; ein Klick schaltet sie um, und das Menü bleibt offen.

- **Für Crew-Arbeit bevorzugen** lässt deine Crew zuerst dieses Konto nutzen.
  Ein ✱ markiert es.
- **Pausiert** hält alle Arbeit auf diesem Konto an, solange sein Schalter an ist.
- **Trennen** entfernt das Konto aus Infinitary.

Wenn du zwei oder mehr Konten des Anbieters hast, den dein erster Offizier nutzt, lässt dich Einstellungen wählen, auf welchem dein erster Offizier antwortet.
Ein Etikett **Offizier** markiert dieses Konto.

## Wenn ein Kontingent aufgebraucht ist {#when-an-allowance-runs-out}

Deine Crew weicht von selbst aus.
Neue Arbeit geht an ein Modell mit übrigem Kontingent.
Ist auf dieser Stufe keins mehr übrig, fällt die Crew-Arbeit auf ein schwächeres Modell zurück oder wartet, bis das Kontingent zurückgesetzt wird.

Wenn das eigene Konto deines ersten Offiziers aufgebraucht ist, wechselt er zuerst zu einem anderen Konto desselben Anbieters, das noch etwas hat.
Gibt es keins, sagt eine Karte **Dein erster Offizier hat sein Kontingent aufgebraucht**.
Deine Worte warten, und nichts geht verloren.
Auf der Karte kannst du **Kontingent erneut prüfen** wählen, deinen ersten Offizier zu einem anderen Anbieter wechseln lassen oder **Einstellungen öffnen**.
Findet die erneute Prüfung keine Änderung, bietet die Karte auch an, es bei deinem Anbieter noch einmal zu versuchen, etwa mit **Try Claude again**, für den Fall, dass dein erster Offizier ihn über eine andere Anmeldung erreicht; ist das Kontingent noch aufgebraucht, pausiert er wieder.

Manche Anbieter können weiter antworten, und zwar mit Guthaben, das du bei ihnen eingerichtet hast.
Bei einem Claude- oder Codex-Konto enthält das Menü **Mit Guthaben weitermachen**.
Deine Crew gibt Guthaben dann erst nach jedem enthaltenen Kontingent aus.
Infinitary kauft nie Guthaben und legt auch nie dessen Limit fest; das erledigt die Website des Anbieters.

### Gespeicherte Codex-Resets {#saved-codex-resets}

ChatGPT kann einem Codex-Konto gespeicherte Resets geben.
Jeder füllt ein Kontingent auf, bevor es von selbst zurückgesetzt wird.
Die Zeile des Kontos sagt, wie viele es hat und wo du einen einlösen kannst, zum Beispiel „1 gespeicherter Reset · einlösbar auf chatgpt.com“.

Solange einer jetzt eingelöst werden kann, enthält das Menü des Kontos **Gespeicherten Reset einlösen**.
Auch die Karte, die sagt, dass ein Kontingent aufgebraucht ist, sagt das, mit derselben Schaltfläche und einem Link zur Nutzungsseite auf chatgpt.com.
Infinitary lässt dann Codex auf deinem Computer den Reset einlösen, der zuerst abläuft.
Dafür ist Codex 0.143 oder neuer nötig, und beim ersten Mal bittet dich Codex, dich bei diesem ChatGPT-Konto anzumelden.
Einen eingelösten Reset bekommst du nicht zurück.
Die Aktivität sagt, was passiert ist und wie viele übrig sind.

Infinitary kann sie auch ohne Klick einlösen.
Schalte **Gespeicherte Resets selbst einlösen** im Menü des Kontos oder auf dieser Karte ein; es ist aus, bis du es einschaltest.
Infinitary löst einen dann nur ein, wenn Arbeit wartet und kein Konto Kontingent hat, und nur, wenn das Warten auf das Auffüllen des Kontingents lange dauern würde.
Konten mit übrigem Kontingent kommen immer zuerst.
Die Aktivität sagt es jedes Mal, wenn Infinitary einen einlöst.

## Erneut anmelden {#sign-in-again}

Eine Anmeldung kann ablaufen.
Dann sagt die Zeile des Kontos **erneut anmelden** und zeigt eine Schaltfläche **Anmelden**.
Wähl sie und melde dich so an wie beim ersten Mal.
Das erneuert dasselbe Konto, mit seiner Bezeichnung und seinen Einstellungen.

## Eigene API {#custom-api}

Betreibt deine Organisation einen eigenen KI-Server, wähl unter **Konto hinzufügen** die **Eigene API**.
Gib ihr einen Namen, die Adresse des Servers, einen Schlüssel, falls er einen braucht, und die Modelle, die genutzt werden sollen.
**Speichern** prüft jedes Modell, bevor deine Crew es nutzen kann.
Danach wählst du auf der **Modelltafel**, ob deine Crew diese Modelle nutzt.

### Verbindungen aus einer Datei {#connections-from-a-file}

Wenn du deine Verbindungen schon in einer Datei im `models.json`-Format von Pi hast, kann Infinitary sie daraus lesen.
Drück in der Zeile **Verbindungsdatei** unter **KI-Abos** auf **Datei auswählen** und wähl die Datei aus.
Infinitary liest die Datei nur: Es ändert sie nie und verwendet nie einen Schlüssel, der darin steht.

Jede Verbindung, die die Datei festlegt, erscheint mit den Markierungen **Aus deiner Datei** und **Noch nicht freigegeben**.
Drück **Freigeben**, gib den eigenen Schlüssel dieses Computers und jede Modellgröße ein, die die Datei offenlässt, und drück dann **Speichern**, das jedes Modell prüft.

Danach folgt Infinitary der Datei.
Ein neuer Name oder Preis gilt sofort, und nach einem geänderten Limit wird das betroffene Modell erneut geprüft.
Eine geänderte Adresse, ein geändertes Protokoll oder ein geänderter Header pausiert die Verbindung, bis du **Erneut freigeben** drückst.
Eine Verbindung, die nicht mehr in der Datei steht, wird pausiert, nie gelöscht.
Mit **Nicht mehr lesen** folgt Infinitary der Datei nicht mehr, und die Verbindungen, die du freigegeben hast, bleiben.

### Auf deinen anderen Computern {#on-your-other-computers}

Wenn ein anderer Computer Arbeit für dich ausführt, bietet die Zeile einer eigenen Verbindung **Verwenden** an und nennt dabei den anderen Computer.
Du gibst den eigenen Schlüssel des anderen Computers ein, und er prüft jedes Modell und bewahrt den Schlüssel selbst auf; dieser Computer behält keine Kopie.
Spätere Änderungen an der Verbindung folgen ihr dorthin.
Siehe [Deine anderen Computer](/de/your-other-computers/).

## Nutzung {#usage}

Einstellungen → **Nutzung** zeigt, wie viel dein erster Offizier und deine Crew über alle Projekte hinweg genutzt haben.
Die Nutzung öffnet sich in **Geschätzt $**; unter **Nutzung anzeigen als** kannst du zu **Tokens** wechseln.
Wähl einen **Zeitraum** und die Art der **Arbeit**, die gezählt werden soll.
Geschätzte Dollar sind ein Richtwert für den Wert, keine Rechnung.

**Kosten pro Aufgabe** zeigt als Diagramm, was eine abgeschlossene Aufgabe kostet, ihre Reviews eingeschlossen.
Jeder Punkt ist der Median der Aufgaben, die in den sieben Tagen davor abgeschlossen wurden, und das Band zeigt die mittlere Hälfte davon.
Eine steigende Linie heißt, dass Aufgaben mehr Arbeit brauchen als zuvor.
**Projekte** und **Arten** grenzen das Diagramm auf die Arbeit ein, die du vergleichen willst.

**Letzte Aufgaben** listet auf, was jede Aufgabe genutzt hat.

Unter **Intelligenz** legt **Fragen, bevor eine Aufgabe mehr ausgibt als** einen Betrag fest.
Eine Aufgabe, die ihn überschreitet, hält an einem sicheren Punkt an und fragt dich auf einer Karte, bevor sie mehr ausgibt.

## Lange Unterhaltungen {#long-conversations}

Wenn eine Unterhaltung lang wird, fassen dein erster Offizier und deine Crew sie zusammen und machen mit der Zusammenfassung weiter, damit jede Nachricht weniger kostet und weiter in das Modell passt.
Unter **Intelligenz** legt **Lange Unterhaltungen zusammenfassen bei** fest, wann das passiert.

- **Automatisch** fasst bei 300.000 Tokens zusammen, oder früher, wo ein Modell schon ab einem niedrigeren Punkt mehr berechnet.
- **150.000 Tokens**, **200.000 Tokens**, **300.000 Tokens** oder **500.000 Tokens** fasst bei dieser Zahl zusammen, oder an der eigenen Grenze des Modells, wenn sie kleiner ist.
- **Grenze des jeweiligen Modells** fasst erst nahe der eigenen Grenze jedes Modells zusammen, die bei einer Million Tokens liegen kann.

Eine niedrigere Zahl kostet weniger; eine höhere behält mehr von der Unterhaltung vollständig.
Wenn die gewählte Zahl ein Modell über einen Punkt hinauslaufen lässt, ab dem seine Anfragen mehr kosten, nennt die Zeile dieses Modell und den Punkt.
Eine schon offene Unterhaltung folgt einer Änderung bei ihrer nächsten Nachricht, auch auf deinen anderen Computern; eine Unterhaltung mit Claude folgt ihr, wenn sie das nächste Mal startet.
