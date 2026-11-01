# NEON CITIES auf deinem Webspace mit Plesk

Mit dieser Anleitung läuft NEON CITIES dauerhaft unter deiner eigenen Adresse, z. B. `https://neon.deinedomain.de`. Danach brauchst du deinen PC nicht mehr als Server. Du tippst einfach auf der Webseite, und die Overlays in OBS oder TikTok LIVE Studio holen sich alles direkt von deinem Webspace.

**Voraussetzung:** In deinem Plesk gibt es bei der Domain den Punkt **„Node.js“**.

---

## 1. Subdomain anlegen

Nimm am besten eine **eigene Subdomain**. So bleibt deine normale Webseite unangetastet.

1. Plesk → **Websites & Domains** → **Subdomain hinzufügen**
2. Name z. B. `neon` → ergibt `neon.deinedomain.de`
3. Den vorgeschlagenen Ordner (*Dokumentenstamm*) merken, z. B. `/neon.deinedomain.de`
4. Bei der neuen Subdomain unter **SSL/TLS-Zertifikate** ein kostenloses **Let's-Encrypt**-Zertifikat aktivieren

## 2. Dateien hochladen

1. Auf GitHub im Branch mit NEON CITIES auf **Code → Download ZIP** klicken
2. Plesk → **Dateien** → in den Ordner der Subdomain wechseln (z. B. `/neon.deinedomain.de`)
3. Dort eventuell vorhandene Beispieldateien (z. B. `index.html`) löschen
4. **Hochladen** → ZIP-Datei auswählen → danach Rechtsklick auf die ZIP → **Extrahieren**
5. Das ZIP enthält einen Unterordner (z. B. `neon-cities-…`). **Verschiebe dessen Inhalt** eine Ebene höher, direkt in den Subdomain-Ordner.

Danach muss es im Subdomain-Ordner so aussehen:

```
/neon.deinedomain.de/
├── app.cjs          ← Startdatei für Plesk
├── server.js
├── package.json
├── lib/
├── public/          ← das wird der Dokumentenstamm
└── …
```

## 3. Node.js einrichten

Plesk → Subdomain → **Node.js**. Dort eintragen:

| Feld | Wert |
| --- | --- |
| **Node.js-Version** | die höchste angebotene (mindestens 18) |
| **Anwendungsstamm** | `/neon.deinedomain.de` (der Ordner mit `app.cjs`) |
| **Dokumentenstamm** | `/neon.deinedomain.de/public` |
| **Anwendungsmodus** | `production` |
| **Anwendungsstartdatei** | `app.cjs` |
| **Benutzerdefinierte Umgebungsvariablen** | `NEON_KEY` = ein Passwort deiner Wahl |

Dann **„Node.js aktivieren“** klicken (bzw. **„App neu starten“**). „NPM install“ brauchst du nicht, es gibt keine Pakete zu installieren.

> ⚠️ **Setz unbedingt `NEON_KEY`!** Die Seite ist öffentlich im Internet. Ohne Passwort könnte jeder, der die Adresse kennt, Städte eintippen oder alles zurücksetzen. Die Overlays brauchen kein Passwort, denn sie können nur anzeigen.

## 4. Für die schnellste Verbindung (optional)

Plesk → Subdomain → **Apache & nginx-Einstellungen** → den Haken bei **„Proxy-Modus“** entfernen → **OK**.

Damit kommen WebSockets durch, und jeder Buchstabe erscheint ohne Umweg. Kann oder darfst du das nicht ändern, ist das kein Problem: NEON CITIES schaltet dann automatisch auf einen HTTP-Ersatzweg um. Die Steuerung zeigt in diesem Fall oben **„Live · HTTP“**, und es ist trotzdem synchron.

## 5. Testen

- **Steuerung:** `https://neon.deinedomain.de/` → Passwort eingeben → oben steht „Live“
- **Overlay TikTok:** `https://neon.deinedomain.de/overlay?layout=hoch` (1080 × 1920)
- **Overlay YouTube/OBS:** `https://neon.deinedomain.de/overlay?layout=quer` (1920 × 1080)

- **Spiel-Seite (Overlay mit Eingabe):** `https://neon.deinedomain.de/spielen`. Spielbild und Eingabe in einem Fenster, fragt einmal nach dem Passwort.

Die fertigen Links zum Kopieren stehen auch auf der Steuerseite unter **Browserquellen**. Trag sie in OBS oder TikTok LIVE Studio genauso ein wie in der [README](README.md#overlay-in-den-stream-einbauen) beschrieben, nur eben mit deiner Adresse statt `localhost:3000`.

Tippen kannst du jetzt von überall aus, auch vom Handy über das mobile Netz.

## 6. Spielstand

Der Spielstand liegt auf dem Webspace in **`/neon.deinedomain.de/spielstand.json`**, also im Anwendungsstamm. Der Webserver gibt nur den Ordner `public` heraus, deshalb ist die Datei **nicht öffentlich abrufbar**.

**Vom PC auf den Webspace umziehen** (oder umgekehrt):

1. Auf der **alten** Steuerseite (z. B. `http://localhost:3000`) unten bei *Spiel* auf **„⬇ Spielstand herunterladen“** klicken
2. Auf der **neuen** Steuerseite (`https://neon.deinedomain.de`) auf **„⬆ Spielstand hochladen“** klicken und die Datei auswählen
3. Fertig. Alle verbundenen Overlays zeigen sofort den übernommenen Stand.

Alternativ geht es von Hand: `spielstand.json` per Plesk-Dateimanager in den Anwendungsstamm hochladen (**nicht** nach `public`) und in Plesk unter Node.js auf **„App neu starten“** klicken.

Speichere dir ab und zu eine Sicherung mit **„Spielstand herunterladen“**.

## 7. Updates einspielen

1. Neues ZIP herunterladen und wie in Schritt 2 hochladen. Vorhandene Dateien überschreiben.
2. Deine `spielstand.json` bleibt dabei erhalten, denn sie ist im ZIP nicht enthalten.
3. Plesk → Node.js → **„App neu starten“**

---

## Wenn etwas nicht klappt

| Problem | Lösung |
| --- | --- |
| Die Seite zeigt die Plesk-Standardseite | Dokumentenstamm muss auf `…/public` zeigen. Alte `index.html` im Subdomain-Ordner löschen. |
| Fehler 502 / „Web application could not be started“ | Steht die **Anwendungsstartdatei** auf `app.cjs`? Liegt `app.cjs` direkt im Anwendungsstamm? Ist die Node.js-Version 18 oder neuer? Den genauen Fehler zeigt Plesk unter **Logs** der Subdomain. |
| Overlay zeigt „Verbinde mit Neon-Server …“ | Läuft die App (Node.js aktiviert)? Stimmt die Adresse (https)? Einmal „App neu starten“. |
| Steuerung fragt immer wieder nach dem Passwort | Das Passwort muss genau dem Wert von `NEON_KEY` entsprechen. Nach einer Änderung von `NEON_KEY`: „App neu starten“. |
| Oben steht „Live · HTTP“ | Alles in Ordnung. Für WebSockets siehe Schritt 4 (optional). |
| Spielstand nach Update weg | Prüfe, ob `spielstand.json` im Anwendungsstamm liegt (nicht in `public`). Notfalls die letzte Sicherung hochladen. |

Plesk beendet die App, wenn längere Zeit niemand verbunden ist, und startet sie beim nächsten Aufruf automatisch neu. Das ist normal: Der Spielstand wird vorher gespeichert, und die erste Anfrage dauert nur einen Moment länger.
