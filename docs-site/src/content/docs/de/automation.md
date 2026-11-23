---
source: 196a49ab4dfdf816
title: Automatisierung
description: Gib deinem ersten Offizier eine Nachricht, die nach Zeitplan oder bei einem Ereignis läuft, und pausiere, ändere oder lies jede davon in den Einstellungen nach.
---

Eine Automatisierung ist eine Nachricht, die dein erster Offizier nach einem Zeitplan bekommt.
Du schreibst, was dein erster Offizier erfahren soll, und wählst, wann.
Wenn es so weit ist, bekommt dein erster Offizier die Nachricht und handelt danach, als hättest du sie gerade eben gesendet.

Du kannst eine in den Einstellungen erstellen oder deinem ersten Offizier sagen, was wann laufen soll.

## Wo Automatisierungen liegen {#where-automations-live}

Öffne die **Einstellungen** und dann **Automatisierung**.
Du kannst in der Befehlssuche auch nach **Automatisierung öffnen** suchen.

Die Liste links zeigt jede Automatisierung mit ihrem Zustand:

- **Läuft** läuft zu ihrem nächsten Zeitpunkt.
- **Entwurf** ist gespeichert, läuft aber nie, bis du sie einschaltest.
- **Pausiert** behält ihre Einstellungen, läuft aber nicht.
- **Fertig** ist eine einmalige Automatisierung, die gelaufen ist und darauf wartet, dass dein erster Offizier sie bearbeitet.

Wähl eine Automatisierung aus, um sie zu lesen oder zu ändern.
**Automatisierungen durchsuchen** findet eine nach ihrem Namen, ihrer Nachricht oder dem Zeitpunkt, zu dem sie läuft.

## Eine Automatisierung erstellen {#make-an-automation}

1. Öffne die **Einstellungen** und dann **Automatisierung** und wähl **Neue Automatisierung**.
2. Gib ihr einen **Namen**, zum Beispiel „Wöchentlicher Rückblick“.
3. Wähl unter **Wann**, wie oft sie läuft.
4. Wähl unter **Projekt** das Projekt, um das es geht, oder lass **Kein Projekt** stehen.
5. Schreib unter **Sag deinem ersten Offizier** die Nachricht.
6. Wähl **Entwurf speichern**, um sie für später aufzuheben, oder **Einschalten …**, um sie zu prüfen und einzuschalten.

**Vorschau** zeigt die nächsten drei Zeitpunkte, zu denen sie läuft, und die Nachricht, wie dein erster Offizier sie bekommt.
Es wird nichts gesendet.

## Wann sie läuft {#when-it-runs}

- **Wiederholt** läuft alle paar Minuten, höchstens alle 15 Minuten.
- **Jeden Tag** läuft zu einer Uhrzeit.
- **An gewählten Tagen** läuft an den Wochentagen, die du wählst, zu einer Uhrzeit.
- **Einmal** läuft zu einem Datum und einer Uhrzeit.
- **Wenn etwas passiert** läuft jedes Mal, wenn etwas Neues passiert, zum Beispiel wenn eine Aufgabe abgeschlossen wird, oder bei einem Ereignis von etwas, das du in den Einstellungen verbunden hast.

Eine tägliche oder wöchentliche Automatisierung behält die **Zeitzone**, die du wählst, und läuft deshalb zur selben Zeit, wo auch immer dein Computer steht.

Jede **Einfügen**-Schaltfläche unter der Nachricht setzt eine Angabe hinein, etwa die Zeit, für die der Lauf geplant war.
Jede Angabe wird ausgefüllt, wenn die Nachricht gesendet wird.

## Einschalten {#turn-it-on}

Eine neue Automatisierung aus den Einstellungen beginnt als Entwurf.
Ein Entwurf läuft nie.

Wenn du **Einschalten …** wählst, zeigt die Seite, was passieren wird, bevor etwas läuft:

- wann sie läuft und in welcher Zeitzone,
- das Projekt und die Nachricht genau so, wie dein erster Offizier sie bekommt,
- die nächsten Zeitpunkte, zu denen sie läuft,
- was sie sendet: Die Nachricht und ihre Zeitplanangaben gehen an dein KI-Abo und bleiben in der Unterhaltung deines ersten Offiziers, und sonst bekommt nichts neuen Zugriff,
- was mit einer verpassten Zeit geschieht.

Wähl **Einschalten**, um sie zu starten, oder **Zurück**, um ohne Änderung zurückzukehren.

Dein erster Offizier kann auch Automatisierungen erstellen.
Eine sich wiederholende Automatisierung, die dein erster Offizier von sich aus erstellt, wartet als Entwurf, bis du sie einschaltest.

## Pausieren, ändern oder löschen {#pause-change-or-delete}

- **Pausieren** stoppt eine laufende Automatisierung.
  Eine Nachricht, die noch nicht zugestellt war, wird zurückgenommen.
- **Fortsetzen** startet sie wieder ab ihrem nächsten Zeitpunkt.
  Die Zeit, in der sie pausiert war, holt sie nicht nach.
- **Alle pausieren** pausiert alle laufenden Automatisierungen auf einmal.
  Entwürfe lässt es in Ruhe.
  Du kannst in der Befehlssuche auch nach **Alle Automatisierungen pausieren** suchen.
- **Löschen** und dann **Endgültig löschen** entfernt sie samt ihrem Verlauf.
  Die Aufgaben und Karten, zu denen sie geführt hat, bleiben.

## Wenn Infinitary geschlossen ist {#when-infinitary-is-closed}

Automatisierungen laufen nur, solange Infinitary geöffnet und der Computer wach ist.
Wenn ein Zeitpunkt vergeht, während es geschlossen ist, läuft die Automatisierung einmal, sobald Infinitary wieder geöffnet wird, und die Nachricht sagt, wie viele Male sie verpasst wurden.

## Verlauf {#history}

Auf der Seite einer Automatisierung listet der Tab **Verlauf** ihre Läufe auf, den neuesten zuerst.
Jeder Lauf zeigt, wo er steht:

- **Wartet**: Dein erster Offizier hat ihn noch nicht bearbeitet.
- **Neuer Versuch**: Dein erster Offizier konnte ihn noch nicht annehmen, und es wird erneut versucht.
- **Erledigt**: Dein erster Offizier hat ihn bearbeitet.
- **Zurückgenommen**: Er wurde zurückgenommen, bevor dein erster Offizier ihn gelesen hat, zum Beispiel weil du die Automatisierung pausiert hast.

Ein erledigter Lauf zeigt nach **Gefunden:**, was dein erster Offizier gefunden hat, und die Aufgaben und Karten, zu denen er **Führte zu**.
Der Verlauf behält Läufe 30 Tage lang.

## Notizen {#notes}

Eine Automatisierung kann **Notizen** behalten, die ihre Läufe für spätere Läufe schreiben, damit der nächste Lauf schneller loslegt.
Ein Crewmitglied, das eine Automatisierung startet, bearbeitet sie, und du kannst sie auch bearbeiten.
Sie sind Ratschläge, nie Anweisungen.
**Frühere Fassungen** zeigt jede frühere Fassung und wer sie geschrieben hat.

## Läuft weiter {#kept-running}

Unter der Liste zeigt **Läuft weiter** Jobs, die ein Crewmitglied auf deine Bitte eingerichtet hat und die nach dem Schließen seiner Aufgabe weiterlaufen.
**Prüfen** sieht nach, ob ein Job noch läuft, und **Entfernen** nimmt ihn weg.

## Das Automatisierungs-Panel {#the-automation-panel}

Sobald du eine Automatisierung hast, erscheint das Panel **Automatisierung** am Rand des Fensters.
Es listet den Zustand und den nächsten Lauf jeder Automatisierung auf.
Klick auf eine, um sie in den Einstellungen zu öffnen.
Siehe [Panels](/de/panels/).
