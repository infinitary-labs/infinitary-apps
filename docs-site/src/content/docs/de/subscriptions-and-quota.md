---
source: 9b6e613d96f64f80
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

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Zwei Konten in KI-Abos, Codex und Claude, jedes mit einer Sitzungsanzeige und einer Wochenanzeige, darunter die Schaltflächen „Konto hinzufügen“." width="1064" height="532" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Zwei Konten in KI-Abos, Codex und Claude, jedes mit einer Sitzungsanzeige und einer Wochenanzeige, darunter die Schaltflächen „Konto hinzufügen“." width="1064" height="532" />

Jedes Konto zeigt für jedes Kontingent, das sein Anbieter hat, eine kleine Anzeige, etwa für eine Sitzung und eine Woche.
Die Zahl sagt, wie viel übrig ist.
Halt den Zeiger auf eine Anzeige, um zu sehen, wann sie zurückgesetzt wird.

- Der Balken wird gelb, wenn du der Uhr voraus bist: Du verbrauchst schneller, als es bei gleichmäßigem Tempo bis zum Zurücksetzen reichen würde.
- Die Zahl wird unter der Hälfte gelb und unter einem Fünftel rot.
- Neben den Anzeigen fasst ein Wort das Konto zusammen: **im Plan**, **leer in** einer Zeitangabe oder **jetzt leer**.
- **Stand: vor 3 Std.** heißt, dass die letzte Ablesung alt ist, deshalb sind ihre Zahlen abgedunkelt.
- Ein Strich bedeutet, dass dieses Kontingent nicht gelesen wurde.

**Aktualisieren** oben in der Liste liest jedes Kontingent erneut.
Infinitary liest kein Kontingent für OpenRouter oder eine eigene API, und die Zeile sagt das.
Amazon Bedrock wird nach Nutzung über dein AWS-Konto abgerechnet; seine Zeile zeigt die Schätzung dieses Monats aus der Arbeit, die Infinitary erfasst hat.

## Wählen, welches Konto was tut {#choose-which-account-does-what}

Öffne das Menü eines Kontos, die drei Punkte in seiner Zeile, für diese Auswahl.

- **Für Crew-Arbeit bevorzugen** lässt deine Crew zuerst dieses Konto nutzen.
  Ein ✱ markiert es.
- **Pausieren** hält alle Arbeit auf diesem Konto an, bis du **Fortsetzen** wählst.
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

Manche Anbieter können weiter antworten, und zwar mit Guthaben, das du bei ihnen eingerichtet hast.
Bei einem Claude- oder Codex-Konto enthält das Menü **Mit Guthaben weitermachen**.
Deine Crew gibt Guthaben dann erst nach jedem enthaltenen Kontingent aus.
Infinitary kauft nie Guthaben und legt auch nie dessen Limit fest; das erledigt die Website des Anbieters.

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

## Nutzung {#usage}

Einstellungen → **Nutzung** zeigt, wie viel dein erster Offizier und deine Crew über alle Projekte hinweg genutzt haben.
Zeig es in **Tokens** oder **Geschätzt $** an, für einen **Zeitraum** und für die Art der **Arbeit**.
Geschätzte Dollar sind ein Richtwert für den Wert, keine Rechnung.
**Letzte Aufgaben** listet auf, was jede Aufgabe genutzt hat.

Unter **Intelligenz** legt **Fragen, bevor eine Aufgabe mehr ausgibt als** einen Betrag fest.
Eine Aufgabe, die ihn überschreitet, hält an einem sicheren Punkt an und fragt dich auf einer Karte, bevor sie mehr ausgibt.
