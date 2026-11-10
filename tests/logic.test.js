/* Tests der Rechenlogik – ausführen mit:  node tests/logic.test.js
 * Nutzt nur Node-Bordmittel (node:assert), keine Abhängigkeiten. */
'use strict';
const assert = require('node:assert/strict');
const F = require('../app.js');

let n = 0;
let failed = 0;
function test(name, fn) {
  n++;
  try { fn(); console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
let c = 0;
const uid = () => `id${++c}`;

console.log('Rechnungen in Betragsfeldern');
test('100+20 = 120', () => assert.equal(F.evaluate('100+20'), 120));
test('12,5*3 = 37,5', () => assert.equal(F.evaluate('12,5*3'), 37.5));
test('7,50 = 7,5', () => assert.equal(F.evaluate('7,50'), 7.5));
test('1.234,56 = 1234,56', () => assert.equal(F.evaluate('1.234,56'), 1234.56));
test('1.234 = 1234 (Tausenderpunkt)', () => assert.equal(F.evaluate('1.234'), 1234));
test('12.5 = 12,5 (Punkt als Komma)', () => assert.equal(F.evaluate('12.5'), 12.5));
test('Punkt vor Strich: 2+3*4 = 14', () => assert.equal(F.evaluate('2+3*4'), 14));
test('Klammern: (2+3)*4 = 20', () => assert.equal(F.evaluate('(2+3)*4'), 20));
test('× ÷ − : werden erkannt', () => assert.equal(F.evaluate('10×3÷2−1'), 14));
test('Leerzeichen und € ignoriert', () => assert.equal(F.evaluate(' 100 € + 20 € '), 120));
test('Vorzeichen: -200', () => assert.equal(F.evaluate('-200'), -200));
test('angefangene Rechnung "100+" zählt 100', () => assert.equal(F.evaluate('100+'), 100));
test('offene Klammer "(3+4" = 7', () => assert.equal(F.evaluate('(3+4'), 7));
test('leeres Feld = null', () => assert.equal(F.evaluate('  '), null));
test('Unsinn ist ungültig', () => assert.ok(Number.isNaN(F.evaluate('abc'))));
test('kein Code wird ausgeführt', () => assert.ok(Number.isNaN(F.evaluate('alert(1)'))));
test('Division durch 0 ist ungültig', () => assert.ok(Number.isNaN(F.evaluate('5/0'))));
test('ungültig zählt in Summen als 0', () => assert.equal(F.val('1,2,3'), 0));
test('Rundung auf Cent: 10/3 = 3,33', () => assert.equal(F.val('10/3'), 3.33));
test('0,1+0,2 = 0,3 (keine Fließkomma-Fehler)', () => assert.equal(F.val('0,1+0,2'), 0.3));

console.log('\nBeispielmonat (deine Notiz)');
const m1 = F.sampleMonth(uid, '2026-11-01', 1);
let state = { months: [m1] };
let C = F.computeAll(state.months);
let r1 = C.byId[m1.id];
const geschenk = (m) => m.pots.find((p) => p.name === 'Geschenkvorsorge');

test('Übertrag aus Vormonat (erster Monat) = 0', () => assert.equal(r1.carryIn, 0));
test('Einnahmen = 957', () => assert.equal(r1.income, 957));
test('Verfügbar = 0 + 957 = 957', () => assert.equal(r1.available, 957));
test('Ausgaben = 100+104+80+180+60+7,50+40+22 = 593,50', () => assert.equal(r1.expenses, 593.5));
test('Vorsorge-Einzahlungen = 50', () => assert.equal(r1.potDeposits, 50));
test('Geschenkvorsorge: 95 + 50 = 145', () => {
  const g = r1.pots[geschenk(m1).id];
  assert.equal(g.start, 95); assert.equal(g.end, 145);
});
test('Gesamtstand aller Töpfe = 145', () => assert.equal(r1.potsTotal, 145));
test('Übertrag = 957 − 593,50 − 50 − 0 = 313,50', () => assert.equal(r1.carryOut, 313.5));
test('Urlaub: 2.129 bereits gespart (Anfangsstand), kein Einfluss auf Übertrag', () => {
  const u = r1.goals[m1.goals[0].id];
  assert.equal(u.start, 2129); assert.equal(u.end, 2129); assert.equal(r1.goalDeposits, 0);
});
test('Geschenkvorsorge: 95 bereits gesammelt zählt nicht als Abfluss', () => assert.equal(r1.potDeposits, 50));

console.log('\nNeuer Monat aus Vorlage');
const m2 = F.templateFrom(m1, uid, 2);
state.months.push(m2);
C = F.computeAll(state.months);
let r2 = C.byId[m2.id];
test('Datum 01.12.2026', () => assert.equal(m2.date, '2026-12-01'));
test('alle Posten kopiert', () => {
  assert.equal(m2.expenses.length, 8); assert.equal(m2.income.length, 1);
  assert.equal(m2.pots.length, 4); assert.equal(m2.goals.length, 2);
  assert.equal(m2.expenses[2].note, 'sollte 90 sein');
});
test('neue IDs, Topf-Identität (pid) bleibt', () => {
  assert.notEqual(m2.pots[3].id, m1.pots[3].id); assert.equal(m2.pots[3].pid, m1.pots[3].pid);
});
test('Übertrag automatisch = 313,50', () => { assert.equal(r2.carryIn, 313.5); assert.equal(r2.carryManual, false); });
test('Verfügbar = 313,50 + 957 = 1.270,50', () => assert.equal(r2.available, 1270.5));
test('Übertrag Dezember = 627,00', () => assert.equal(r2.carryOut, 627));
test('Geschenkvorsorge läuft weiter: 145 + 50 = 195', () => {
  const g = r2.pots[geschenk(m2).id];
  assert.equal(g.start, 145); assert.equal(g.end, 195);
});

console.log('\nZinsen');
geschenk(m2).interest = '1,23';
C = F.computeAll(state.months); r2 = C.byId[m2.id];
test('Zinsen erhöhen den Topf: 145 + 50 + 1,23 = 196,23', () => assert.equal(r2.pots[geschenk(m2).id].end, 196.23));
test('Zinsen ändern den Übertrag NICHT (bleibt 627)', () => assert.equal(r2.carryOut, 627));
test('Vorsorge-Einzahlungen bleiben 50', () => assert.equal(r2.potDeposits, 50));

console.log('\nAlte Monate bearbeiten → Folgemonate rechnen neu');
m1.expenses[0].amount = '100+20'; // Sonstiges 120 statt 100
C = F.computeAll(state.months); r1 = C.byId[m1.id]; r2 = C.byId[m2.id];
test('November: Übertrag 293,50', () => assert.equal(r1.carryOut, 293.5));
test('Dezember: Übertrag rein 293,50, raus 607,00', () => { assert.equal(r2.carryIn, 293.5); assert.equal(r2.carryOut, 607); });
geschenk(m1).deposit = '70';
C = F.computeAll(state.months); r2 = C.byId[m2.id];
test('Topf im Folgemonat: 95+70=165 → 165+50+1,23 = 216,23', () => assert.equal(r2.pots[geschenk(m2).id].end, 216.23));

console.log('\nManuell überschreiben');
m2.carry = '500';
C = F.computeAll(state.months); r2 = C.byId[m2.id];
test('Übertrag manuell 500 → Verfügbar 1.457', () => { assert.equal(r2.carryManual, true); assert.equal(r2.available, 1457); });
test('Automatischer Wert bleibt sichtbar (957 − 613,50 − 70 = 273,50)', () => assert.equal(r2.carryAuto, 273.5));
m2.carry = '';
geschenk(m2).start = '200';
C = F.computeAll(state.months); r2 = C.byId[m2.id];
test('Topf-Anfangsstand manuell 200 → 200+50+1,23 = 251,23', () => assert.equal(r2.pots[geschenk(m2).id].end, 251.23));

console.log('\nSparziele');
m1.goals[0].deposit = '100';
m2.goals[0].deposit = '100';
C = F.computeAll(state.months); r1 = C.byId[m1.id]; r2 = C.byId[m2.id];
test('Sparziel-Einzahlung mindert Übertrag (Nov: 957 − 613,50 − 70 − 100 = 173,50)', () => assert.equal(r1.carryOut, 173.5));
test('Urlaub läuft weiter: 2.129 + 100 + 100 = 2.329', () => {
  const u = r2.goals[m2.goals[0].id];
  assert.equal(u.start, 2229); assert.equal(u.end, 2329);
});
test('Mit Ziel 3.000: November-Fortschritt 2.229 / 3.000', () => {
  m1.goals[0].target = '3000';
  const u = F.computeAll(state.months).byId[m1.id].goals[m1.goals[0].id];
  assert.ok(Math.abs(u.pct - 2229 / 3000) < 1e-9);
});

console.log('\nSonstiges');
test('Monate werden nach Datum sortiert (Reihenfolge im Array egal)', () => {
  const C2 = F.computeAll([m2, m1]);
  assert.deepEqual(C2.order, [m1.id, m2.id]);
});
test('addMonths: 31.01. → 28.02.', () => assert.equal(F.addMonths('2026-01-31', 1), '2026-02-28'));
test('addMonths: Dezember → Januar', () => assert.equal(F.addMonths('2026-12-01', 1), '2027-01-01'));
test('Format 1.234,56 €', () => assert.equal(F.fmt(1234.56).replace(/ /g, ' '), '1.234,56 €'));
test('Import-Prüfung: leere Datei abgelehnt', () => assert.throws(() => F.normalizeState({}, uid)));
test('Import-Prüfung: fehlende Felder ergänzt', () => {
  const s = F.normalizeState({ months: [{ id: 'a', date: '2026-01-01', expenses: [{ name: 'X', amount: 5 }] }] }, uid);
  assert.equal(s.months[0].expenses[0].amount, '5'); assert.deepEqual(s.months[0].pots, []);
});
test('Text-Export im Notizstil', () => {
  const txt = F.monthText(m1, F.computeAll([m1]).byId[m1.id]);
  assert.match(txt, /^Kontostand 01\.11\.2026/);
  assert.match(txt, /Spotify: 7,50 €/);
  assert.match(txt, /Versicherung: 80 € \(sollte 90 sein\)/);
  assert.match(txt, /Übertrag nächster Monat: /);
});

console.log(`\n${n - failed}/${n} Tests bestanden`);
process.exit(failed ? 1 : 0);
