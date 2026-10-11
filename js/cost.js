// Admin "Cost per km" tab. Default figures per vehicle type come from config.json.
//   cost per km   = fuel + servicing + tyres + repairs + depreciation + fixed costs (+ driver income, new)
//   charge per km = cost per km × (1 + profit margin) × (1 + empty return allowance)
//   trip fare     = max(km × charge per km, minimum fare) + waiting + tolls + parking + night charge
// Each vehicle type keeps its own figures on this phone. Changes calculate straight away but are only
// kept when "Save vehicle costs" is pressed; "Defaults" loads the config.json figures (then Save).
// Used by admin.js:  CostCalc.init({ getCurrent(vehicle), getSaved(vehicle), onSave(perKm, vehicle), openFareTab(vehicle) })
//                    and CostCalc.refresh()
const CostCalc = (() => {
  const el = (id) => document.getElementById(id);
  const STORE_KEY = 'tuktuk_cost_calc_v2';

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
    { id: 'driverMonthly', label: 'Driver income target (per month)', note: 'Optional. 0 = not included' },
    { id: 'profitPct', label: 'Profit margin (%)', note: 'Suggested 20–30%' },
    { id: 'emptyPct', label: 'Empty return allowance (%)', note: 'Suggested 30–50% for driving back empty' }
  ];
  const TRIP_FIELDS = [
    { id: 'tripKm', label: 'Trip distance (km)' },
    { id: 'minFare', label: 'Minimum fare', note: 'Charged if the km fare is lower' },
    { id: 'waitMins', label: 'Waiting time (minutes)' },
    { id: 'waitPerHour', label: 'Waiting charge (per hour)' },
    { id: 'tolls', label: 'Expressway tolls', note: 'At actual cost' },
    { id: 'parking', label: 'Parking', note: 'At actual cost' },
    { id: 'night', label: 'Night / early-morning charge', note: 'Optional fixed amount' }
  ];
  const ALL_FIELDS = COST_FIELDS.concat(TRIP_FIELDS);
  const fid = (id) => 'cc_' + id; // input ids, kept apart from the Settings form ids

  let store = { vehicle: '', figures: {}, rounding: {} };
  let hooks = { getCurrent: () => ({ perKm: 0, source: '' }), getSaved: () => null, onSave: () => {}, openFareTab: () => {} };
  let lastPerKm = 0;
  let defaultsLoaded = false; // "Defaults" pressed and not saved yet

  // Rounding of the calculated per km price, per vehicle type: nearest / down (floor) / up (ceiling), to Rs. 1, 5 or 10
  const roundingFor = (v) => ({ mode: 'nearest', to: 1, ...(store.rounding[v] || {}) });
  function roundPrice(value, { mode, to }) {
    const steps = Math.round((value / to) * 1e6) / 1e6; // ignore float noise like 50.00000001
    const n = mode === 'down' ? Math.floor(steps) : mode === 'up' ? Math.ceil(steps) : Math.round(steps);
    return n * to;
  }

  const s = () => loadSettings();
  const money = (n) => formatMoney(Math.round(n * 100) / 100, s());
  const div = (a, b) => (b > 0 ? a / b : 0); // 0 instead of an error when dividing by 0

  // ---------- Storage ----------
  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved) store = { vehicle: VEHICLES[saved.vehicle] ? saved.vehicle : defaultVehicle, figures: saved.figures || {}, rounding: saved.rounding || {} };
      else store.vehicle = defaultVehicle;
    } catch (e) { /* storage blocked */ }
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* storage blocked */ }
  }
  const figuresFor = (v) => ({ ...VEHICLES[v].costDefaults, ...(store.figures[v] || {}) });
  const readRounding = () => ({ mode: el('ccRoundMode').value, to: Number(el('ccRoundTo').value) });

  // Form differs from what is saved for this vehicle type?
  function isDirty() {
    if (!el('cc_fuelPrice')) return false;
    const form = readFigures(), saved = figuresFor(store.vehicle);
    return ALL_FIELDS.some((f) => form[f.id] !== Number(saved[f.id] ?? 0)) ||
      JSON.stringify(readRounding()) !== JSON.stringify(roundingFor(store.vehicle));
  }

  function saveFigures() {
    store.figures[store.vehicle] = readFigures();
    store.rounding[store.vehicle] = readRounding();
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

  // ---------- Calculation ----------
  function calculate(x) {
    const parts = [
      ['Fuel cost per km', div(x.fuelPrice, x.kmPerLitre), 'Fuel price ÷ km per litre'],
      ['Servicing per km', div(x.serviceCost, x.serviceKm), 'Service cost ÷ km between services'],
      ['Tyres per km', div(x.tyreCost, x.tyreKm), 'Tyre set ÷ km it lasts'],
      ['Repairs & wear per km', x.repairsPerKm, ''],
      ['Depreciation per km', x.depreciationPerKm, ''],
      ['Fixed costs per km', div(x.yearlyFixed, x.kmPerYear), 'Yearly fixed costs ÷ km per year']
    ];
    if (x.driverMonthly) parts.push(['Driver income per km', div(x.driverMonthly * 12, x.kmPerYear), 'Monthly target × 12 ÷ km per year']);
    const costPerKm = parts.reduce((sum, p) => sum + p[1], 0);
    const withProfit = costPerKm * (1 + x.profitPct / 100);
    const chargePerKm = withProfit * (1 + x.emptyPct / 100);

    const kmFare = x.tripKm * chargePerKm;
    const distanceFare = Math.max(kmFare, x.minFare);
    const waitingFare = (x.waitMins / 60) * x.waitPerHour;
    const totalFare = distanceFare + waitingFare + x.tolls + x.parking + x.night;
    const quote = Math.floor(Math.round(totalFare * 100) / 100 / 10) * 10;
    return { parts, costPerKm, withProfit, chargePerKm, kmFare, distanceFare, waitingFare, totalFare, quote };
  }

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
    const r = calculate(x);
    const perKm = roundPrice(r.chargePerKm, readRounding());
    showFiguresStatus();
    lastPerKm = perKm;
    el('ccRounded').textContent = money(perKm);

    const rate = el('ccRateTable');
    rate.innerHTML = '';
    r.parts.forEach(([label, value, note]) => rate.appendChild(row(label, money(value), note)));
    rate.appendChild(row('Total cost per km', money(r.costPerKm), '', true));
    rate.appendChild(row(`Rate with profit (+${x.profitPct}%)`, money(r.withProfit)));
    rate.appendChild(row(`+ Empty return (+${x.emptyPct}%)`, money(r.chargePerKm), '', true));
    el('ccChargePerKm').textContent = money(r.chargePerKm);

    const cur = hooks.getCurrent(store.vehicle);
    const diff = cur.perKm - r.chargePerKm;
    const pct = r.chargePerKm > 0 ? Math.round((diff / r.chargePerKm) * 100) : 0;
    el('ccCompare').textContent = r.chargePerKm > 0
      ? `The app now charges ${money(cur.perKm)} per km (${cur.source}). That is ` +
        (Math.abs(diff) < 0.5 ? 'about the same as the calculated charge.'
          : `${money(Math.abs(diff))} (${Math.abs(pct)}%) ${diff > 0 ? 'above' : 'below'} the calculated charge` +
            (diff < 0 ? ' — you may be losing money on each km.' : '.')) +
        ` Running cost alone is ${money(r.costPerKm)} per km.`
      : 'Enter the vehicle costs above.';

    const trip = el('ccTripTable');
    trip.innerHTML = '';
    trip.appendChild(row(`Distance fare (${x.tripKm} km × ${money(r.chargePerKm)})`, money(r.kmFare)));
    if (r.distanceFare > r.kmFare) trip.appendChild(row('Minimum fare applied', money(r.distanceFare)));
    if (r.waitingFare) trip.appendChild(row(`Waiting (${x.waitMins} min)`, money(r.waitingFare)));
    if (x.tolls) trip.appendChild(row('Expressway tolls', money(x.tolls)));
    if (x.parking) trip.appendChild(row('Parking', money(x.parking)));
    if (x.night) trip.appendChild(row('Night / early-morning charge', money(x.night)));
    trip.appendChild(row('Total fare', money(r.totalFare)));
    trip.appendChild(row('Amount to quote the passenger', money(r.quote), '', true));

    const name = VEHICLES[store.vehicle].name;
    const saved = Number(hooks.getSaved(store.vehicle));
    el('ccSaveBtn').textContent = saved === perKm
      ? `✓ ${money(perKm)} is saved as the ${name} cost per km price` : `💾 Save ${money(perKm)} as the ${name} cost per km price`;
    el('ccSaveBtn').disabled = !(perKm > 0) || saved === perKm;
    el('ccSaveInfo').textContent =
      (saved > 0 && saved !== perKm ? `Saved now: ${money(saved)}. ` : '') +
      `To charge it instead of the ${cur.online ? 'online (API)' : 'Admin'} price, tick "Use cost per km price" in Settings → Fare rates → ${name}.`;
    el('ccOpenFareBtn').textContent = `Open the ${VEHICLES[store.vehicle].icon || ''} ${name} fare rates`.replace('  ', ' ');
    el('ccOpenFareBtn').classList.toggle('hidden', !(saved > 0));
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
        fillRounding();
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
        el('ccRoundMode').value = 'nearest';
        el('ccRoundTo').value = '1';
        defaultsLoaded = true;
        render();
      }));
      // leaving the page with unsaved figures
      window.addEventListener('beforeunload', (e) => {
        if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
      });
      el('ccSaveBtn').addEventListener('click', () => {
        if (!(lastPerKm > 0)) return;
        if (isDirty()) saveFigures(); // the saved price always matches the saved figures
        hooks.onSave(lastPerKm, store.vehicle);
        render();
      });
      el('ccOpenFareBtn').addEventListener('click', () => hooks.openFareTab(store.vehicle));
    }
    load();
    el('ccVehicle').value = store.vehicle;
    fillFigures(figuresFor(store.vehicle));
    fillRounding();
    render();
  }

  function fillRounding() {
    const r = roundingFor(store.vehicle);
    el('ccRoundMode').value = r.mode;
    el('ccRoundTo').value = String(r.to);
  }

  return { init, refresh: () => el('cc_fuelPrice') && render() };
})();
