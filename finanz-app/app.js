/* Finanzen – persönlicher Monats-Taschenrechner
 * Reines Vanilla-JS, keine Abhängigkeiten. Alle Daten bleiben in localStorage.
 *
 * Aufbau:
 *   1. FinLogic – reine Rechenlogik (ohne DOM, in Node testbar: tests/logic.test.js)
 *   2. UI       – Darstellung und Bedienung (nur im Browser)
 */
'use strict';

/* =====================================================================
 * 1. Rechenlogik
 * ===================================================================== */
const FinLogic = (() => {
  const nfCur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const nfNum = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfInt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });

  /** Rundet kaufmännisch auf Cent (symmetrisch für negative Werte). */
  function round2(x) {
    const s = x < 0 ? -1 : 1;
    return (s * Math.round(Math.abs(x) * 100 + 1e-6)) / 100;
  }

  const isBlank = (raw) => raw == null || String(raw).trim() === '';

  /**
   * Liest eine Zahl im deutschen oder englischen Format:
   * "1.234,56" → 1234.56 · "7,50" → 7.5 · "12.5" → 12.5 · "1.234" → 1234
   */
  function parseNum(tok) {
    let s = tok;
    if (!/^[0-9.,]+$/.test(s)) return NaN;
    if (s.includes(',')) {
      if ((s.match(/,/g) || []).length > 1) return NaN;
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, ''); // Tausenderpunkte
    } else if ((s.match(/\./g) || []).length > 1) {
      return NaN;
    }
    if (s === '.' || s === '') return NaN;
    return parseFloat(s);
  }

  /** Vereinheitlicht Operatorzeichen und entfernt Leerzeichen/€. */
  function normalize(input) {
    return String(input)
      .replace(/[\s  €]/g, '')
      .replace(/[×xX]/g, '*')
      .replace(/[÷:]/g, '/')
      .replace(/[−–—]/g, '-');
  }

  /**
   * Wertet einen Rechenausdruck sicher aus (eigener Parser, kein eval()).
   * Erlaubt: + - * / ( ), × ÷ :, Vorzeichen, deutsches Zahlenformat.
   * Ein angefangener Ausdruck wie "100+" oder "(3+4" wird tolerant ausgewertet.
   * @returns {number|null} null bei leerer Eingabe, NaN bei ungültiger Eingabe
   */
  function evaluate(input) {
    if (input == null) return null;
    let s = normalize(input);
    if (s === '') return null;
    s = s.replace(/[+\-*/(]+$/, ''); // angefangene Operatoren am Ende ignorieren
    if (s === '') return NaN;
    const open = (s.match(/\(/g) || []).length - (s.match(/\)/g) || []).length;
    if (open > 0) s += ')'.repeat(open); // fehlende Klammern schließen

    let i = 0;
    const peek = () => s[i];
    function number() {
      const m = /^[0-9.,]+/.exec(s.slice(i));
      if (!m) throw new Error('Zahl erwartet');
      i += m[0].length;
      const v = parseNum(m[0]);
      if (!Number.isFinite(v)) throw new Error('Zahl ungültig');
      return v;
    }
    function factor() {
      const c = peek();
      if (c === '+') { i++; return factor(); }
      if (c === '-') { i++; return -factor(); }
      if (c === '(') {
        i++;
        const v = expr();
        if (peek() !== ')') throw new Error(') erwartet');
        i++;
        return v;
      }
      return number();
    }
    function term() {
      let v = factor();
      while (peek() === '*' || peek() === '/') {
        const op = s[i++];
        const r = factor();
        v = op === '*' ? v * r : v / r;
      }
      return v;
    }
    function expr() {
      let v = term();
      while (peek() === '+' || peek() === '-') {
        const op = s[i++];
        const r = term();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }
    try {
      const v = expr();
      if (i !== s.length || !Number.isFinite(v)) return NaN;
      return v;
    } catch (e) {
      return NaN;
    }
  }

  /** Betrag eines Feldes; leer oder ungültig zählt als 0. */
  function val(raw) {
    const v = evaluate(raw);
    return v === null || Number.isNaN(v) ? 0 : round2(v);
  }
  const isValid = (raw) => !Number.isNaN(evaluate(raw));
  /** true, wenn das Feld eine Rechnung enthält (nicht nur eine Zahl). */
  const hasOperator = (raw) => /[0-9)][+\-*/]/.test(normalize(raw || ''));

  const sum = (arr) => round2(arr.reduce((a, b) => a + b, 0));

  function sortMonths(months) {
    return months.slice().sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : (a.created || 0) - (b.created || 0));
  }

  /**
   * Berechnet alle Monate in Datumsreihenfolge.
   *   Verfügbar = Übertrag aus Vormonat + Einnahmen
   *   Übertrag  = Verfügbar − Ausgaben − Vorsorge-Einzahlungen − Sparziel-Einzahlungen
   *   Topf-Stand = Anfangsstand + Einzahlung + Zinsen (Zinsen ändern den Übertrag nicht)
   * Anfangsstände und Übertrag kommen automatisch aus dem Vormonat,
   * außer sie sind im Monat manuell überschrieben.
   */
  function computeAll(months) {
    const order = sortMonths(months);
    const byId = {};
    const potBal = {};
    const goalBal = {};
    let prev = null;

    order.forEach((m, idx) => {
      const carryAuto = prev === null ? 0 : prev;
      const carryManual = !isBlank(m.carry);
      const carryIn = carryManual ? val(m.carry) : carryAuto;
      const income = sum(m.income.map((x) => val(x.amount)));
      const available = round2(carryIn + income);
      const expenses = sum(m.expenses.map((x) => val(x.amount)));

      const pots = {};
      for (const p of m.pots) {
        const startAuto = potBal[p.pid] ?? 0;
        const manual = !isBlank(p.start);
        const start = manual ? val(p.start) : startAuto;
        const deposit = val(p.deposit);
        const interest = val(p.interest);
        const end = round2(start + deposit + interest);
        potBal[p.pid] = end;
        pots[p.id] = { startAuto, start, manual, deposit, interest, end };
      }
      const potList = Object.values(pots);
      const potDeposits = sum(potList.map((p) => p.deposit));
      const potInterest = sum(potList.map((p) => p.interest));
      const potsTotal = sum(potList.map((p) => p.end));

      const goals = {};
      for (const g of m.goals) {
        const startAuto = goalBal[g.gid] ?? 0;
        const manual = !isBlank(g.start);
        const start = manual ? val(g.start) : startAuto;
        const deposit = val(g.deposit);
        const target = val(g.target);
        const end = round2(start + deposit);
        goalBal[g.gid] = end;
        goals[g.id] = { startAuto, start, manual, deposit, target, end,
          pct: target > 0 ? end / target : null };
      }
      const goalList = Object.values(goals);
      const goalDeposits = sum(goalList.map((g) => g.deposit));
      const goalsTotal = sum(goalList.map((g) => g.end));

      const carryOut = round2(available - expenses - potDeposits - goalDeposits);

      byId[m.id] = {
        index: idx, prevId: idx > 0 ? order[idx - 1].id : null,
        nextId: idx < order.length - 1 ? order[idx + 1].id : null,
        carryAuto, carryManual, carryIn, income, available, expenses,
        potDeposits, potInterest, potsTotal, goalDeposits, goalsTotal,
        carryOut, pots, goals,
      };
      prev = carryOut;
    });
    return { order: order.map((m) => m.id), byId };
  }

  /** Datum "YYYY-MM-DD" um n Monate verschieben (Tag wird ggf. gekürzt). */
  function addMonths(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1 + n, 1));
    const days = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    const dd = Math.min(d, days);
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  /**
   * Neuer Monat als Vorlage aus einem bestehenden: alle Posten, Töpfe und Ziele
   * werden mit ihren Beträgen kopiert. Übertrag und Anfangsstände laufen automatisch
   * weiter, Zinsen beginnen leer.
   */
  function templateFrom(m, uid, now = Date.now()) {
    const cp = (x) => ({ ...x, id: uid() });
    return {
      id: uid(), created: now, date: addMonths(m.date, 1), carry: '',
      income: m.income.map(cp),
      expenses: m.expenses.map(cp),
      pots: m.pots.map((p) => ({ ...cp(p), start: '', interest: '' })),
      goals: m.goals.map((g) => ({ ...cp(g), start: '' })),
    };
  }

  function emptyMonth(uid, date, now = Date.now()) {
    return { id: uid(), created: now, date, carry: '', income: [], expenses: [], pots: [], goals: [] };
  }

  /** Beispieldaten aus der Notiz des Nutzers. */
  function sampleMonth(uid, date, now = Date.now()) {
    const inc = (name, amount, note = '') => ({ id: uid(), name, amount, note });
    const exp = (name, amount, note = '', budget = '') => ({ id: uid(), name, amount, note, budget });
    const pot = (name, deposit = '', start = '') => ({ id: uid(), pid: uid(), name, deposit, interest: '', start });
    const goal = (name, target = '', deposit = '') => ({ id: uid(), gid: uid(), name, deposit, target, start: '' });
    return {
      id: uid(), created: now, date, carry: '',
      income: [inc('Gehalt', '957')],
      expenses: [
        exp('Sonstiges', '100'), exp('Auto', '104'), exp('Versicherung', '80', 'sollte 90 sein'),
        exp('Tank', '180'), exp('Friseur', '60'), exp('Spotify', '7,50'),
        exp('Telefon', '40'), exp('Claude', '22'),
      ],
      pots: [pot('Auto-Vorsorge'), pot('Autosteuer-Vorsorge'), pot('Garantie-Vorsorge'),
        pot('Geschenkvorsorge', '50', '95')],
      goals: [goal('Urlaub', '2129'), goal('Investition')],
    };
  }

  /** Prüft und vervollständigt importierte Daten. Wirft bei unbrauchbaren Daten. */
  function normalizeState(obj, uid) {
    if (!obj || !Array.isArray(obj.months)) throw new Error('Keine Monatsdaten gefunden');
    const str = (v) => (v == null ? '' : String(v));
    const months = obj.months.map((m) => {
      if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) throw new Error('Monat ohne gültiges Datum');
      const arr = (a) => (Array.isArray(a) ? a : []);
      return {
        id: str(m.id) || uid(), created: Number(m.created) || 0, date: m.date, carry: str(m.carry),
        income: arr(m.income).map((x) => ({ id: str(x.id) || uid(), name: str(x.name), amount: str(x.amount), note: str(x.note) })),
        expenses: arr(m.expenses).map((x) => ({ id: str(x.id) || uid(), name: str(x.name), amount: str(x.amount), note: str(x.note), budget: str(x.budget) })),
        pots: arr(m.pots).map((x) => ({ id: str(x.id) || uid(), pid: str(x.pid) || uid(), name: str(x.name), deposit: str(x.deposit), interest: str(x.interest), start: str(x.start) })),
        goals: arr(m.goals).map((x) => ({ id: str(x.id) || uid(), gid: str(x.gid) || uid(), name: str(x.name), deposit: str(x.deposit), target: str(x.target), start: str(x.start) })),
      };
    });
    return { v: 1, months };
  }

  // ---- Formatierung ----
  const fmt = (x) => nfCur.format(x);
  const fmtNum = (x) => nfNum.format(x);
  /** "100 €" bei ganzen Beträgen, sonst "7,50 €" – für den Notiz-Export. */
  const fmtShort = (x) => (Number.isInteger(round2(x)) ? `${nfInt.format(x)} €` : `${nfNum.format(x)} €`);
  /** Rohwert für ein Eingabefeld: 120.5 → "120,5" */
  const toRaw = (x) => String(round2(x)).replace('.', ',');

  function fmtDate(date) {
    const [y, m, d] = date.split('-');
    return `${d}.${m}.${y}`;
  }
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const MONTHS_SHORT = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const monthName = (date) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  const monthShort = (date) => `${MONTHS_SHORT[Number(date.slice(5, 7)) - 1]} ${date.slice(2, 4)}`;

  /** Monat als Text im Stil einer Apple-Notiz. */
  function monthText(m, r) {
    const named = (x, fallback) => (x.name || '').trim() || fallback;
    const L = [];
    L.push(`Kontostand ${fmtDate(m.date)}`, '');
    L.push(`Übertrag: ${fmtShort(r.carryIn)}`);
    for (const x of m.income) {
      L.push(`${named(x, 'Einnahme')}: ${fmtShort(val(x.amount))}${x.note ? ` (${x.note})` : ''}`);
    }
    L.push(`Verfügbar: ${fmtShort(r.available)}`, '');
    if (m.expenses.length) {
      L.push('Ausgaben:');
      for (const x of m.expenses) {
        L.push(`${named(x, 'Ausgabe')}: ${fmtShort(val(x.amount))}${x.note ? ` (${x.note})` : ''}`);
      }
      L.push(`= ${fmtShort(r.expenses)}`, '');
    }
    if (m.pots.length) {
      L.push('Vorsorge (Tagesgeld):');
      for (const p of m.pots) {
        const c = r.pots[p.id];
        const zins = c.interest ? `, Zinsen ${fmtShort(c.interest)}` : '';
        L.push(`${named(p, 'Topf')}: +${fmtShort(c.deposit)}${zins} → Stand ${fmtShort(c.end)}`);
      }
      L.push(`Gesamtstand Vorsorge: ${fmtShort(r.potsTotal)}`, '');
    }
    if (m.goals.length) {
      L.push('Sparziele:');
      for (const g of m.goals) {
        const c = r.goals[g.id];
        const ziel = c.target > 0 ? ` von ${fmtShort(c.target)}` : '';
        L.push(`${named(g, 'Ziel')}: +${fmtShort(c.deposit)} → ${fmtShort(c.end)}${ziel}`);
      }
      L.push('');
    }
    L.push(`Übertrag nächster Monat: ${fmtShort(r.carryOut)}`);
    return L.join('\n').replace(/ /g, ' ');
  }

  return {
    round2, isBlank, parseNum, evaluate, val, isValid, hasOperator, sortMonths, computeAll,
    addMonths, templateFrom, emptyMonth, sampleMonth, normalizeState, fmt, fmtNum, fmtShort,
    toRaw, fmtDate, monthName, monthShort, monthText,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FinLogic;

/* =====================================================================
 * 2. Oberfläche
 * ===================================================================== */
if (typeof window !== 'undefined' && typeof document !== 'undefined') (function UI() {
  const F = FinLogic;
  const KEY = 'finanzen.v1';
  const UIKEY = 'finanzen.ui.v1';
  const VERSION = '1.0.0';
  const DEL_W = 92; // Breite des Lösch-Buttons beim Wischen

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const todayISO = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const ICON = {
    grip: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M6 12h.01M12 12h.01M18 12h.01" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    redo: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
    left: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
    reset: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  };

  // ---------- Zustand ----------
  function loadJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }
  function loadState() {
    const raw = loadJSON(KEY);
    if (!raw) return { v: 1, months: [] };
    try { return F.normalizeState(raw, uid); } catch (e) { return { v: 1, months: [] }; }
  }

  let state = loadState();
  let ui = Object.assign({ current: null, tab: 'month', statsMode: 'month', lastBackup: null, snooze: 0 },
    loadJSON(UIKEY) || {});
  const expanded = new Set();
  let C = null; // Berechnung aller Monate
  let R = null; // Berechnung des aktuellen Monats

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      toast('Speichern fehlgeschlagen – bitte Backup exportieren!');
    }
  }
  function saveUI() {
    try { localStorage.setItem(UIKEY, JSON.stringify(ui)); } catch (e) { /* egal */ }
  }

  // ---------- Rückgängig / Wiederholen ----------
  const hist = { undo: [], redo: [], key: null };
  /** Merkt den Zustand vor einer Änderung. Tippen im selben Feld wird zusammengefasst. */
  function checkpoint(key) {
    if (key && key === hist.key) return;
    hist.undo.push(JSON.stringify(state));
    if (hist.undo.length > 150) hist.undo.shift();
    hist.redo = [];
    hist.key = key || null;
    updateUndoButtons();
  }
  function undo() {
    if (!hist.undo.length) return;
    hist.redo.push(JSON.stringify(state));
    state = JSON.parse(hist.undo.pop());
    hist.key = null;
    afterHistory();
  }
  function redo() {
    if (!hist.redo.length) return;
    hist.undo.push(JSON.stringify(state));
    state = JSON.parse(hist.redo.pop());
    hist.key = null;
    afterHistory();
  }
  function afterHistory() {
    if (!state.months.find((m) => m.id === ui.current)) ui.current = latestId();
    save();
    saveUI();
    render();
  }
  function updateUndoButtons() {
    $$('[data-act="undo"]').forEach((b) => { b.disabled = !hist.undo.length; });
    $$('[data-act="redo"]').forEach((b) => { b.disabled = !hist.redo.length; });
  }

  // ---------- Hilfen ----------
  const sorted = () => F.sortMonths(state.months);
  const latestId = () => { const s = sorted(); return s.length ? s[s.length - 1].id : null; };
  function curMonth() {
    let m = state.months.find((x) => x.id === ui.current);
    if (!m && state.months.length) { ui.current = latestId(); m = state.months.find((x) => x.id === ui.current); }
    return m || null;
  }
  function recompute() {
    C = F.computeAll(state.months);
    const m = curMonth();
    R = m ? C.byId[m.id] : null;
  }

  let toastTimer = null;
  function toast(msg, action) {
    const t = $('#toast');
    t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
    if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); action.fn(); };
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), action ? 4500 : 2600);
  }

  function showModal(title, bodyHTML, buttons) {
    const m = $('#modal');
    m.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <h3>${esc(title)}</h3><div class="sheet-body">${bodyHTML}</div>
      <div class="sheet-btns">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-mb="${i}">${esc(b.label)}</button>`).join('')}</div></div>`;
    m.hidden = false;
    requestAnimationFrame(() => m.classList.add('open'));
    m.onclick = (e) => {
      if (e.target === m) return closeModal();
      const b = e.target.closest('[data-mb]');
      if (b) { const def = buttons[Number(b.dataset.mb)]; if (def.fn) def.fn(); if (!def.keep) closeModal(); }
    };
  }
  function closeModal() {
    const m = $('#modal');
    m.classList.remove('open');
    setTimeout(() => { m.hidden = true; m.innerHTML = ''; }, 200);
  }

  /* ---------------- Rendering ---------------- */
  function render() {
    recompute();
    $$('.view').forEach((v) => { v.hidden = v.id !== `view-${ui.tab}`; });
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
    if (ui.tab === 'month') renderMonth();
    else if (ui.tab === 'months') renderMonths();
    else if (ui.tab === 'stats') renderStats();
    else renderData();
    $('#summary').hidden = !(ui.tab === 'month' && R);
    document.body.classList.toggle('has-summary', ui.tab === 'month' && !!R);
    updateUndoButtons();
  }

  // ----- Monatsseite -----
  function renderMonth() {
    const view = $('#view-month');
    const m = curMonth();
    if (!m) { view.innerHTML = welcomeHTML(); return; }
    const r = R;
    view.innerHTML = `
      <header class="toolbar">
        <div class="tb-left">
          <button class="icon-btn" data-act="prev" aria-label="Vorheriger Monat" ${r.prevId ? '' : 'disabled'}>${ICON.left}</button>
          <button class="icon-btn" data-act="next" aria-label="Nächster Monat" ${r.nextId ? '' : 'disabled'}>${ICON.right}</button>
        </div>
        <div class="tb-title">${esc(F.monthName(m.date))}</div>
        <div class="tb-right">
          <button class="icon-btn" data-act="undo" aria-label="Rückgängig">${ICON.undo}</button>
          <button class="icon-btn" data-act="redo" aria-label="Wiederholen">${ICON.redo}</button>
          <button class="icon-btn" data-act="text" aria-label="Als Text exportieren">${ICON.share}</button>
        </div>
      </header>
      <div class="page">
        <h1 class="big-title">Kontostand
          <label class="date-wrap"><span>${esc(F.fmtDate(m.date))}</span>
            <input type="date" id="m-date" value="${esc(m.date)}" aria-label="Datum ändern"></label></h1>
        ${backupBannerHTML()}

        <section class="card carry" data-list="month" data-id="${m.id}">
          <div class="carry-row">
            <div><div class="label">Übertrag aus Vormonat</div>
              <button class="reset" data-act="reset" data-field="carry" data-reset-for="carry">${ICON.reset} automatisch</button>
              <span class="auto-tag" data-auto-tag="carry">automatisch</span></div>
            <div class="amt-wrap big"><input class="amt" data-field="carry" data-auto="carry" inputmode="decimal" autocomplete="off" aria-label="Übertrag aus Vormonat"><span class="cur">€</span></div>
          </div>
        </section>

        ${sectionHTML('income', 'Einnahmen', 'green', m.income, '＋ Einnahme')}
        ${sectionHTML('expenses', 'Ausgaben', 'red', m.expenses, '＋ Ausgabe')}

        <section class="sec">
          <div class="sec-head"><h2>Vorsorge-Töpfe <small>Tagesgeld</small></h2><b class="blue" data-out="potDeposits"></b></div>
          <div class="pots-total"><span>Gesamtstand aller Töpfe</span><b class="blue" data-out="potsTotal"></b></div>
          <div class="rows" data-list="pots">${m.pots.map((p) => potHTML(p)).join('')}</div>
          <button class="add" data-act="add" data-list="pots">＋ Topf</button>
        </section>

        <section class="sec">
          <div class="sec-head"><h2>Sparziele</h2><b class="gold" data-out="goalDeposits"></b></div>
          <div class="rows" data-list="goals">${m.goals.map((g) => goalHTML(g)).join('')}</div>
          <button class="add" data-act="add" data-list="goals">＋ Sparziel</button>
        </section>

        <section class="card recap">
          <div class="recap-row"><span>Übertrag aus Vormonat</span><b data-out="carryIn"></b></div>
          <div class="recap-row"><span>+ Einnahmen</span><b class="green" data-out="income"></b></div>
          <div class="recap-row strong"><span>= Verfügbar</span><b data-out="available"></b></div>
          <div class="recap-row"><span>− Ausgaben</span><b class="red" data-out="expensesNeg"></b></div>
          <div class="recap-row"><span>− Vorsorge-Einzahlungen</span><b class="blue" data-out="potDepositsNeg"></b></div>
          <div class="recap-row"><span>− Sparziele</span><b class="gold" data-out="goalDepositsNeg"></b></div>
          <div class="recap-row total"><span>= Übertrag in den nächsten Monat</span><b data-out="carryOut"></b></div>
        </section>

        <div class="actions">
          <button class="btn" data-act="text">Monat als Text</button>
          <button class="btn primary" data-act="new-month">Neuen Monat starten</button>
        </div>
      </div>`;
    updateTotals();
  }

  function sectionHTML(list, title, color, items, addLabel) {
    return `<section class="sec">
      <div class="sec-head"><h2>${title}</h2><b class="${color}" data-out="${list}"></b></div>
      <div class="rows" data-list="${list}">${items.map((it) => lineHTML(list, it)).join('')}</div>
      <button class="add" data-act="add" data-list="${list}">${addLabel}</button>
    </section>`;
  }

  const amtInput = (field, label, extra = '') =>
    `<div class="amt-wrap"><input class="amt" data-field="${field}" inputmode="decimal" autocomplete="off" aria-label="${label}" ${extra}><span class="cur">€</span></div>`;

  function rowShell(list, id, inner, cls = '') {
    return `<div class="row ${cls}" data-list="${list}" data-id="${id}">
      <button class="row-del" data-act="del" tabindex="-1">Löschen</button>
      <div class="row-slide">${inner}</div></div>`;
  }

  function lineHTML(list, it) {
    const open = expanded.has(it.id);
    const isExp = list === 'expenses';
    const extra = open ? `<div class="extra">
        <label class="fld"><span>Notiz</span><input data-field="note" value="${esc(it.note)}" placeholder="z. B. sollte 90 sein" autocomplete="off"></label>
        ${isExp ? `<label class="fld"><span>Budget</span>${amtInput('budget', 'Budget')}</label>` : ''}
        <button class="link danger" data-act="del">Zeile löschen</button></div>` : '';
    return rowShell(list, it.id, `
      <div class="row-main">
        <span class="handle" aria-label="Verschieben">${ICON.grip}</span>
        <input class="name" data-field="name" value="${esc(it.name)}" placeholder="${isExp ? 'Ausgabe' : 'Einnahme'}" autocomplete="off" enterkeyhint="done">
        ${amtInput('amount', 'Betrag')}
        <button class="icon-btn more ${open ? 'on' : ''}" data-act="more" aria-label="Details">${ICON.more}</button>
      </div>
      <div class="meta">${!open && it.note ? `<span class="note">${esc(it.note)}</span>` : ''}${isExp ? `<span class="budget" data-budget="${it.id}"></span>` : ''}</div>
      ${extra}`, isExp ? 'exp' : 'inc');
  }

  function potHTML(p) {
    const open = expanded.has(p.id);
    return rowShell('pots', p.id, `
      <div class="row-main">
        <span class="handle" aria-label="Verschieben">${ICON.grip}</span>
        <input class="name" data-field="name" value="${esc(p.name)}" placeholder="Topf" autocomplete="off" enterkeyhint="done">
        <b class="pot-end blue" data-out="potEnd:${p.id}"></b>
        <button class="icon-btn more ${open ? 'on' : ''}" data-act="more" aria-label="Details">${ICON.more}</button>
      </div>
      <div class="grid2">
        <label class="fld"><span>Einzahlung</span>${amtInput('deposit', 'Einzahlung')}</label>
        <label class="fld"><span>Zinsen</span>${amtInput('interest', 'Zinsen')}</label>
      </div>
      <div class="formula" data-out="potLine:${p.id}"></div>
      ${open ? `<div class="extra">
        <label class="fld"><span>Anfangsstand <em data-auto-tag="potStart:${p.id}">automatisch aus Vormonat</em></span>
          ${amtInput('start', 'Anfangsstand', `data-auto="potStart:${p.id}"`)}</label>
        <button class="reset" data-act="reset" data-field="start" data-reset-for="potStart:${p.id}">${ICON.reset} automatisch</button>
        <button class="link danger" data-act="del">Topf löschen</button></div>` : ''}`, 'card-row pot');
  }

  function goalHTML(g) {
    const open = expanded.has(g.id);
    return rowShell('goals', g.id, `
      <div class="row-main">
        <span class="handle" aria-label="Verschieben">${ICON.grip}</span>
        <input class="name" data-field="name" value="${esc(g.name)}" placeholder="Sparziel" autocomplete="off" enterkeyhint="done">
        <b class="pot-end gold" data-out="goalEnd:${g.id}"></b>
        <button class="icon-btn more ${open ? 'on' : ''}" data-act="more" aria-label="Details">${ICON.more}</button>
      </div>
      <div class="grid2">
        <label class="fld"><span>Einzahlung</span>${amtInput('deposit', 'Einzahlung')}</label>
        <label class="fld"><span>Ziel</span>${amtInput('target', 'Zielbetrag')}</label>
      </div>
      <div class="progress" data-progress="${g.id}"><div class="bar"><i></i></div><span></span></div>
      ${open ? `<div class="extra">
        <label class="fld"><span>Bisher gespart <em data-auto-tag="goalStart:${g.id}">automatisch aus Vormonat</em></span>
          ${amtInput('start', 'Bisher gespart', `data-auto="goalStart:${g.id}"`)}</label>
        <button class="reset" data-act="reset" data-field="start" data-reset-for="goalStart:${g.id}">${ICON.reset} automatisch</button>
        <button class="link danger" data-act="del">Sparziel löschen</button></div>` : ''}`, 'card-row goal');
  }

  function backupBannerHTML() {
    const last = ui.lastBackup ? new Date(ui.lastBackup) : null;
    const days = last ? Math.floor((Date.now() - last) / 864e5) : null;
    if ((days !== null && days < 14) || Date.now() < ui.snooze) return '';
    const txt = last ? `Letztes Backup vor ${days} Tagen.` : 'Noch kein Backup gemacht.';
    return `<div class="banner"><div><b>${txt}</b> iOS kann lokal gespeicherte Daten löschen – sichere regelmäßig als Datei.</div>
      <div class="banner-btns"><button class="btn small" data-act="snooze">Später</button><button class="btn small primary" data-act="export">Backup</button></div></div>`;
  }

  function welcomeHTML() {
    return `<div class="page welcome">
      <div class="logo">€</div>
      <h1>Finanzen</h1>
      <p>Dein Taschenrechner für die Monatsfinanzen. Alles bleibt auf diesem Gerät – nichts wird gesendet.</p>
      <button class="btn primary wide" data-act="sample">Mit Beispieldaten starten</button>
      <button class="btn wide" data-act="empty">Leeren Monat anlegen</button>
      <button class="btn wide ghost" data-act="import">Backup importieren</button>
    </div>`;
  }

  // ----- Werte ohne Neuaufbau aktualisieren (nach jeder Eingabe) -----
  function getRaw(inp) {
    const ctx = inp.closest('[data-id]');
    if (!ctx) return '';
    const obj = findObj(ctx);
    return obj ? (obj[inp.dataset.field] ?? '') : '';
  }
  function autoValue(key) {
    if (!R) return 0;
    if (key === 'carry') return R.carryAuto;
    const [kind, id] = key.split(':');
    if (kind === 'potStart') return R.pots[id]?.startAuto ?? 0;
    if (kind === 'goalStart') return R.goals[id]?.startAuto ?? 0;
    return 0;
  }
  function displayAmt(inp) {
    if (document.activeElement === inp) {
      inp.classList.toggle('invalid', !F.isValid(inp.value));
      return;
    }
    const raw = getRaw(inp);
    inp.classList.remove('is-auto', 'invalid');
    inp.classList.toggle('calc', F.hasOperator(raw));
    if (F.isBlank(raw)) {
      if (inp.dataset.auto) { inp.value = F.fmtNum(autoValue(inp.dataset.auto)); inp.classList.add('is-auto'); }
      else inp.value = '';
      inp.placeholder = '0,00';
    } else {
      const v = F.evaluate(raw);
      if (Number.isNaN(v)) { inp.value = raw; inp.classList.add('invalid'); }
      else inp.value = F.fmtNum(F.round2(v));
    }
  }

  function updateTotals() {
    recompute();
    const m = curMonth();
    if (!m || !R) return;
    const r = R;
    const neg = (x) => F.fmt(x === 0 ? 0 : -x);
    const out = {
      carryIn: F.fmt(r.carryIn), income: F.fmt(r.income), available: F.fmt(r.available),
      expenses: F.fmt(r.expenses), expensesNeg: neg(r.expenses),
      potDeposits: F.fmt(r.potDeposits), potDepositsNeg: neg(r.potDeposits),
      goalDeposits: F.fmt(r.goalDeposits), goalDepositsNeg: neg(r.goalDeposits),
      potsTotal: F.fmt(r.potsTotal), carryOut: F.fmt(r.carryOut),
    };
    for (const p of m.pots) {
      const c = r.pots[p.id];
      out[`potEnd:${p.id}`] = F.fmt(c.end);
      out[`potLine:${p.id}`] = `${F.fmt(c.start)} + ${F.fmt(c.deposit)}${c.interest ? ` + ${F.fmt(c.interest)} Zinsen` : ''} = ${F.fmt(c.end)}`;
    }
    for (const g of m.goals) out[`goalEnd:${g.id}`] = F.fmt(r.goals[g.id].end);

    $$('[data-out]').forEach((el) => {
      const v = out[el.dataset.out];
      if (v !== undefined) el.textContent = v;
    });
    $$('[data-out="carryOut"]').forEach((el) => el.classList.toggle('negative', r.carryOut < 0));

    // Fortschrittsbalken der Sparziele
    for (const g of m.goals) {
      const el = $(`[data-progress="${g.id}"]`);
      if (!el) continue;
      const c = r.goals[g.id];
      el.hidden = c.pct === null;
      if (c.pct !== null) {
        el.querySelector('i').style.width = `${Math.min(100, Math.max(0, c.pct * 100))}%`;
        el.querySelector('span').textContent = `${Math.round(c.pct * 100)} % · noch ${F.fmt(Math.max(0, c.target - c.end))}`;
        el.classList.toggle('done', c.pct >= 1);
      }
    }
    // Budgets
    for (const x of m.expenses) {
      const el = $(`[data-budget="${x.id}"]`);
      if (!el) continue;
      const b = F.val(x.budget);
      const a = F.val(x.amount);
      const over = b > 0 && a > b;
      el.closest('.row').classList.toggle('over', over);
      el.textContent = b > 0 ? (over ? `Budget ${F.fmt(b)} · ${F.fmt(a - b)} drüber` : `Budget ${F.fmt(b)} · ${F.fmt(b - a)} frei`) : '';
    }
    // manuell/automatisch Anzeige
    $$('[data-reset-for]').forEach((b) => {
      const inp = b.closest('[data-id]').querySelector(`[data-auto="${b.dataset.resetFor}"]`);
      const manual = inp && !F.isBlank(getRaw(inp));
      b.hidden = !manual;
      const tag = $(`[data-auto-tag="${b.dataset.resetFor}"]`);
      if (tag) tag.hidden = manual;
    });
    $$('.amt').forEach(displayAmt);
    updateOpPreview();
    $('#summary').classList.toggle('neg', r.carryOut < 0);
  }

  // ----- Monatsliste -----
  function renderMonths() {
    const list = sorted().reverse();
    $('#view-months').innerHTML = `
      <header class="toolbar"><div class="tb-title">Monate</div></header>
      <div class="page">
        <h1 class="big-title">Monate</h1>
        <button class="btn primary wide" data-act="new-month">Neuen Monat starten</button>
        <p class="hint">Tippen zum Öffnen · nach links wischen zum Löschen. Ändert sich ein alter Monat, rechnen sich alle folgenden automatisch neu.</p>
        <div class="rows months">${list.map((m) => {
          const r = C.byId[m.id];
          return `<div class="row mrow ${m.id === ui.current ? 'current' : ''}" data-month="${m.id}">
            <button class="row-del" data-act="del-month" tabindex="-1">Löschen</button>
            <div class="row-slide" data-act="open-month" data-month="${m.id}">
              <div class="m-left"><b>Kontostand ${esc(F.fmtDate(m.date))}</b>
                <small>Ausgaben ${F.fmt(r.expenses)} · Vorsorge ${F.fmt(r.potsTotal)}</small></div>
              <div class="m-right"><small>Übertrag</small><b class="${r.carryOut < 0 ? 'red' : ''}">${F.fmt(r.carryOut)}</b></div>
            </div></div>`;
        }).join('') || '<p class="muted center">Noch keine Monate.</p>'}</div>
      </div>`;
  }

  // ----- Übersicht -----
  function renderStats() {
    const view = $('#view-stats');
    const months = sorted();
    if (!months.length) {
      view.innerHTML = '<header class="toolbar"><div class="tb-title">Übersicht</div></header><div class="page"><h1 class="big-title">Übersicht</h1><p class="muted">Noch keine Daten.</p></div>';
      return;
    }
    const m = curMonth();
    view.innerHTML = `
      <header class="toolbar"><div class="tb-title">Übersicht</div></header>
      <div class="page">
        <h1 class="big-title">Übersicht</h1>
        <div class="tiles">
          <div class="tile"><small>Übertrag ${esc(F.monthShort(m.date))}</small><b class="gold">${F.fmt(R.carryOut)}</b></div>
          <div class="tile"><small>Vorsorge gesamt</small><b class="blue">${F.fmt(R.potsTotal)}</b></div>
          <div class="tile"><small>Ø Ausgaben / Monat</small><b class="red">${F.fmt(F.round2(months.reduce((a, x) => a + C.byId[x.id].expenses, 0) / months.length))}</b></div>
          <div class="tile"><small>Sparziele gesamt</small><b>${F.fmt(R.goalsTotal)}</b></div>
        </div>
        <section class="card">
          <div class="sec-head"><h2>Ausgaben nach Kategorie</h2></div>
          <div class="seg" role="tablist">
            <button data-act="stats-mode" data-mode="month" class="${ui.statsMode === 'month' ? 'on' : ''}">${esc(F.monthName(m.date))}</button>
            <button data-act="stats-mode" data-mode="avg" class="${ui.statsMode === 'avg' ? 'on' : ''}">Ø alle Monate</button>
          </div>
          <div class="chart" id="cat-chart"></div>
        </section>
        <section class="card">
          <div class="sec-head"><h2>Verlauf</h2></div>
          <div class="legend"><span><i class="lg-gold"></i>Übertrag</span><span><i class="lg-blue"></i>Vorsorge gesamt</span><span><i class="lg-red"></i>Ausgaben</span></div>
          <div class="chart" id="line-chart"></div>
        </section>
      </div>`;
    const w = $('#cat-chart').clientWidth || 320;
    $('#cat-chart').innerHTML = catChart(categoryData(m, months), w);
    $('#line-chart').innerHTML = lineChart(months.map((x) => ({
      label: F.monthShort(x.date),
      series: [C.byId[x.id].carryOut, C.byId[x.id].potsTotal, C.byId[x.id].expenses],
    })), w);
  }

  function categoryData(m, months) {
    const agg = new Map();
    const add = (x, factor) => {
      const key = (x.name || 'Ohne Namen').trim().toLowerCase();
      const e = agg.get(key) || { name: (x.name || 'Ohne Namen').trim(), value: 0, budget: 0 };
      e.value += F.val(x.amount) * factor;
      e.budget = F.val(x.budget) || e.budget;
      agg.set(key, e);
    };
    if (ui.statsMode === 'avg') months.forEach((mm) => mm.expenses.forEach((x) => add(x, 1 / months.length)));
    else m.expenses.forEach((x) => add(x, 1));
    return [...agg.values()].map((e) => ({ ...e, value: F.round2(e.value) }))
      .filter((e) => e.value !== 0).sort((a, b) => b.value - a.value);
  }

  function catChart(items, W) {
    if (!items.length) return '<p class="muted">Keine Ausgaben.</p>';
    const max = Math.max(...items.map((i) => Math.max(i.value, i.budget || 0)), 1);
    const rowH = 42;
    const H = items.length * rowH;
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Ausgaben nach Kategorie">`;
    items.forEach((it, i) => {
      const y = i * rowH;
      const bw = Math.max(3, (Math.max(0, it.value) / max) * W);
      const over = it.budget > 0 && it.value > it.budget;
      s += `<text x="0" y="${y + 15}" class="c-label">${esc(it.name)}</text>
        <text x="${W}" y="${y + 15}" text-anchor="end" class="c-val ${over ? 'c-over' : ''}">${esc(F.fmt(it.value))}</text>
        <rect x="0" y="${y + 23}" width="${W}" height="10" rx="5" class="c-track"/>
        <rect x="0" y="${y + 23}" width="${bw}" height="10" rx="5" class="${over ? 'c-bar-over' : 'c-bar'}"/>`;
      if (it.budget > 0) {
        const bx = Math.min(W - 1.5, Math.max(1.5, (it.budget / max) * W));
        s += `<line x1="${bx}" x2="${bx}" y1="${y + 19}" y2="${y + 37}" class="c-budget"><title>Budget ${esc(F.fmt(it.budget))}</title></line>`;
      }
    });
    return `${s}</svg>${items.some((i) => i.budget > 0) ? '<p class="hint small">Senkrechter Strich = Budget</p>' : ''}`;
  }

  function niceStep(range) {
    const raw = range / 4;
    const p = 10 ** Math.floor(Math.log10(raw));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function lineChart(points, W) {
    const H = 230; const pl = 58; const pr = 14; const pt = 14; const pb = 30;
    const all = points.flatMap((p) => p.series);
    let lo = Math.min(0, ...all);
    let hi = Math.max(...all, 1);
    const step = niceStep(hi - lo || 100);
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    if (hi === lo) hi = lo + step;
    const n = points.length;
    const iw = W - pl - pr;
    const x = (i) => pl + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = (v) => pt + ((hi - v) / (hi - lo)) * (H - pt - pb);
    const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
    let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Verlauf über die Monate">`;
    for (let v = lo; v <= hi + 1e-9; v += step) {
      s += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'c-zero' : 'c-grid'}"/>
        <text x="${pl - 8}" y="${y(v) + 4}" text-anchor="end" class="c-axis">${nf.format(v)} €</text>`;
    }
    const every = Math.ceil(n / 6);
    points.forEach((p, i) => {
      const anchor = n > 1 && i === n - 1 ? 'end' : n > 1 && i === 0 ? 'start' : 'middle';
      if (i % every === 0 || i === n - 1) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor}" class="c-axis">${esc(p.label)}</text>`;
    });
    ['c-line-gold', 'c-line-blue', 'c-line-red'].forEach((cls, si) => {
      const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.series[si]).toFixed(1)}`).join(' ');
      if (n > 1) s += `<polyline points="${pts}" class="${cls}"/>`;
      points.forEach((p, i) => { s += `<circle cx="${x(i)}" cy="${y(p.series[si])}" r="${i === n - 1 ? 4.5 : 3}" class="${cls} dot"><title>${esc(p.label)}: ${esc(F.fmt(p.series[si]))}</title></circle>`; });
    });
    return `${s}</svg>`;
  }

  // ----- Daten / Backup -----
  function renderData() {
    const last = ui.lastBackup ? new Date(ui.lastBackup).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : 'noch nie';
    let bytes = 0;
    try { bytes = (localStorage.getItem(KEY) || '').length; } catch (e) { /* egal */ }
    $('#view-data').innerHTML = `
      <header class="toolbar"><div class="tb-title">Daten</div></header>
      <div class="page">
        <h1 class="big-title">Daten &amp; Backup</h1>
        <section class="card info">
          <p><b>Wichtig:</b> Deine Daten liegen nur auf diesem iPhone (im Speicher der Web-App). iOS kann diesen Speicher löschen,
          z. B. wenn die App mehrere Wochen nicht geöffnet wurde oder der Speicher knapp ist. Exportiere deshalb regelmäßig ein Backup
          und lege es in der Dateien-App oder iCloud Drive ab.</p>
          <p class="muted">Letztes Backup: <b>${esc(last)}</b> · ${state.months.length} Monate · ${(bytes / 1024).toFixed(1)} KB</p>
        </section>
        <div class="stack">
          <button class="btn primary wide" data-act="export">Backup exportieren (JSON)</button>
          <button class="btn wide" data-act="import">Backup importieren</button>
          <button class="btn wide" data-act="text" ${curMonth() ? '' : 'disabled'}>Aktuellen Monat als Text</button>
        </div>
        <section class="card info">
          <h2>So wird gerechnet</h2>
          <p><b>Verfügbar</b> = Übertrag aus Vormonat + Einnahmen<br>
          <b>Übertrag</b> = Verfügbar − Ausgaben − Vorsorge-Einzahlungen − Sparziel-Einzahlungen<br>
          <b>Topf-Stand</b> = Anfangsstand + Einzahlung + Zinsen. Zinsen erhöhen nur den Topf, nicht den Übertrag.</p>
          <p class="muted">In Betragsfeldern kannst du rechnen, z. B. <code>100+20</code> oder <code>12,5*3</code>. Beim Tippen erscheint über der Tastatur eine Leiste mit + − × ÷.
          Negative Einzahlung (z. B. <code>-200</code>) = Entnahme aus dem Topf, die wieder ins Monatsgeld fließt.</p>
        </section>
        <div class="stack">
          <button class="btn wide danger" data-act="wipe" ${state.months.length ? '' : 'disabled'}>Alle Daten löschen</button>
        </div>
        <p class="muted center small">Finanzen ${VERSION} · offline · keine Server</p>
      </div>`;
  }

  async function exportJSON() {
    const data = JSON.stringify({ app: 'finanzen', version: VERSION, exported: new Date().toISOString(), ...state }, null, 2);
    const name = `finanzen-backup-${todayISO()}.json`;
    const file = new File([data], name, { type: 'application/json' });
    const done = () => { ui.lastBackup = Date.now(); saveUI(); render(); toast('Backup erstellt'); };
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return done();
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return undefined;
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return done();
  }

  function importJSON(file) {
    const rd = new FileReader();
    rd.onload = () => {
      let next;
      try { next = F.normalizeState(JSON.parse(rd.result), uid); } catch (e) {
        toast(`Import fehlgeschlagen: ${e.message || 'ungültige Datei'}`); return;
      }
      const go = () => {
        checkpoint('import');
        state = next;
        ui.current = latestId();
        ui.tab = 'month';
        save(); saveUI(); render();
        toast(`${next.months.length} Monate importiert`, { label: 'Rückgängig', fn: undo });
      };
      if (!state.months.length) return go();
      showModal('Backup importieren?', `<p>Die Datei enthält <b>${next.months.length} Monate</b>. Deine aktuellen Daten (${state.months.length} Monate) werden ersetzt.</p>`,
        [{ label: 'Abbrechen' }, { label: 'Ersetzen', cls: 'primary', fn: go }]);
    };
    rd.readAsText(file);
  }

  function showText() {
    const m = curMonth();
    if (!m) return;
    recompute();
    const txt = F.monthText(m, R);
    showModal('Monat als Text', `<textarea class="export-txt" readonly rows="14">${esc(txt)}</textarea>
      <p class="hint small">Zum Einfügen in Apple Notizen.</p>`, [
      { label: 'Schließen' },
      ...(navigator.share ? [{ label: 'Teilen', keep: true, fn: () => navigator.share({ text: txt }).catch(() => {}) }] : []),
      { label: 'Kopieren', cls: 'primary', keep: true, fn: () => copyText(txt) },
    ]);
  }
  async function copyText(txt) {
    try { await navigator.clipboard.writeText(txt); toast('In die Zwischenablage kopiert'); } catch (e) {
      const ta = $('.export-txt');
      if (ta) { ta.removeAttribute('readonly'); ta.select(); document.execCommand('copy'); ta.setAttribute('readonly', ''); toast('Kopiert'); }
    }
  }

  // ---------- Aktionen ----------
  function findObj(ctx) {
    const m = curMonth();
    if (!m) return null;
    const list = ctx.dataset.list;
    if (list === 'month') return m;
    return (m[list] || []).find((x) => x.id === ctx.dataset.id) || null;
  }

  function newItem(list) {
    const base = { id: uid(), name: '' };
    if (list === 'income') return { ...base, amount: '', note: '' };
    if (list === 'expenses') return { ...base, amount: '', note: '', budget: '' };
    if (list === 'pots') return { ...base, pid: uid(), deposit: '', interest: '', start: '' };
    return { ...base, gid: uid(), deposit: '', target: '', start: '' };
  }

  function addRow(list) {
    const m = curMonth();
    checkpoint('add');
    const it = newItem(list);
    m[list].push(it);
    save();
    renderMonth();
    const inp = $(`.row[data-id="${it.id}"] .name`);
    if (inp) { inp.focus(); inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }

  function deleteItem(row) {
    const m = curMonth();
    const list = row.dataset.list;
    const idx = m[list].findIndex((x) => x.id === row.dataset.id);
    if (idx < 0) return;
    const name = m[list][idx].name || 'Zeile';
    checkpoint('del');
    m[list].splice(idx, 1);
    save();
    row.classList.add('removing');
    setTimeout(() => { renderMonth(); }, 180);
    toast(`„${name}“ gelöscht`, { label: 'Rückgängig', fn: undo });
  }

  function deleteMonth(id) {
    const m = state.months.find((x) => x.id === id);
    if (!m) return;
    showModal('Monat löschen?', `<p>„Kontostand ${esc(F.fmtDate(m.date))}“ wird gelöscht. Folgemonate rechnen sich neu.</p>`, [
      { label: 'Abbrechen', fn: () => renderMonths() },
      { label: 'Löschen', cls: 'danger', fn: () => {
        checkpoint('del-month');
        state.months = state.months.filter((x) => x.id !== id);
        if (ui.current === id) ui.current = latestId();
        save(); saveUI(); render();
        toast('Monat gelöscht', { label: 'Rückgängig', fn: undo });
      } },
    ]);
  }

  function newMonth() {
    const s = sorted();
    checkpoint('new-month');
    let m;
    if (!s.length) {
      const t = todayISO();
      m = F.emptyMonth(uid, `${t.slice(0, 8)}01`);
    } else {
      m = F.templateFrom(s[s.length - 1], uid);
    }
    state.months.push(m);
    ui.current = m.id;
    ui.tab = 'month';
    save(); saveUI(); render();
    window.scrollTo({ top: 0 });
    toast(`${F.monthName(m.date)} angelegt`);
  }

  function go(tab) {
    ui.tab = tab;
    saveUI();
    render();
    window.scrollTo({ top: 0 });
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act],[data-tab]');
    if (!t || t.disabled) return;
    if (t.dataset.tab) return go(t.dataset.tab);
    const act = t.dataset.act;
    const row = t.closest('.row');
    switch (act) {
      case 'prev': case 'next': {
        const id = act === 'prev' ? R.prevId : R.nextId;
        if (id) { ui.current = id; saveUI(); render(); }
        break;
      }
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'text': showText(); break;
      case 'new-month': newMonth(); break;
      case 'add': addRow(t.dataset.list); break;
      case 'more': {
        const id = row.dataset.id;
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        renderMonth();
        break;
      }
      case 'del': if (row) deleteItem(row); break;
      case 'del-month': deleteMonth(row.dataset.month); break;
      case 'reset': {
        const ctx = t.closest('[data-id]');
        const obj = findObj(ctx);
        checkpoint('reset');
        obj[t.dataset.field] = '';
        save(); updateTotals();
        break;
      }
      case 'open-month': {
        const slide = t;
        if (slide.classList.contains('open')) { closeSwipe(slide); break; }
        ui.current = t.dataset.month; go('month');
        break;
      }
      case 'stats-mode': ui.statsMode = t.dataset.mode; saveUI(); renderStats(); break;
      case 'export': exportJSON(); break;
      case 'import': $('#import-file').click(); break;
      case 'snooze': ui.snooze = Date.now() + 3 * 864e5; saveUI(); renderMonth(); break;
      case 'sample': {
        checkpoint('sample');
        const t0 = todayISO();
        const m = F.sampleMonth(uid, `${t0.slice(0, 8)}01`);
        state.months.push(m); ui.current = m.id;
        save(); saveUI(); render();
        break;
      }
      case 'empty': newMonth(); break;
      case 'wipe':
        showModal('Alle Daten löschen?', '<p>Alle Monate werden von diesem Gerät gelöscht. Mache vorher ein Backup!</p>', [
          { label: 'Abbrechen' },
          { label: 'Alles löschen', cls: 'danger', fn: () => {
            checkpoint('wipe'); state = { v: 1, months: [] }; ui.current = null; save(); saveUI(); render();
            toast('Alle Daten gelöscht', { label: 'Rückgängig', fn: undo });
          } },
        ]);
        break;
      default: break;
    }
  });

  document.getElementById('import-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importJSON(f);
    e.target.value = '';
  });

  // Eingaben: jede Änderung sofort speichern und neu rechnen
  document.addEventListener('input', (e) => {
    const inp = e.target;
    if (inp.id === 'm-date') return;
    if (!inp.dataset || !inp.dataset.field) return;
    const ctx = inp.closest('[data-id]');
    const obj = ctx && findObj(ctx);
    if (!obj) return;
    checkpoint(`${ctx.dataset.id}.${inp.dataset.field}`);
    obj[inp.dataset.field] = inp.value;
    save();
    if (inp.classList.contains('amt') || inp.dataset.field === 'budget') updateTotals();
  });

  document.addEventListener('change', (e) => {
    if (e.target.id !== 'm-date') return;
    const m = curMonth();
    if (!e.target.value || e.target.value === m.date) return;
    checkpoint('date');
    m.date = e.target.value;
    save();
    renderMonth();
  });

  // Fokus: Betragsfeld zeigt beim Bearbeiten die Rohformel, sonst das Ergebnis
  document.addEventListener('focusin', (e) => {
    const inp = e.target;
    if (!(inp instanceof HTMLInputElement)) return;
    if (inp.type !== 'date' && inp.type !== 'file') document.body.classList.add('kbd');
    if (!inp.classList.contains('amt')) { hideOpBar(); return; }
    const raw = getRaw(inp);
    inp.classList.remove('is-auto');
    inp.value = raw;
    if (inp.dataset.auto && F.isBlank(raw)) inp.placeholder = F.fmtNum(autoValue(inp.dataset.auto));
    showOpBar(inp);
    // alles markieren, damit man direkt überschreiben kann
    setTimeout(() => { try { if (document.activeElement === inp && inp.value) inp.setSelectionRange(0, inp.value.length); } catch (err) { /* egal */ } }, 0);
  });
  document.addEventListener('focusout', (e) => {
    const inp = e.target;
    hist.key = null;
    if (inp.classList && inp.classList.contains('amt')) displayAmt(inp);
    setTimeout(() => {
      const a = document.activeElement;
      if (!(a instanceof HTMLInputElement) || a.type === 'date') document.body.classList.remove('kbd');
      if (!(a && a.classList && a.classList.contains('amt'))) hideOpBar();
    }, 60);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement) e.target.blur();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !(e.target instanceof HTMLInputElement)) {
      e.preventDefault(); if (e.shiftKey) redo(); else undo();
    }
  });

  // ---------- Rechenleiste über der Tastatur ----------
  const opbar = $('#opbar');
  let opTarget = null;
  function showOpBar(inp) {
    opTarget = inp;
    opbar.hidden = false;
    placeOpBar();
    updateOpPreview();
  }
  function hideOpBar() { opTarget = null; opbar.hidden = true; }
  function placeOpBar() {
    if (opbar.hidden) return;
    const vv = window.visualViewport;
    const h = opbar.offsetHeight;
    const top = vv ? vv.offsetTop + vv.height - h : window.innerHeight - h;
    opbar.style.top = `${Math.max(0, top)}px`;
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', placeOpBar);
    window.visualViewport.addEventListener('scroll', placeOpBar);
  }
  function updateOpPreview() {
    if (!opTarget) return;
    const v = F.evaluate(opTarget.value);
    const pv = $('#op-preview');
    if (v === null) pv.textContent = '';
    else if (Number.isNaN(v)) pv.textContent = 'ungültig';
    else pv.textContent = F.hasOperator(opTarget.value) ? `= ${F.fmt(F.round2(v))}` : '';
    pv.classList.toggle('red', Number.isNaN(v));
  }
  function opPress(op) {
    const inp = opTarget;
    if (!inp) return;
    if (op === 'done') { inp.blur(); return; }
    if (op === '=') {
      const v = F.evaluate(inp.value);
      if (v === null || Number.isNaN(v)) return;
      inp.value = F.toRaw(v);
    } else {
      const s = inp.selectionStart ?? inp.value.length;
      const en = inp.selectionEnd ?? inp.value.length;
      inp.setRangeText(op, s, en, 'end');
    }
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const opHandler = (e) => {
    const b = e.target.closest('[data-op]');
    e.preventDefault(); // Fokus im Feld behalten
    if (b) opPress(b.dataset.op);
  };
  opbar.addEventListener('touchstart', opHandler, { passive: false });
  opbar.addEventListener('mousedown', opHandler);

  // ---------- Wischen zum Löschen ----------
  let sw = null;
  function closeSwipe(slide) {
    slide.style.transform = '';
    slide.classList.remove('open');
    setTimeout(() => { if (!slide.classList.contains('open')) slide.parentElement.classList.remove('swiping'); }, 230);
  }
  document.addEventListener('touchstart', (e) => {
    const slide = e.target.closest('.row-slide');
    $$('.row-slide.open').forEach((s) => { if (s !== slide) closeSwipe(s); });
    if (!slide || e.target.closest('.handle')) { sw = null; return; }
    const t = e.touches[0];
    sw = { slide, x0: t.clientX, y0: t.clientY, base: slide.classList.contains('open') ? -DEL_W : 0, mode: null, x: 0 };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!sw || drag) return;
    const t = e.touches[0];
    const dx = t.clientX - sw.x0;
    const dy = t.clientY - sw.y0;
    if (!sw.mode) {
      if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        sw.mode = 'h';
        sw.slide.style.transition = 'none';
        sw.slide.parentElement.classList.add('swiping');
        if (document.activeElement && sw.slide.contains(document.activeElement)) document.activeElement.blur();
      } else if (Math.abs(dy) > 10) { sw = null; return; } else return;
    }
    e.preventDefault();
    const w = sw.slide.offsetWidth;
    sw.x = Math.min(0, sw.base + dx);
    sw.slide.style.transform = `translateX(${sw.x}px)`;
    sw.slide.parentElement.classList.toggle('armed', sw.x < -w * 0.5);
  }, { passive: false });
  document.addEventListener('touchend', () => {
    if (!sw || sw.mode !== 'h') { sw = null; return; }
    const { slide } = sw;
    const row = slide.parentElement;
    const w = slide.offsetWidth;
    slide.style.transition = '';
    if (sw.x < -w * 0.5) {
      slide.style.transform = `translateX(${-w}px)`;
      if (row.dataset.month) { closeSwipe(slide); row.classList.remove('armed'); deleteMonth(row.dataset.month); }
      else deleteItem(row);
    } else if (sw.x < -DEL_W / 2) {
      slide.style.transform = `translateX(${-DEL_W}px)`;
      slide.classList.add('open');
    } else closeSwipe(slide);
    row.classList.remove('armed');
    sw = null;
  });

  // ---------- Drag & Drop zum Sortieren (am Griff ⋮⋮) ----------
  let drag = null;
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.handle');
    if (!h) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const row = h.closest('.row');
    const list = row.parentElement;
    const rows = $$(':scope > .row', list);
    const idx = rows.indexOf(row);
    const rects = rows.map((r) => r.getBoundingClientRect());
    const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 8;
    drag = { row, list, rows, idx, rects, gap, y0: e.clientY, to: idx };
    row.classList.add('dragging');
    list.classList.add('sorting');
    try { h.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
    if (navigator.vibrate) navigator.vibrate(8);
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const d = drag;
    const dy = e.clientY - d.y0;
    d.row.style.transform = `translateY(${dy}px)`;
    const c = d.rects[d.idx].top + d.rects[d.idx].height / 2 + dy;
    let to = d.idx;
    d.rects.forEach((r, j) => {
      const mid = r.top + r.height / 2;
      if (j > d.idx && c > mid) to = j;
      else if (j < d.idx && c < mid && j < to) to = j;
    });
    d.to = to;
    const shift = d.rects[d.idx].height + d.gap;
    d.rows.forEach((r, j) => {
      if (j === d.idx) return;
      let ty = 0;
      if (d.idx < to && j > d.idx && j <= to) ty = -shift;
      if (d.idx > to && j >= to && j < d.idx) ty = shift;
      r.style.transform = ty ? `translateY(${ty}px)` : '';
    });
    // Am Rand automatisch scrollen
    if (e.clientY < 90) window.scrollBy(0, -8);
    else if (e.clientY > window.innerHeight - 160) window.scrollBy(0, 8);
  });
  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.rows.forEach((r) => { r.style.transform = ''; });
    d.row.classList.remove('dragging');
    d.list.classList.remove('sorting');
    if (d.to !== d.idx) {
      const m = curMonth();
      const arr = m[d.list.dataset.list];
      checkpoint('move');
      const [it] = arr.splice(d.idx, 1);
      arr.splice(d.to, 0, it);
      save();
      renderMonth();
    }
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // ---------- Start ----------
  window.addEventListener('resize', () => { if (ui.tab === 'stats') renderStats(); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('./service-worker.js').catch(() => {}));
  }
  render();
})();
