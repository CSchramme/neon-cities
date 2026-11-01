// Startdatei für Plesk (Node.js-Erweiterung / Phusion Passenger).
// Passenger lädt die Startdatei mit require(); der eigentliche Server ist ein
// ES-Modul und wird deshalb hier per import() geladen. Den Port vergibt
// Passenger automatisch – es muss nichts eingestellt werden.
import('./server.js').catch((err) => {
  console.error('NEON CITIES konnte nicht starten:', err);
  process.exit(1);
});
