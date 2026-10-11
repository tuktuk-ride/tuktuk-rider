// Admin "Cost per km" tab. Default figures per vehicle type come from config.json.
//   cost per km   = fuel + servicing + tyres + repairs + depreciation + fixed costs (+ driver income, new)
//   charge per km = cost per km × (1 + profit margin) × (1 + empty return allowance)
//   trip fare     = max(km × charge per km, minimum fare) + waiting + tolls + parking + night charge
// Each vehicle type keeps its own figures on this phone.
// Used by admin.js:  CostCalc.init({ getCurrent, onApply })  and  CostCalc.refresh()
const CostCalc = (() => {
  const el = (id) => document.getElementById(id);
  const STORE_KEY = 'tuktuk_cost_calc_v2';

  // Vehicle types and their default figures, loaded from config.json
  let VEHICLES = {};
  let defaultVehicle = 'tuktuk';

  async function loadConfig() {
    const res = await fetch('config.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('config.json not found');
    const cfg = (await res.json()).costCalculator;
    VEHICLES = cfg.vehicles;
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

  let store = { vehicle: '', figures: {} };
  let hooks = { getCurrent: () => ({ perKm: 0, source: '' }), onApply: () => {} };
  let lastCharge = 0;

  const s = () => loadSettings();
  const money = (n) => formatMoney(Math.round(n * 100) / 100, s());
  const div = (a, b) => (b > 0 ? a / b : 0); // 0 instead of an error when dividing by 0

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
  const figuresFor = (v) => ({ ...VEHICLES[v].defaults, ...(store.figures[v] || {}) });

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
    store.figures[store.vehicle] = x;
    save();
    const r = calculate(x);
    lastCharge = r.chargePerKm;

    const rate = el('ccRateTable');
    rate.innerHTML = '';
    r.parts.forEach(([label, value, note]) => rate.appendChild(row(label, money(value), note)));
    rate.appendChild(row('Total cost per km', money(r.costPerKm), '', true));
    rate.appendChild(row(`Rate with profit (+${x.profitPct}%)`, money(r.withProfit)));
    rate.appendChild(row(`+ Empty return (+${x.emptyPct}%)`, money(r.chargePerKm), '', true));
    el('ccChargePerKm').textContent = money(r.chargePerKm);

    const cur = hooks.getCurrent();
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

    const perKm = Math.round(r.chargePerKm);
    const applied = Number(s().perKmOverride);
    el('ccApplyBtn').textContent = applied === perKm ? `✓ ${money(perKm)} per km is applied` : `✅ Apply ${money(perKm)} as the per km price`;
    el('ccApplyBtn').disabled = !(perKm > 0) || applied === perKm;
    el('ccApplyInfo').textContent =
      `Calculated ${money(r.chargePerKm)}, rounded to ${money(perKm)}. Applying it replaces the ` +
      `${cur.online ? 'online (API)' : "Admin"} per km price on this phone, until you press "Reset to API price" in Settings.` +
      ` Fuel adjustment is not added on top, because fuel is already in this calculation.`;
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
        store.vehicle = el('ccVehicle').value;
        fillFigures(figuresFor(store.vehicle));
        render();
      });
      el('ccResetBtn').addEventListener('click', () => {
        const name = VEHICLES[store.vehicle].name;
        if (!confirm(`Replace your ${name} figures with the default ${name} figures?`)) return;
        delete store.figures[store.vehicle];
        fillFigures(figuresFor(store.vehicle));
        render();
      });
      el('ccApplyBtn').addEventListener('click', () => {
        const perKm = Math.round(lastCharge);
        if (!(perKm > 0)) return;
        if (!confirm(`Use ${money(perKm)} as the per km price on this phone?`)) return;
        hooks.onApply(perKm);
        render();
      });
    }
    load();
    el('ccVehicle').value = store.vehicle;
    fillFigures(figuresFor(store.vehicle));
    render();
  }

  return { init, refresh: () => el('cc_fuelPrice') && render() };
})();
