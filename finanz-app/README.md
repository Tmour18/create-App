# Finanzen – Monats-Taschenrechner (PWA)

Persönliche Finanz-App für das iPhone: statische Web-App, kein Backend, keine Abhängigkeiten.
Alle Daten bleiben im `localStorage` des Geräts.

| Datei | Zweck |
|---|---|
| `index.html` | Grundgerüst, Tab-Leiste, Zusammenfassung, Rechenleiste |
| `style.css` | Dark-Design, Safe-Area, große Touch-Flächen |
| `app.js` | Rechenlogik (`FinLogic`) + Oberfläche |
| `manifest.json`, `service-worker.js` | Installierbar und offlinefähig |
| `icons/` | App-Icons (u. a. `apple-touch-icon.png` für iOS) |
| `tests/logic.test.js` | Tests der Rechenlogik: `node tests/logic.test.js` |

## Rechenlogik
- Verfügbar = Übertrag aus Vormonat + Einnahmen
- Übertrag = Verfügbar − Ausgaben − Vorsorge-Einzahlungen − Sparziel-Einzahlungen
- Topf-Stand = Anfangsstand + Einzahlung + Zinsen (Zinsen ändern den Übertrag nicht)

Übertrag und Anfangsstände kommen automatisch aus dem Vormonat und lassen sich pro Monat überschreiben.

## Updates
Nach Änderungen an den Dateien in `service-worker.js` die Konstante `CACHE` erhöhen
(z. B. `finanzen-v2`), damit das iPhone die neue Version lädt (App zweimal öffnen).
