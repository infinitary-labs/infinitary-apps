---
source: 91a924b8c4a1a2d6
title: Geheimnisse
description: Bewahre die Passwörter und Schlüssel auf, die deine Crew braucht, erlaube jede Nutzung auf einer Karte und sieh, was sie genutzt hat.
---

Geheimnisse bewahrt die Passwörter und Schlüssel auf, die deine Crew für ihre Arbeit braucht, etwa den Schlüssel, der deine Website veröffentlicht.
Ein Crewmitglied nutzt ein Geheimnis über seinen Namen, und erst, nachdem du diese Nutzung erlaubt hast.
Jeder Wert geht direkt in Geheimnisse auf deinem Computer: Weder der erste Offizier noch die Crew bekommt ihn, und er bleibt verborgen, außer du kopierst ihn selbst.

<img class="picture-dark" src="/pictures/secrets-dark.webp" alt="Einstellungen, Bereich Geheimnisse: drei geschützte Geheimnisse, Newsletter mail key für Production, Shop database password für Staging und Weather service key für Personal, noch keines genutzt, die Zeile von Shop database password geöffnet mit den Schaltflächen Wert kopieren, Ersetzen und Vergessen, mit Geheimnisse durchsuchen, Geheimnis hinzufügen, Aus einem anderen Werkzeug übernehmen und Zugriff, Verlauf &amp; Wiederherstellung, darunter eine leere Liste Angemeldete Websites." width="1164" height="596" />
<img class="picture-light" src="/pictures/secrets-light.webp" alt="Einstellungen, Bereich Geheimnisse: drei geschützte Geheimnisse, Newsletter mail key für Production, Shop database password für Staging und Weather service key für Personal, noch keines genutzt, die Zeile von Shop database password geöffnet mit den Schaltflächen Wert kopieren, Ersetzen und Vergessen, mit Geheimnisse durchsuchen, Geheimnis hinzufügen, Aus einem anderen Werkzeug übernehmen und Zugriff, Verlauf &amp; Wiederherstellung, darunter eine leere Liste Angemeldete Websites." width="1164" height="596" />

## Wo deine Geheimnisse liegen {#where-your-secrets-live}

Öffne die **Einstellungen**, dann **Geheimnisse**, oder such in der Befehlssuche nach **Geheimnisse öffnen**.

**Geschützte Geheimnisse** listet jedes Geheimnis mit Namen und Ort auf und sagt, welche Aufgabe es zuletzt genutzt hat und wann.
**Geheimnisse durchsuchen** findet eines über seinen Namen, seinen Ort oder die Aufgabe, die es zuletzt genutzt hat.

Auf einem Mac steht in der Zeile unter der Liste: „Auf diesem Computer aufbewahrt. Deine Crew nutzt sie, sieht sie aber nie, außer du kopierst eines.“
Unter Linux und Windows steht dort, dass deine Crew sie nur mit deiner Freigabe nutzt, dass aber jedes Programm, das du ausführst, sie erreichen kann, solange der Geheimnisspeicher deines Systems entsperrt ist.

Geheimnisse bleiben auf dem Computer, auf dem dein erster Offizier lebt.
Ein Computer, der deinen ersten Offizier von woanders aus steuert, hat keinen eigenen Bereich Geheimnisse.

## Ein Geheimnis aufbewahren {#keep-a-secret}

1. Wähl **Geheimnis hinzufügen**.
2. Gib ihm einen **Namen**, zum Beispiel „Website-Veröffentlichung“.
3. Füg den Wert in **Wert des Geheimnisses** ein.
4. Wenn du zwei Geheimnisse mit demselben Namen aufbewahrst, unterscheide sie mit **Ort (optional)**, zum Beispiel Staging oder Production.
5. Wähl **Geheimnis speichern**.

Der Wert bleibt nach dem Speichern verborgen.
Nur eine Nutzung, die du erlaubst, erhält ihn, außer du kopierst ihn selbst.
Öffne die Zeile eines Geheimnisses, um [seinen Wert zu kopieren](#copy-a-value), ihn zu **ersetzen** oder es zu **vergessen**.
Vergessen entfernt es von diesem Computer, schaltet den Schlüssel aber nicht dort ab, wo er erstellt wurde.

### Wenn ein Crewmitglied eines braucht, das du nicht aufbewahrt hast {#when-a-crewmate-needs-one-you-have-not-kept}

Ein Crewmitglied, das ein Geheimnis braucht, das du nicht aufbewahrt hast, fragt danach mit dem Namen, nie mit dem Wert.
Infinitary zeigt dann eine eigene Karte, zum Beispiel „Website-Veröffentlichung zu Geheimnisse hinzufügen?“, mit der Begründung des Crewmitglieds in seinen eigenen Worten.
Wenn du das Geheimnis selbst erstellen oder finden musst, zeigt die Karte auch **So bekommst du es**: die Schritte, Namen oder Orte, die das Crewmitglied für diesen Fall aufgeschrieben hat, und eine Zeile, die sagt, wer sie geschrieben hat.
Prüf jede Adresse, die sie zeigt, bevor du dich dort anmeldest.

Tipp oder füg jeden Wert in das verborgene Feld ein, das Infinitary auf der Karte zeichnet, und wähl dann **Geheimnis speichern**.
**Nicht speichern** speichert nichts.
Das Crewmitglied bekommt den Namen des Geheimnisses, nie seinen Wert, und jede Nutzung fragt trotzdem bei dir nach.

Gib ein Geheimnis nur in ein Feld ein, das Infinitary zeichnet, nie in das Antwortfeld einer Karte oder in dein Nachrichtenfeld.

## Einen Wert kopieren {#copy-a-value}

Wenn du einen Wert selbst brauchst, etwa um einen Schlüssel auf einer Website einzufügen, öffne die Zeile des Geheimnisses und wähl **Wert kopieren**.
Jedes Mal bittet dich dein Computer, zu bestätigen, dass du es bist: auf einem Mac mit Touch ID oder deinem Passwort, unter Linux mit deinem Passwort und unter Windows mit Windows Hello oder deinem Windows-Passwort.

Der Wert kommt in die Zwischenablage dieses Computers und in keine andere.
Auf einem Mac und unter Windows wandert er nicht auf deine anderen Geräte.
Unter Linux kann ein Verlaufswerkzeug der Zwischenablage ihn trotzdem behalten, und die Zeile sagt das.

Die Zeile sagt dann „Kopiert. Um … wird er aus der Zwischenablage entfernt.“ und nennt dabei die Uhrzeit, 90 Sekunden nach dem Kopieren.
Infinitary entfernt ihn dann, oder wenn du **Jetzt entfernen** wählst, oder wenn du Infinitary beendest.
Hast du inzwischen etwas anderes kopiert, lässt es deine Zwischenablage unberührt.

Die Zeile des Geheimnisses sagt danach **Von dir kopiert** und wann, und der [Nutzungsverlauf](#use-history-and-backups) listet das Kopieren genauso auf.
Wo dein Computer nicht bestätigen kann, dass du es bist, ist die Schaltfläche aus, und die Zeile sagt, warum.

Dein erster Offizier kopiert nie einen Wert.
Bitte ihn um einen, und er bringt dir eine Karte, zum Beispiel „Website-Veröffentlichung in Geheimnisse öffnen“, deren Schaltfläche **Geheimnisse öffnen** die Zeile dieses Geheimnisses für dich öffnet.

## Eine Nutzung erlauben {#allow-a-use}

Wenn ein Crewmitglied ein Geheimnis nutzen möchte, zeigt Infinitary eine Karte, zum Beispiel „Das Geheimnis Website-Veröffentlichung an „Die Website veröffentlichen“ geben?“.
Die Karte sagt genau, was es erhalten würde:

- **Geheimnis**: jedes Geheimnis und der Name, unter dem das Programm es bekommt.
- **Führt aus**: der genaue Befehl.
- **Im Ordner**: wo er läuft.
- **Die Begründung**: der Grund des Crewmitglieds, in seinen eigenen Worten.

**Alles, was überprüft wurde** listet auf, was Infinitary am Programm überprüft hat und was es nicht überprüfen konnte.
Wähl dann:

- **Einmal erlauben** gibt das Geheimnis nur diesem Lauf.
- **Immer erlauben** gibt es diesem Lauf und speichert genau diesen Lauf: dasselbe Programm, dieselben Dateien, dieselben Argumente und denselben Ordner.
  Alles andere fragt erneut.
- **Nicht erlauben** lehnt ab, und der nächste Lauf fragt erneut.

Jedes Erlauben bittet dich zuerst um eine Bestätigung: auf einem Mac mit Touch ID oder deinem Passwort, unter Linux mit deinem Passwort und unter Windows mit Windows Hello oder deinem Windows-Passwort.
Was ein Geheimnis erhält, kann es behalten.
Erlauben bestätigt nie eine eigene Handlung, etwa ein Deployment oder das Senden von etwas.
Das Crewmitglied erfährt nur, ob der Lauf zu Ende gegangen ist, nicht, was er ausgegeben hat.

Solange eine Anfrage wartet, zeigt Einstellungen → Geheimnisse sie ganz oben, mit **Anfrage prüfen**, um ihre Karte zu öffnen.

## Gespeicherte Entscheidungen {#saved-decisions}

Öffne **Zugriff, Verlauf & Wiederherstellung** unter der Liste der Geheimnisse, dann **Gespeicherte Entscheidungen**.
Jede Entscheidung, die du mit **Immer erlauben** gespeichert hast, steht dort als ein Satz.

Du speicherst eine Entscheidung nur auf der Karte einer Anfrage.
Hier kannst du eine **entfernen**: Dein Computer bittet dich um eine Bestätigung, und die Crew fragt dich vor der nächsten Nutzung erneut.

## Vom Telefon aus freigeben {#approve-from-your-phone}

Du kannst eine Nutzung von deinem iPhone oder iPad aus erlauben, während du nicht an deinem Computer bist.

1. Schalte in Einstellungen → **Geräte** in der Zeile deines Telefons **Gibt Geheimnisse frei** ein.
2. Öffne Infinitary auf dem Telefon, das dann seinen Code zeigt.
3. Wähl **Codes vergleichen** und prüf, ob der Code auf der Karte deines Computers mit dem in den Einstellungen des Telefons übereinstimmt.
4. Wähl auf deinem Computer **Bestätigen und erlauben**, der dich um eine Bestätigung bittet.

Von da an bietet die Karte einer Anfrage auf dem Telefon **Einmal erlauben** und **Nicht erlauben** an.
Jedes Erlauben fragt nach Face ID, Touch ID oder dem Code des Telefons.
Eine Entscheidung, die einen Lauf immer erlaubt, wird nur auf deinem Computer gespeichert.
Ein Mac, der deinen ersten Offizier von woanders aus steuert, kann Nutzungen ebenfalls freigeben, auf dieselbe Weise eingerichtet in seiner Zeile.

Zum Beenden schalte den Schalter aus oder wähl **Freigaben beenden** unter **Freigebende Geräte** in **Zugriff, Verlauf & Wiederherstellung**.

## Geheimnisse aus einem anderen Werkzeug übernehmen {#move-secrets-from-another-tool}

Wenn du Geheimnisse in einem anderen Werkzeug aufbewahrst, etwa in Automic Vault, einer .env-Datei oder im Schlüsselbund deines Macs, kann ein Crewmitglied sie in Geheimnisse übernehmen, ohne einen Wert zu sehen.

1. Wähl **Aus einem anderen Werkzeug übernehmen** in Einstellungen → Geheimnisse oder **Geheimnisse aus einem anderen Werkzeug übernehmen** in der Befehlssuche.
2. Dein Nachrichtenfeld beginnt die Anfrage an deinen ersten Offizier; nenn das Werkzeug und schick sie ab.
3. Das Crewmitglied zeigt eine Karte, zum Beispiel „3 Geheimnisse aus Automic Vault übernehmen?“, die den Befehl nennt, den es ausführt, oder die Datei, die es liest, und den Grund.
4. Hak jedes Geheimnis an, das du behalten willst, und wähl dann **In Geheimnisse übernehmen** oder **Nicht übernehmen**.

Infinitary führt den Befehl selbst aus oder liest die Datei selbst und behält nur, was du anhakst.
Bei einer Datei wie einer .env-Datei listet **Datei lesen** zuerst die Namen auf, die sie enthält.
Das Crewmitglied bekommt Namen, nie einen Wert, und die Kopie im anderen Werkzeug bleibt, wie sie ist.
Du wählst die Geheimnisse im Fenster von Infinitary auf dem Computer, auf dem dein erster Offizier lebt, nicht auf deinem Telefon.

Wenn das Werkzeug auf einem anderen deiner Computer liegt, der Arbeit ausführt, nenn diesen Computer in deiner Anfrage, und ein Crewmitglied dort übernimmt die Geheimnisse von ihm.
Die Karte erscheint trotzdem auf dem Computer, auf dem dein erster Offizier lebt, mit einer Zeile **Auf Computer**, die den Computer nennt, auf dem der Befehl läuft.
Wenn du **In Geheimnisse übernehmen** wählst, führt dieser Computer den Befehl aus und schickt nur die angehakten Geheimnisse einmal über die Verbindung zwischen deinen Computern.
**Datei lesen** schickt jeden Wert der Datei einmal, damit die Karte ihre Namen auflisten kann, und Geheimnisse behält trotzdem nur, was du anhakst.

## Schlüssel für deine Integrationen {#keys-for-your-integrations}

Wenn du dich in Einstellungen → **Integrationen** bei Google oder bei einem MCP-Server anmeldest oder einen MCP-Server mit Schlüsseln hinzufügst, bewahrt Infinitary diese Schlüssel in Geheimnisse auf.
Auch das Geheimnis des Google-Clients, den du dort einrichtest, bewahrt es auf.
Geheimnisse listet sie mit **In Integrationen verwalten** statt Ersetzen und Vergessen auf.
Der Schlüssel eines Servers bietet auch **Wert kopieren** an; der Eintrag einer Anmeldung nicht.
Infinitary nutzt sie ohne Rückfrage, denn das Anmelden oder das Hinzufügen des Servers mit seinen Schlüsseln war deine Zustimmung.
Deine Crew kann sie weder sehen noch ihre Nutzung anfragen.
Melde dich in Integrationen ab oder entferne den Server, um sie zu vergessen.
Siehe [Integrationen](/de/integrations/).

## Nutzungsverlauf und Sicherungen {#use-history-and-backups}

Der **Nutzungsverlauf** listet jede Nutzung auf: welche Geheimnisse, den Grund, das Programm, wie sie erlaubt wurde und wie sie endete, nie einen Wert.
Er bleibt, bis du ihn löschst, mit **Verlauf exportieren** und **Verlauf löschen**.

**Sichern und Wiederherstellen** hat **Verschlüsselte Sicherung speichern**, das eine verschlüsselte Kopie und einen separaten Wiederherstellungsschlüssel speichert.
Bewahre sie getrennt auf: Wer beides hat, kann die gespeicherten Werte lesen, und der Schlüssel lässt sich nicht zurücksetzen.
**Aus Sicherung wiederherstellen** ersetzt deine gespeicherten Werte und löscht gespeicherte Entscheidungen, Freigaben per Telefon und befristeten Zugriff.

## Wenn Geheimnisse sich nicht öffnen lassen {#when-secrets-cannot-open}

Wenn der Geheimnisspeicher deines Computers gesperrt ist, zeigt Geheimnisse **Speicher gesperrt** mit **Entsperren oder erneut prüfen**.
Anfragen warten weiter, bis er sich öffnet.

Wenn Infinitary nicht mehr lesen kann, was es aufbewahrt hat, zeigt Geheimnisse **Wiederherstellung nötig** und erlaubt keine Nutzung.
**Wiederherstellungsoptionen** öffnet **Sichern und Wiederherstellen**, um aus einer Sicherung wiederherzustellen.
**Neu beginnen** löscht deine gespeicherten Geheimnisse, gespeicherte Entscheidungen, Freigaben per Telefon und befristeten Zugriff und lässt sich nicht rückgängig machen.

## Angemeldete Websites {#signed-in-sites}

Am Ende von Geheimnisse stehen die **Angemeldeten Websites**: die Websites, bei denen du dich im Browser einer Aufgabe angemeldet hast.
Sie bleiben im Browserprofil dieses Computers, nicht im geschützten Speicher.
Siehe [Der Browser der Crew](/de/the-crews-browser/#signed-in-sites).

## Wenn dein erster Offizier umzieht {#when-your-first-mate-moves}

Wenn dein erster Offizier auf einen anderen Computer umzieht, bleiben deine Geheimnisse auf dem Computer, den er verlässt, und du fügst sie auf dem neuen erneut hinzu.

Ein Computer, der [eine Kopie deines ersten Offiziers aufbewahrt](/de/your-other-computers/#keep-a-copy-on-another-computer), kann auch deine Geheimnisse aufbewahren.
Wähl **Geheimnisse dort behalten** in seiner Liste **Bereit zur Übernahme** in Einstellungen → **Geräte** und bestätige dann auf diesem Computer selbst.
Wenn dein erster Offizier später dorthin umzieht oder [von dieser Kopie aus startet](/de/your-other-computers/#take-over), bringt er die Werte mit.
Wenn dieser Computer schon eigene Geheimnisse aufbewahrt, fragt dort eine Karte, welcher Satz genutzt werden soll.
Gespeicherte Entscheidungen und freigebende Geräte bringt er nicht mit, daher fragt jede Nutzung erneut bei dir nach, und jedes Telefon wird neu eingerichtet.

Siehe auch [Deine anderen Computer](/de/your-other-computers/#move-your-first-mate) und [Was deinen Computer verlässt](/de/what-leaves-your-computer/#secrets).
