// Admin "Cost per km" tab: works out what one km costs to run (the trip expenses, no profit).
//   expenses per km = fuel + servicing + tyres + repairs + depreciation + fixed costs (+ driver income)
// Fuel type: its price comes from the online rates file ("fuelPrices"), else config.json; a typed price is the
// rider's own (with "↩ Use Rs X" to go back to the rates file price).
// Repairs & wear and depreciation can be typed as one figure, or worked out in their "🧮 Work it out" boxes
// (like the Excel sheets): repairs = wear parts (cost ÷ km it lasts) + allowance %, depreciation =
// (value now − selling price later) ÷ (years × km per year). "Use Rs X" copies the result into the field.
// "Use as my expenses per km" puts the result in Settings → Fare rates, where the profit margins turn it into the
// one way / empty return / round trip prices (tripPerKm in js/settings.js).
// Default figures per vehicle type come from config.json. Each vehicle type keeps its own figures on this phone;
// changes calculate straight away but are only kept when "Save vehicle costs" is pressed.
// Used by admin.js:  CostCalc.init({ getCurrent(vehicle), onUseExpense(expensePerKm, vehicle), openFareTab(vehicle),
//                                   getRateSet() })
//                    and CostCalc.refresh()
const CostCalc = (() => {
  const el = (id) => document.getElementById(id);
  const STORE_KEY = COST_STORE_KEY; // js/settings.js

  // Vehicle types and their default figures, loaded from config.json
  let VEHICLES = {};
  let defaultVehicle = 'tuktuk';
  let CFG = { fuelTypes: {} };

  async function loadConfig() {
    const cfg = await loadAppConfig();
    CFG = cfg;
    VEHICLES = Object.fromEntries(Object.entries(cfg.vehicles).filter(([, v]) => v.costDefaults));
    if (!Object.keys(VEHICLES).length) throw new Error('no cost figures in config.json');
    defaultVehicle = VEHICLES[cfg.defaultVehicle] ? cfg.defaultVehicle : Object.keys(VEHICLES)[0];
  }

  const COST_FIELDS = [
    { id: 'fuelPrice', label: 'Fuel price (per litre)' }, // the "Fuel type" dropdown goes above it
    { id: 'kmPerLitre', label: 'Fuel efficiency (km per litre)' },
    { id: 'serviceCost', label: 'Servicing cost (each service)' },
    { id: 'serviceKm', label: 'Km between services' },
    { id: 'tyreCost', label: 'Tyre set cost' },
    { id: 'tyreKm', label: 'Km a tyre set lasts' },
    { id: 'repairsPerKm', label: 'Repairs & wear (per km)', note: 'Brake pads, battery, clutch, etc. Type one figure, or work it out below' },
    { id: 'depreciationPerKm', label: 'Depreciation (per km)', note: 'Loss of vehicle value with mileage. Type one figure, or work it out below' },
    { id: 'yearlyFixed', label: 'Yearly fixed costs', note: 'Insurance, licence, emission test, lease' },
    { id: 'kmPerYear', label: 'Km driven per year' },
    { id: 'driverMonthly', label: 'Driver income target (per month)', note: 'Optional. 0 = not included' }
  ];
  // "Work it out" boxes. Depreciation uses "Km driven per year" from 1. Vehicle costs; only when that is 0
  // does its own "Km per year" field show (depKmPerYear)
  const REPAIR_FIELDS = [{ id: 'repairAllowancePct', label: 'Allowance for unexpected repairs (%)', note: 'Suggested 10–20%' }];
  const DEP_FIELDS = [
    { id: 'depValueNow', label: 'Vehicle value now', note: "What you paid, or today's market value" },
    { id: 'depSellLater', label: 'Expected selling price later', note: 'Same model, older and higher mileage, on riyasewana.lk / ikman.lk' },
    { id: 'depYears', label: 'Years you plan to keep it' },
    { id: 'depKmPerYear', label: 'Km per year', note: '"Km driven per year" in 1. Vehicle costs is 0, so enter the km per year here' }
  ];
  const TRIP_FIELDS = [{ id: 'tripKm', label: 'Trip distance (km, one way)' }];
  const ALL_FIELDS = COST_FIELDS.concat(REPAIR_FIELDS, DEP_FIELDS, TRIP_FIELDS);
  const fid = (id) => 'cc_' + id; // input ids, kept apart from the Settings form ids

  let store = { vehicle: '', figures: {} };
  let hooks = { getCurrent: () => null, onUseExpense: () => {}, openFareTab: () => {}, getRateSet: () => ({}) };
  let lastExpense = 0;
  let lastRepairs = 0, lastDepreciation = 0; // "Work it out" results
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
  // Default figures of a vehicle type, with today's price of its fuel type (rates file, else config.json)
  const defaultsFor = (v) => {
    const d = { ...VEHICLES[v].costDefaults };
    const p = fuelPriceFor(d.fuelType, CFG, hooks.getRateSet());
    if (p) d.fuelPrice = p.price;
    return d;
  };
  const figuresFor = (v) => ({ ...defaultsFor(v), ...(store.figures[v] || {}) });

  // Form differs from what is saved for this vehicle type?
  function isDirty() {
    if (!el('cc_fuelPrice')) return false;
    const form = readFigures(), saved = figuresFor(store.vehicle);
    return ALL_FIELDS.some((f) => form[f.id] !== Number(saved[f.id] ?? 0)) || form.fuelType !== (saved.fuelType || '') ||
      JSON.stringify(form.repairParts) !== JSON.stringify(cleanParts(saved.repairParts));
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
  const readFigures = () => ({
    ...Object.fromEntries(ALL_FIELDS.map((f) => [f.id, Math.max(0, parseFloat(el(fid(f.id)).value) || 0)])),
    fuelType: el('cc_fuelType').value,
    repairParts: readParts()
  });
  const fillFigures = (fig) => {
    ALL_FIELDS.forEach((f) => (el(fid(f.id)).value = fig[f.id] ?? 0));
    el('cc_fuelType').value = CFG.fuelTypes[fig.fuelType] ? fig.fuelType : Object.keys(CFG.fuelTypes)[0] || '';
    fillParts(fig.repairParts);
  };

  // ---------- Fuel type (price from the rates file) ----------
  const fuelPrice = (type) => fuelPriceFor(type, CFG, hooks.getRateSet()); // js/settings.js
  function buildFuelType() {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<label for="cc_fuelType">Fuel type</label><select id="cc_fuelType"></select>';
    Object.entries(CFG.fuelTypes || {}).forEach(([key, t]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = t.name;
      wrap.querySelector('select').appendChild(opt);
    });
    el('ccCostInputs').prepend(wrap);
    // the price of the chosen fuel, under the fuel price field
    const note = document.createElement('p');
    note.className = 'hint fuel-note';
    note.id = 'ccFuelNote';
    el(fid('fuelPrice')).after(note);
    // a new fuel type takes its price
    el('cc_fuelType').addEventListener('change', () => {
      const p = fuelPrice(el('cc_fuelType').value);
      if (p) el(fid('fuelPrice')).value = p.price;
      render();
    });
  }
  // "From the rates file (effective 30 Sep 2026)" / "Your own price — the rates file has Rs 392 [↩ Use Rs 392]"
  function showFuelNote(x) {
    const note = el('ccFuelNote');
    const p = fuelPrice(x.fuelType);
    note.innerHTML = '';
    if (!p) return;
    const day = p.effectiveDate ? new Date(p.effectiveDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    const from = p.source === 'rates' ? 'the rates file' : 'the app defaults';
    if (Math.abs(x.fuelPrice - p.price) < 0.005) {
      note.textContent = `From ${from}${day ? ` (effective ${day})` : ''}`;
      return;
    }
    note.append(`Your own price — ${from} has ${money(p.price)}${day ? ` (effective ${day})` : ''} `);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'src-reset';
    b.textContent = `↩ Use ${money(p.price)}`;
    b.addEventListener('click', () => { el(fid('fuelPrice')).value = p.price; render(); });
    note.append(b);
  }

  // ---------- Wear parts list (repairs & wear) ----------
  const num = (v) => Math.max(0, parseFloat(v) || 0);
  const cleanParts = (parts) => (Array.isArray(parts) ? parts : []).map((p) => ({ name: String(p.name || '').trim(), cost: num(p.cost), km: num(p.km) }));
  function addPartRow(p = {}) {
    const r = document.createElement('div');
    r.className = 'part-row';
    r.innerHTML = '<input type="text" class="p-name" maxlength="40" placeholder="Part" aria-label="Part">' +
      '<input type="number" class="p-cost" inputmode="decimal" min="0" step="any" placeholder="Rs." aria-label="Cost incl. labour (Rs.)">' +
      '<input type="number" class="p-km" inputmode="decimal" min="0" step="any" placeholder="km" aria-label="Lasts (km)">' +
      '<button type="button" class="p-del" title="Remove this part" aria-label="Remove this part">✕</button>';
    r.querySelector('.p-name').value = p.name || '';
    r.querySelector('.p-cost').value = p.cost ?? '';
    r.querySelector('.p-km').value = p.km ?? '';
    r.querySelector('.p-del').addEventListener('click', () => { r.remove(); render(); });
    el('ccParts').appendChild(r);
  }
  const readParts = () => [...document.querySelectorAll('#ccParts .part-row')].map((r) => ({
    name: r.querySelector('.p-name').value.trim(), cost: num(r.querySelector('.p-cost').value), km: num(r.querySelector('.p-km').value)
  }));
  function fillParts(parts) {
    el('ccParts').innerHTML = '';
    cleanParts(parts).forEach(addPartRow);
  }

  // The two "🧮 Work it out" boxes, folded under their fields
  function buildWorkItOut() {
    const box = (fieldId, html) => {
      const d = document.createElement('details');
      d.className = 'calc-box';
      d.innerHTML = html;
      el(fid(fieldId)).parentElement.after(d);
    };
    box('repairsPerKm', `<summary>🧮 Work it out <span id="ccRepairSum"></span></summary>
      <p class="hint">Wear parts only (servicing and tyres have their own lines). Prices are examples: use your garage's quotes.</p>
      <div class="parts-head"><span>Part</span><span>Cost incl. labour</span><span>Lasts (km)</span><span></span></div>
      <div id="ccParts"></div>
      <button type="button" class="btn small secondary" id="ccAddPart">➕ Add part</button>
      <div id="ccRepairInputs"></div>
      <table class="breakdown calc-table" id="ccRepairTable"></table>
      <button type="button" class="btn small" id="ccUseRepair"></button>`);
    box('depreciationPerKm', `<summary>🧮 Work it out <span id="ccDepSum"></span></summary>
      <div id="ccDepInputs"></div>
      <p class="hint dep-km" id="ccDepKmNote"></p>
      <table class="breakdown calc-table" id="ccDepTable"></table>
      <button type="button" class="btn small" id="ccUseDep"></button>`);
    buildInputs(REPAIR_FIELDS, 'ccRepairInputs');
    buildInputs(DEP_FIELDS, 'ccDepInputs');
    el('ccAddPart').addEventListener('click', () => { addPartRow({ name: '', cost: '', km: '' }); render(); });
    // "Use": work the result out again from the figures as they are now (never an older result)
    el('ccUseRepair').addEventListener('click', () => { el(fid('repairsPerKm')).value = workItOut(readFigures()).repairs; render(); });
    el('ccUseDep').addEventListener('click', () => { el(fid('depreciationPerKm')).value = workItOut(readFigures()).depreciation; render(); });
  }

  // Results of the two boxes: [table rows, result per km]
  function workItOut(x) {
    const round2 = (n) => Math.round(n * 100) / 100;
    const subtotal = x.repairParts.reduce((sum, p) => sum + (p.km > 0 ? p.cost / p.km : 0), 0);
    const repairs = round2(subtotal * (1 + x.repairAllowancePct / 100));
    const loss = Math.max(0, x.depValueNow - x.depSellLater);
    const fromMain = x.kmPerYear > 0;                     // "Km driven per year" in 1. Vehicle costs
    const kmYear = fromMain ? x.kmPerYear : x.depKmPerYear; // else the box's own field
    const totalKm = x.depYears * kmYear;
    const depreciation = totalKm > 0 ? round2(loss / totalKm) : 0;
    return { subtotal, repairs, loss, fromMain, kmYear, totalKm, depreciation };
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
    const parts = tripExpenseParts(x); // js/settings.js
    const expense = Math.round(parts.reduce((sum, p) => sum + p[1], 0) * 100) / 100;
    lastExpense = expense;
    showFiguresStatus();
    showFuelNote(x);

    // "Work it out" boxes
    const w = workItOut(x);
    lastRepairs = w.repairs;
    lastDepreciation = w.depreciation;
    const rt = el('ccRepairTable');
    rt.innerHTML = '';
    rt.appendChild(row('Parts subtotal', money(w.subtotal), 'Each part: cost ÷ km it lasts'));
    rt.appendChild(row(`Allowance for unexpected repairs (${x.repairAllowancePct}%)`, '+ ' + money(w.subtotal * x.repairAllowancePct / 100)));
    rt.appendChild(row('Repairs & wear per km', money(w.repairs), '', true));
    const dt = el('ccDepTable');
    dt.innerHTML = '';
    dt.appendChild(row('Loss in value (now − later)', money(w.loss)));
    dt.appendChild(row(`Km before selling (${x.depYears} years × ${w.kmYear.toLocaleString('en-LK')} km)`, `${w.totalKm.toLocaleString('en-LK')} km`));
    // km per year: from 1. Vehicle costs, or (when that is 0) the box's own field
    el(fid('depKmPerYear')).parentElement.classList.toggle('hidden', w.fromMain);
    el('ccDepKmNote').textContent = w.fromMain
      ? `Km per year: ${w.kmYear.toLocaleString('en-LK')} — from 1. Vehicle costs → Km driven per year`
      : (w.kmYear > 0 ? '' : 'Enter the km per year above to work out depreciation.');
    dt.appendChild(row('Depreciation per km', money(w.depreciation), '', true));
    const useBtn = (id, value, field, what) => {
      const inUse = Math.abs(x[field] - value) < 0.005;
      el(id).textContent = inUse ? `✓ ${money(value)} is in the ${what} field` : `⬆ Use ${money(value)} as ${what} per km`;
      el(id).disabled = inUse || !(value > 0);
    };
    useBtn('ccUseRepair', w.repairs, 'repairsPerKm', 'repairs & wear');
    useBtn('ccUseDep', w.depreciation, 'depreciationPerKm', 'depreciation');
    el('ccRepairSum').textContent = `— ${money(w.repairs)} per km`;
    el('ccDepSum').textContent = `— ${money(w.depreciation)} per km`;

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
      buildFuelType();
      buildWorkItOut();
      buildInputs(TRIP_FIELDS, 'ccTripInputs');
      // "input" while typing; "change" too, as some phone keyboards, autofill and paste only send that one
      ['input', 'change'].forEach((ev) => el('costPanel').addEventListener(ev, (e) => {
        if (e.target.id !== 'ccVehicle' && e.target.id !== 'cc_fuelType') render();
      }));

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
        fillFigures(defaultsFor(store.vehicle));
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
