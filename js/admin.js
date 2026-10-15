const $ = (id) => document.getElementById(id);

// Settings shared by all vehicle types
const SHARED_FIELDS = ['currency', 'googleApiKey', 'adminPin', 'driverName', 'driverPhone'];

// Figures each vehicle type has. Their default is the value in the online rates file (that type's block),
// else the default; any of them can be changed on this phone (saved in settings.localOverrides).
const RATE_FIELDS = [
  { id: 'expensePerKm', label: 'Expenses per km', group: 'fare', note: 'Fuel, service, tyres… no profit. Work yours out in 🧮 Cost per km' },
  { id: 'oneWayProfitPct', label: 'Profit, one way & empty return (%)', group: 'fare' },
  { id: 'roundTripProfitPct', label: 'Profit, round trip (%)', group: 'fare' },
  { id: 'minimumFare', label: 'Minimum fare', group: 'fare' },
  { id: 'waitingEnabled', label: 'Charge for waiting time', group: 'waiting', check: true },
  { id: 'waitingPerHour', label: 'Waiting charge per hour', group: 'waiting' },
  { id: 'waitingGraceMins', label: 'Free waiting minutes', group: 'more', note: '0 = charged from the first minute' },
  { id: 'waitingStepMins', label: 'Charge waiting in blocks of (minutes)', group: 'more', note: '1 = every minute. 15 = 1–15 min is charged as 15 min' },
  { id: 'roundUpKm', label: 'Charge partial km as a full km (e.g. 3.2 km → 4 km)', group: 'more', check: true }
];

let appConfig = FALLBACK_CONFIG;
let rateSet = { main: null, vehicles: {} }; // online rates file
let activeFareTab = '';
const vehicleKeys = () => Object.keys(appConfig.vehicles);
const vname = (key) => appConfig.vehicles[key].name;
const fid = (key, id) => `f_${key}_${id}`;
const panelId = (key) => `fpanel_${key}`;
const isOnline = (key) => vehicleOnline(key, appConfig, rateSet);

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $('toast').classList.remove('show'), 2500);
}

// ---------- Values of one vehicle type ----------
const localFor = (s, key) => (s.localOverrides || {})[key] || {};
// Settings in use now (API / default + this phone's changes)
const usedSettings = (key) => vehicleSettings(loadSettings(), key, appConfig, rateSet);
// Settings without this phone's changes (= API value, else default)
const referenceSettings = (key) => vehicleSettings({ ...loadSettings(), localOverrides: {} }, key, appConfig, rateSet);

// 'local' (changed on this phone) | 'api' (online rates file) | 'default'
function sourceOf(key, id) {
  if (localFor(loadSettings(), key)[id] !== undefined) return 'local';
  const block = { ...(rateSet.profit || {}), ...(onlineBlock(key, appConfig, rateSet) || {}) };
  return block[id] !== undefined ? 'api' : 'default';
}

function readVehicleInputs(key) {
  return Object.fromEntries(RATE_FIELDS.map((f) => {
    const el = $(fid(key, f.id));
    return [f.id, f.check ? el.checked : parseFloat(el.value)];
  }));
}

// Form values merged over what is in use (for live examples before saving)
const formSettings = (key) => ({ ...usedSettings(key), ...readVehicleInputs(key) });

// ---------- Build the vehicle type checks + one tab panel per type ----------
function buildVehicleUi() {
  $('vehicleChecks').innerHTML = '';
  $('vehiclePanels').innerHTML = '';
  vehicleKeys().forEach((key) => {
    const label = document.createElement('label');
    label.className = 'check';
    label.innerHTML = `<input type="checkbox" id="vt_${key}"> <span></span>`;
    label.querySelector('span').textContent = vehicleLabel(appConfig, key);
    $('vehicleChecks').appendChild(label);
    label.querySelector('input').addEventListener('change', renderFareTabs);

    const fieldHtml = (f) => f.check
      ? `<div class="field"><label class="check"><input type="checkbox" id="${fid(key, f.id)}"> <span class="flabel"></span></label>
           <div class="src-line" id="src_${key}_${f.id}"></div></div>`
      : `<div class="field"><label for="${fid(key, f.id)}" class="flabel"></label>
           <input type="number" id="${fid(key, f.id)}" inputmode="decimal" min="0" step="any">
           <div class="src-line" id="src_${key}_${f.id}"></div>
           ${f.note ? '<p class="hint fnote"></p>' : ''}</div>`;
    const group = (g) => RATE_FIELDS.filter((f) => f.group === g).map(fieldHtml).join('');

    const panel = document.createElement('div');
    panel.className = 'fare-panel hidden';
    panel.id = panelId(key);
    panel.innerHTML = `
      <div class="notice" id="fnotice_${key}"></div>
      ${group('fare')}
      <div class="trip-prices" id="prices_${key}"></div>
      <h3 class="sub">⏱ Waiting charge</h3>
      ${group('waiting')}
      <p class="hint" id="wex_${key}"></p>
      <div><label for="vno_${key}" class="vno-label"></label>
        <input type="text" id="vno_${key}" maxlength="20" placeholder="e.g. WP ABC-1234" autocomplete="off"></div>
      <details class="more-box"><summary>More options</summary>${group('more')}</details>
      <button class="btn small secondary" type="button" id="fapi_${key}"></button>`;
    RATE_FIELDS.forEach((f) => {
      const wrap = panel.querySelector(`#${fid(key, f.id)}`).closest('.field');
      wrap.querySelector('.flabel').textContent = f.label;
      if (f.note) wrap.querySelector('.fnote').textContent = f.note;
    });
    panel.querySelector('.vno-label').textContent = `Vehicle No (on ${vname(key)} receipts)`;
    $('vehiclePanels').appendChild(panel);

    $(`fapi_${key}`).addEventListener('click', () => useApiValues(key));
  });
}

// ---------- Tabs: one per ticked vehicle type ----------
function renderFareTabs() {
  const ticked = vehicleKeys().filter((key) => $(`vt_${key}`).checked);
  const keys = ticked.length ? ticked : [appConfig.defaultVehicle];
  if (!keys.includes(activeFareTab)) activeFareTab = keys[0];
  $('fareTabs').innerHTML = '';
  keys.forEach((key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab' + (key === activeFareTab ? ' active' : '');
    b.textContent = vehicleLabel(appConfig, key);
    b.addEventListener('click', () => { activeFareTab = key; renderFareTabs(); });
    $('fareTabs').appendChild(b);
  });
  $('fareTabs').classList.toggle('hidden', keys.length < 2);
  vehicleKeys().forEach((key) => $(panelId(key)).classList.toggle('hidden', key !== activeFareTab));
}

function showFareTab(key) {
  if (!$(`vt_${key}`).checked) {
    $(`vt_${key}`).checked = true;
    toast(`${vname(key)} ticked in Vehicle types — press Save settings to keep it`);
  }
  activeFareTab = key;
  renderFareTabs();
  showPanel('settingsForm');
  $('fareTabs').scrollIntoView({ block: 'start' });
}

// ---------- Fill / show ----------
function fillVehicle(key) {
  const used = usedSettings(key);
  RATE_FIELDS.forEach((f) => {
    const el = $(fid(key, f.id));
    if (f.check) el.checked = !!used[f.id];
    else el.value = Number.isFinite(Number(used[f.id])) ? used[f.id] : '';
  });
  showSources(key);
  updateLive(key);
}

// "Changed on this phone ↩" under each figure changed here (nothing under the others) + the panel notice
function showSources(key) {
  const ref = referenceSettings(key);
  const s = loadSettings();
  const block = onlineBlockName(key, appConfig, rateSet);
  const refName = isOnline(key) ? 'API' : 'default';
  RATE_FIELDS.forEach((f) => {
    const line = $(`src_${key}_${f.id}`);
    const src = sourceOf(key, f.id);
    const refText = f.check ? (ref[f.id] ? 'on' : 'off') : formatMoney(ref[f.id], s).replace(s.currency + ' ', '');
    line.innerHTML = '';
    line.className = 'src-line src-' + src;
    if (src === 'local') {
      line.append(`✎ Changed on this phone (${refName}: ${refText}) `);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'src-reset';
      b.textContent = `↩ ${refName === 'API' ? 'API' : 'Default'} value`;
      b.addEventListener('click', () => resetField(key, f.id));
      line.append(b);
    }
  });

  const changed = Object.keys(localFor(s, key)).length;
  const state = onlineBlockState(key, appConfig, rateSet);
  const stoppedBy = rateSet.format === 1 ? 'IS_STOPPED true' : '"active" not true, or no valid minimumFare / expensePerKm';
  $(`fnotice_${key}`).textContent =
    (rateSet.reachable === false && !rateSet.cachedAt ? "The online rates file can't be reached right now (no internet, or the file has an error), so the defaults are used."
      : (rateSet.cachedAt ? `The online rates file can't be reached right now, so the copy saved on this phone is used (${onlineSourceText(rateSet).replace('✓ Official rates (', '').replace(')', '')}). ` : '') +
        (state === 'active' ? `✓ Default values come from the "${block}" block of the online rates file` +
            (rateSet.updatedAt ? ` (updated ${rateSet.updatedAt}).` : '.')
          : state === 'stopped' ? `The "${block}" block in the online rates file is stopped (${stoppedBy}), so the defaults are used.`
            : `No "${block}" block in the online rates file, so the defaults are used.`)) +
    (changed ? ` ✎ ${changed} figure${changed > 1 ? 's' : ''} changed on this phone.` : '');
  $(`fapi_${key}`).textContent = `↩ Use the ${refName} values for ${vname(key)}`;
  $(`fapi_${key}`).disabled = !changed;
}

// Prices per km of the 3 trip types + waiting example, from what is typed (before saving)
function updateLive(key) {
  const s = formSettings(key);
  const money = (n) => formatMoney(n, s);
  const box = $(`prices_${key}`);
  box.innerHTML = '';
  if ([s.expensePerKm, s.oneWayProfitPct, s.roundTripProfitPct, s.minimumFare].every((n) => Number.isFinite(n))) {
    const head = document.createElement('div');
    head.className = 'tp-head';
    head.textContent = 'Price per km (10 km trip):';
    box.appendChild(head);
    Object.keys(TRIP_TYPES).forEach((t) => {
      const line = document.createElement('div');
      line.innerHTML = '<span></span><b></b>';
      line.firstChild.textContent = TRIP_TYPES[t].name;
      line.lastChild.textContent = `${money(tripPerKm(s, t))}  (${money(calculateFare(10, s, 0, t).total)})`;
      box.appendChild(line);
    });
  }
  const waitFor = (mins) => money(((billedWaitingMins(mins, s) / 60) * waitingRate(s)).toFixed(2));
  $(`wex_${key}`).textContent = waitingRate(s)
    ? `Example: 4 min = ${waitFor(4)} • 25 min = ${waitFor(25)} • 1 h = ${waitFor(60)}` +
      (waitingRuleText(s) ? ` (${waitingRuleText(s)})` : '') : 'Waiting charge is off.';
}

function fillForm() {
  const s = loadSettings();
  SHARED_FIELDS.forEach((f) => ($(f).value = s[f] ?? ''));
  const radio = document.querySelector(`input[name="mapProvider"][value="${s.mapProvider}"]`) ||
                document.querySelector('input[name="mapProvider"][value="osm"]');
  radio.checked = true;
  const enabled = (s.enabledVehicles || []).length ? s.enabledVehicles : [appConfig.defaultVehicle];
  vehicleKeys().forEach((key) => {
    $(`vt_${key}`).checked = enabled.includes(key);
    $(`vno_${key}`).value = (s.vehicleNumbers || {})[key] || '';
    fillVehicle(key);
  });
  renderFareTabs();
  updateMapBox();
}

// Only show the API key field when Google Maps is selected
function updateMapBox() {
  $('googleKeyBox').classList.toggle('hidden', document.querySelector('input[name="mapProvider"]:checked').value !== 'google');
}

// ---------- Back to the API values ----------
function saveLocal(key, local) {
  const s = loadSettings();
  s.localOverrides = { ...(s.localOverrides || {}), [key]: local };
  if (!Object.keys(local).length) delete s.localOverrides[key];
  return saveSettings(s);
}

function resetField(key, id) {
  const local = { ...localFor(loadSettings(), key) };
  delete local[id];
  if (!saveLocal(key, local)) return toast('❌ This browser blocks saving (private mode?)');
  const f = RATE_FIELDS.find((x) => x.id === id);
  const used = usedSettings(key);
  if (f.check) $(fid(key, id)).checked = !!used[id]; else $(fid(key, id)).value = used[id];
  showSources(key);
  updateLive(key);
  CostCalc.refresh();
  toast(`↩ ${vname(key)}: "${f.label}" back to the ${isOnline(key) ? 'API' : 'default'} value`);
}

function useApiValues(key) {
  const n = Object.keys(localFor(loadSettings(), key)).length;
  if (!n || !confirm(`Put all ${n} changed ${vname(key)} figure${n > 1 ? 's' : ''} back to the ${isOnline(key) ? 'API' : 'default'} values?`)) return;
  if (!saveLocal(key, {})) return toast('❌ This browser blocks saving (private mode?)');
  fillVehicle(key);
  CostCalc.refresh();
  toast(`↩ ${vname(key)}: using the ${isOnline(key) ? 'API' : 'default'} values`);
}

// ---------- Expenses per km from the Cost per km tab ----------
function costInfo(key) {
  if (!appConfig.vehicles[key]) key = appConfig.defaultVehicle;
  const src = sourceOf(key, 'expensePerKm');
  const vs = usedSettings(key);
  return {
    settings: vs,
    expensePerKm: Number(vs.expensePerKm) || 0,
    source: src === 'local' ? 'set on this phone' : src === 'api' ? 'from the online rates file' : 'default'
  };
}

// "Use as my expenses per km": this phone's own expenses (back to the API value when it is the same)
function useExpense(value, key) {
  const local = { ...localFor(loadSettings(), key) };
  if (value === Number(referenceSettings(key).expensePerKm)) delete local.expensePerKm;
  else local.expensePerKm = value;
  if (!saveLocal(key, local)) return toast('❌ This browser blocks saving (private mode?)');
  $(fid(key, 'expensePerKm')).value = usedSettings(key).expensePerKm;
  showSources(key);
  updateLive(key);
  toast(`✅ ${vname(key)}: expenses ${formatMoney(value, loadSettings())} per km — prices updated`);
}

// ---------- Admin tabs (Settings / Cost per km) ----------
function showPanel(id) {
  document.querySelectorAll('#adminTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === id));
  ['settingsForm', 'costPanel'].forEach((p) => $(p).classList.toggle('hidden', p !== id));
  window.scrollTo(0, 0);
}
document.querySelectorAll('#adminTabs .tab, [data-goto]').forEach((b) =>
  b.addEventListener('click', () => showPanel(b.dataset.panel || b.dataset.goto)));

// ---------- Login ----------
async function login() {
  if ($('pinInput').value !== loadSettings().adminPin) {
    $('loginError').textContent = 'Wrong PIN.';
    return;
  }
  $('loginBtn').disabled = true;
  $('loginError').textContent = 'Loading rates…';
  // The API values are the defaults shown in the form, so read them first
  [appConfig, rateSet] = await Promise.all([loadAppConfig(), fetchOnlineRateSet()]);
  $('loginCard').classList.add('hidden');
  buildVehicleUi();
  $('adminTabs').classList.remove('hidden');
  $('settingsForm').classList.remove('hidden');
  fillForm();
  CostCalc.init({
    getCurrent: costInfo,
    onUseExpense: useExpense,
    openFareTab: showFareTab
  });
}
$('loginBtn').addEventListener('click', login);
$('pinInput').addEventListener('keydown', (e) => e.key === 'Enter' && login());

// ---------- Live updates ----------
$('settingsForm').addEventListener('input', (e) => {
  updateMapBox();
  const key = vehicleKeys().find((k) => (e.target.id || '').startsWith(`f_${k}_`));
  if (key) updateLive(key);
});

// ---------- Save ----------
const VALIDATION = [
  ['expensePerKm', (v) => v > 0], ['oneWayProfitPct', (v) => v >= 0], ['roundTripProfitPct', (v) => v >= 0],
  ['minimumFare', (v) => v >= 0], ['waitingPerHour', (v) => v >= 0],
  ['waitingGraceMins', (v) => v >= 0], ['waitingStepMins', (v) => v >= 1]
];

$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const own = loadSettings();
  const s = {
    ...own,
    ...Object.fromEntries(SHARED_FIELDS.map((f) => [f, $(f).value.trim()])),
    mapProvider: document.querySelector('input[name="mapProvider"]:checked').value,
    enabledVehicles: vehicleKeys().filter((key) => $(`vt_${key}`).checked),
    vehicleNumbers: Object.fromEntries(vehicleKeys().map((key) => [key, $(`vno_${key}`).value.trim()]).filter(([, v]) => v)),
    localOverrides: {}
  };
  s.currency = s.currency || 'Rs.';
  if (!s.enabledVehicles.length) return toast('Tick at least one vehicle type');

  // Each figure that differs from the API / default value is this phone's own
  for (const key of vehicleKeys()) {
    const ref = referenceSettings(key);
    const form = readVehicleInputs(key);
    const local = {};
    RATE_FIELDS.forEach((f) => {
      const v = form[f.id];
      if (f.check ? v !== !!ref[f.id] : Number.isFinite(v) && v !== Number(ref[f.id])) local[f.id] = v;
    });
    if (Object.keys(local).length) s.localOverrides[key] = local;

    if (s.enabledVehicles.includes(key)) {
      const bad = VALIDATION.find(([f, ok]) => !ok(form[f]));
      if (bad) {
        activeFareTab = key;
        renderFareTabs();
        const field = RATE_FIELDS.find((x) => x.id === bad[0]);
        if (field.group === 'more') $(panelId(key)).querySelector('details.more-box').open = true; // show the folded field
        $(fid(key, field.id)).focus();
        return toast(`${vname(key)}: please enter a valid "${field.label}"`);
      }
    }
  }
  if (s.adminPin.length < 4) return toast('PIN must be at least 4 characters');
  if (s.mapProvider === 'google' && !s.googleApiKey) return toast('Enter a Google API key, or choose OpenStreetMap');
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  vehicleKeys().forEach(showSources);
  vehicleKeys().forEach(updateLive);
  CostCalc.refresh();
  const changed = Object.values(s.localOverrides).reduce((n, o) => n + Object.keys(o).length, 0);
  toast(changed ? `✅ Settings saved — ${changed} figure${changed > 1 ? 's' : ''} changed from the API on this phone` : '✅ Settings saved');
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('Reset everything on this phone (your changed figures, vehicle numbers, PIN 1234, map, receipt details) and use the API values?')) return;
  resetSettings();
  fillForm();
  CostCalc.refresh();
  toast('Settings reset');
});
