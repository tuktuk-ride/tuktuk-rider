// Admin "Cost per km" tab: works out what one km costs to run (the trip expenses, no profit).
//   expenses per km = fuel + servicing + tyres + repairs + depreciation + fixed costs (+ driver income)
// "Use as my expenses per km" puts the result in Settings → Fare rates, where the profit margins turn it into the
// one way / empty return / round trip prices (tripPerKm in js/settings.js).
// Default figures per vehicle type come from config.json. Each vehicle type keeps its own figures on this phone;
// changes calculate straight away but are only kept when "Save vehicle costs" is pressed.
// Used by admin.js:  CostCalc.init({ getCurrent(vehicle), onUseExpense(expensePerKm, vehicle), openFareTab(vehicle) })
//                    and CostCalc.refresh()
const CostCalc = (() => {
  const el = (id) => document.getElementById(id);
  const STORE_KEY = COST_STORE_KEY; // js/settings.js

  // Vehicle types and their default figures, loaded from config.json
  let VEHICLES = {};
  let defaultVehicle = 'tuktuk';

  async function loadConfig() {
    const cfg = await loadAppConfig();
    VEHICLES = Object.fromEntries(Object.entries(cfg.vehicles).filter(([, v]) => v.costDefaults));
    if (!Object.keys(VEHICLES).length) throw new Error('no cost figures in config.json');
    defaultVehicle = VEHICLES[cfg.defaultVehicle] ? cfg.defaultVehicle : Object.keys(VEHICLES)[0];
  }

  const COST_FIELDS = [
    { id: 'fuelPrice', label: 'Fuel price (per litre)' },
    { id: 'kmPerLitre', label: 'Fuel efficiency (km per litre)' },
    { id: 'serviceCost', label: 'Servicing cost (each service)' },
    { id: 'serviceKm', label: 'Km between services' },
    { id: 'tyreCost', label: 'Tyre set cost' },
    { id: 'tyreKm', label: 'Km a tyre set lasts' },
    { id: 'repairsPerKm', label: 'Repairs & wear (per km)', note: 'Brake pads, battery, clutch, etc.' },
    { id: 'depreciationPerKm', label: 'Depreciation (per km)', note: 'Loss of vehicle value with mileage' },
    { id: 'yearlyFixed', label: 'Yearly fixed costs', note: 'Insurance, licence, emission test, lease' },
    { id: 'kmPerYear', label: 'Km driven per year' },
    { id: 'driverMonthly', label: 'Driver income target (per month)', note: 'Optional. 0 = not included' }
  ];
  const TRIP_FIELDS = [{ id: 'tripKm', label: 'Trip distance (km, one way)' }];
  const ALL_FIELDS = COST_FIELDS.concat(TRIP_FIELDS);
  const fid = (id) => 'cc_' + id; // input ids, kept apart from the Settings form ids

  let store = { vehicle: '', figures: {} };
  let hooks = { getCurrent: () => null, onUseExpense: () => {}, openFareTab: () => {} };
  let lastExpense = 0;
  let defaultsLoaded = false; // "Defaults" pressed and not saved yet

  const s = () => loadSettings();
  const money = (n) => formatMoney(Math.round(n * 100) / 100, s());

  // ---------- Storage ----------
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved) store = { vehicle: VEHICLES[saved.vehicle] ? saved.vehicle : defaultVehicle, figures: saved.figures || {} };
      else store.vehicle = defaultVehicle;
    } catch (e) { /* storage blocked */ }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage blocked */ }
  }
  const figuresFor = (v) => ({ ...VEHICLES[v].costDefaults, ...(store.figures[v] || {}) });

  // Form differs from what is saved for this vehicle type?
  function isDirty() {
    if (!el('cc_fuelPrice')) return false;
    const form = readFigures(), saved = figuresFor(store.vehicle);
    return ALL_FIELDS.some((f) => form[f.id] !== Number(saved[f.id] ?? 0));
  }

  function saveFigures() {
    store.figures[store.vehicle] = readFigures();
    defaultsLoaded = false;
    save();
  }

  function showFiguresStatus() {
    const dirty = isDirty();
    const name = VEHICLES[store.vehicle].name;
    const text = defaultsLoaded && dirty ? `Default ${name} figures loaded — press Save to keep them.`
      : dirty ? '● Unsaved changes — press Save to keep them.' : `✓ ${name} figures saved.`;
    document.querySelectorAll('.cc-figures-status').forEach((p) => {
      p.textContent = text;
      p.classList.toggle('unsaved', dirty);
    });
    document.querySelectorAll('.cc-save-figures').forEach((b) => {
      b.disabled = !dirty;
      b.textContent = dirty ? `💾 Save ${name} costs` : '✓ Saved';
    });
  }

  // ---------- Form ----------
  function buildInputs(fields, containerId) {
    fields.forEach((f) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = `<label for="${fid(f.id)}"></label>
        <input type="number" id="${fid(f.id)}" inputmode="decimal" min="0" step="any">
        ${f.note ? '<p class="hint"></p>' : ''}`;
      wrap.querySelector('label').textContent = f.label;
      if (f.note) wrap.querySelector('.hint').textContent = f.note;
      el(containerId).appendChild(wrap);
    });
  }
  const readFigures = () => Object.fromEntries(ALL_FIELDS.map((f) => [f.id, Math.max(0, parseFloat(el(fid(f.id)).value) || 0)]));
  const fillFigures = (fig) => ALL_FIELDS.forEach((f) => (el(fid(f.id)).value = fig[f.id] ?? 0));

  function row(label, value, note = '', strong = false) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td><td></td>';
    tr.cells[0].textContent = label;
    if (note) {
      const small = document.createElement('div');
      small.className = 'row-note';
      small.textContent = note;
      tr.cells[0].appendChild(small);
    }
    tr.cells[1].textContent = value;
    if (strong) tr.classList.add('strong');
    return tr;
  }

  // ---------- Draw ----------
  function render() {
    const x = readFigures();
    const parts = tripExpenseParts(x); // js/settings.js
    const expense = Math.round(parts.reduce((sum, p) => sum + p[1], 0) * 100) / 100;
    lastExpense = expense;
    showFiguresStatus();

    const rate = el('ccRateTable');
    rate.innerHTML = '';
    parts.forEach(([label, value, note]) => rate.appendChild(row(label, money(value), note)));
    rate.appendChild(row('Trip expenses per km', money(expense), 'No profit', true));
    el('ccExpense').textContent = money(expense);

    // What the app uses now, and the prices these expenses would give with this phone's profit margins
    const name = VEHICLES[store.vehicle].name;
    const cur = hooks.getCurrent(store.vehicle) || { settings: s(), expensePerKm: 0, source: '' };
    const same = Math.abs(cur.expensePerKm - expense) < 0.005;
    el('ccCompare').textContent = `The app now uses ${money(cur.expensePerKm)} per km as the ${name} expenses (${cur.source}).` +
      (same ? ' That is the same as your figures.' : ` Your figures give ${money(expense)}.`);
    el('ccUseBtn').textContent = same ? `✓ ${money(expense)} is your ${name} expenses per km` : `✅ Use ${money(expense)} as my ${name} expenses per km`;
    el('ccUseBtn').disabled = same || !(expense > 0);
    const fs = { ...cur.settings, expensePerKm: expense };
    const p = tripPrices(fs);
    el('ccPrices').textContent = `With your profit margins (one way ${fs.oneWayProfitPct}%, round trip ${fs.roundTripProfitPct}%), ` +
      `per km: one way ${money(p.oneway)} • empty return ${money(p.empty)} • round trip ${money(p.round)}. ` +
      'Change the margins in Settings → Fare rates.';
    el('ccOpenFareBtn').textContent = `Open the ${VEHICLES[store.vehicle].icon || ''} ${name} fare rates`.replace('  ', ' ');

    // Test a trip: each trip type with its expenses and profit, then the minimum fare and rounding from Settings.
    // Per km amounts as the app charges them (price per km to 2 decimals), so the lines add up to the fare.
    const trip = el('ccTripTable');
    trip.innerHTML = '';
    const add = (n) => '+ ' + money(n);
    Object.keys(TRIP_TYPES).forEach((t) => {
      const f = calculateFare(x.tripKm, fs, 0, t);
      const km = f.km;
      const ways = t === 'oneway' ? 1 : 2;
      const profitPerKm = Math.round((p[t] - expense * ways) * 100) / 100;
      const pct = t === 'round' ? fs.roundTripProfitPct : fs.oneWayProfitPct;
      const head = row(`${TRIP_TYPES[t].name} — ${km} km × ${money(p[t])}`, '', TRIP_TYPES[t].info, true);
      head.classList.add('trip-head');
      trip.appendChild(head);
      if (t === 'oneway') {
        trip.appendChild(row(`Expenses (${km} km × ${money(expense)})`, money(km * expense)));
      } else if (t === 'empty') {
        trip.appendChild(row(`Expenses there (${km} km × ${money(expense)})`, money(km * expense)));
        trip.appendChild(row(`Expenses back, empty (${km} km × ${money(expense)})`, add(km * expense)));
      } else {
        trip.appendChild(row(`Expenses there + back (2 × ${km} km × ${money(expense)})`, money(2 * km * expense)));
      }
      trip.appendChild(row(`Profit ${pct}%${t === 'empty' ? ', one way only' : ''} (${km} km × ${money(profitPerKm)})`, add(km * profitPerKm)));
      trip.appendChild(row('Total', money(f.kmPart)));
      if (f.minimumApplied) trip.appendChild(row('Minimum fare applied', money(f.minimumFare)));
      trip.appendChild(row(`Fare (${roundingText(fs)})`, money(f.total), '', true));
    });
  }

  // ---------- Setup ----------
  async function init(opts) {
    hooks = { ...hooks, ...opts };
    if (!el('cc_fuelPrice')) {
      try {
        await loadConfig();
      } catch (e) {
        el('ccLoadError').textContent = 'Could not load the default figures (config.json). Check your internet connection and reopen Admin.';
        el('ccLoadError').classList.remove('hidden');
        return;
      }
      // Vehicle type dropdown from config.json
      Object.entries(VEHICLES).forEach(([key, v]) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `${v.icon || ''} ${v.name}`.trim();
        el('ccVehicle').appendChild(opt);
      });
      buildInputs(COST_FIELDS, 'ccCostInputs');
      buildInputs(TRIP_FIELDS, 'ccTripInputs');
      el('costPanel').addEventListener('input', (e) => { if (e.target.id !== 'ccVehicle') render(); });

      el('ccVehicle').addEventListener('change', () => {
        const next = el('ccVehicle').value;
        if (isDirty() && !confirm(`You have unsaved ${VEHICLES[store.vehicle].name} figures. Switch to ${VEHICLES[next].name} without saving them?`)) {
          el('ccVehicle').value = store.vehicle; // stay
          return;
        }
        store.vehicle = next;
        defaultsLoaded = false;
        save(); // remember the vehicle type only
        fillFigures(figuresFor(store.vehicle));
        render();
      });
      document.querySelectorAll('.cc-save-figures').forEach((b) => b.addEventListener('click', () => {
        saveFigures();
        render();
      }));
      document.querySelectorAll('.cc-defaults').forEach((b) => b.addEventListener('click', () => {
        const name = VEHICLES[store.vehicle].name;
        if (!confirm(`Load the default ${name} figures? Your changes are kept only if you press Save after this.`)) return;
        fillFigures(VEHICLES[store.vehicle].costDefaults);
        defaultsLoaded = true;
        render();
      }));
      // leaving the page with unsaved figures
      window.addEventListener('beforeunload', (e) => {
        if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
      });
      el('ccUseBtn').addEventListener('click', () => {
        if (!(lastExpense > 0)) return;
        if (isDirty()) saveFigures(); // the expenses in use always match the saved figures
        hooks.onUseExpense(lastExpense, store.vehicle);
        render();
      });
      el('ccOpenFareBtn').addEventListener('click', () => hooks.openFareTab(store.vehicle));
    }
    load();
    el('ccVehicle').value = store.vehicle;
    fillFigures(figuresFor(store.vehicle));
    render();
  }

  return { init, refresh: () => el('cc_fuelPrice') && render() };
})();
