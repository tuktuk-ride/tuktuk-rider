const $ = (id) => document.getElementById(id);

// Settings shared by all vehicle types
const SHARED_FIELDS = ['currency', 'googleApiKey', 'adminPin', 'driverName', 'driverPhone'];

// Figures each vehicle type has. Their default is the value in the online rates file (that type's block),
// else the default; any of them can be changed on this phone (saved in settings.localOverrides).
const RATE_FIELDS = [
  { id: 'minimumFare', label: 'Minimum fare', group: 'fare' },
  { id: 'perKmRate', label: 'Per km price', group: 'fare' },
  { id: 'roundUpKm', label: 'Charge partial km as a full km (e.g. 3.2 km → 4 km)', group: 'fare', check: true },
  { id: 'waitingEnabled', label: 'Charge for waiting time', group: 'waiting', check: true },
  { id: 'waitingPerHour', label: 'Waiting charge per hour', group: 'waiting' },
  { id: 'waitingGraceMins', label: 'Free waiting minutes', group: 'waiting', note: 'Waiting up to this is not charged. 0 = charged from the first minute' },
  { id: 'waitingStepMins', label: 'Charge waiting in blocks of (minutes)', group: 'waiting', note: '1 = every minute. 15 = 1–15 min is charged as 15 min' }
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

// Fields filled from the Cost per km tab while "Use the Cost per km prices" is ticked
function calcFields(key) {
  const s = loadSettings();
  return (s.useCalculated || {})[key] && Number((s.perKmCalculated || {})[key]) > 0 ? ['perKmRate'] : [];
}

// 'calc' (Cost per km tab, ticked) | 'local' (changed on this phone) | 'api' | 'default'
function sourceOf(key, id) {
  if (calcFields(key).includes(id)) return 'calc';
  if (localFor(loadSettings(), key)[id] !== undefined) return 'local';
  const block = onlineBlock(key, appConfig, rateSet);
  return block && block[id] !== undefined ? 'api' : 'default';
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
      <div><label for="vno_${key}" class="vno-label"></label>
        <input type="text" id="vno_${key}" maxlength="20" placeholder="e.g. WP ABC-1234" autocomplete="off"></div>
      <div class="calc-price" id="calcSlot_${key}">
        <label class="check"><input type="checkbox" id="usecalc_${key}"> <span id="usecalcText_${key}"></span></label>
        <p class="hint" id="usecalcHint_${key}"></p>
      </div>
      <h3 class="sub">⏱ Waiting charge</h3>
      ${group('waiting')}
      <p class="hint" id="wex_${key}"></p>
      <p class="hint" id="fex_${key}"></p>
      <button class="btn small secondary" type="button" id="fapi_${key}"></button>`;
    RATE_FIELDS.forEach((f) => {
      const wrap = panel.querySelector(`#${fid(key, f.id)}`).closest('.field');
      wrap.querySelector('.flabel').textContent = f.label;
      if (f.note) wrap.querySelector('.fnote').textContent = f.note;
    });
    panel.querySelector('.vno-label').textContent = `Vehicle No (on ${vname(key)} receipts)`;
    $('vehiclePanels').appendChild(panel);

    $(`usecalc_${key}`).addEventListener('change', (e) => setUseCalculated(key, e.target.checked));
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

// "API" / "Default" / "Changed on this phone ↩" under each field + the panel notice
function showSources(key) {
  const ref = vehicleSettings({ ...loadSettings(), localOverrides: {}, useCalculated: {} }, key, appConfig, rateSet);
  const s = loadSettings();
  const block = onlineBlockName(key, appConfig, rateSet);
  const refName = isOnline(key) ? 'API' : 'default';
  RATE_FIELDS.forEach((f) => {
    const line = $(`src_${key}_${f.id}`);
    const src = sourceOf(key, f.id);
    const refText = f.check ? (ref[f.id] ? 'on' : 'off') : formatMoney(ref[f.id], s).replace(s.currency + ' ', '');
    line.innerHTML = '';
    line.className = 'src-line src-' + src;
    $(fid(key, f.id)).disabled = src === 'calc'; // set by the tick below, not typed
    if (src === 'calc') {
      line.textContent = `🧮 From the Cost per km tab (${refName}: ${refText}) — untick "Use the Cost per km prices" to change it`;
    } else if (src === 'local') {
      line.append(`✎ Changed on this phone (${refName}: ${refText}) `);
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'src-reset';
      b.textContent = `↩ ${refName === 'API' ? 'API' : 'Default'} value`;
      b.addEventListener('click', () => resetField(key, f.id));
      line.append(b);
    } else {
      line.textContent = src === 'api' ? `API (${block})` : 'Default';
    }
  });

  const changed = Object.keys(localFor(s, key)).length;
  const state = onlineBlockState(key, appConfig, rateSet);
  const stoppedBy = rateSet.format === 1 ? 'IS_STOPPED true' : '"active" not true, or no valid minimumFare / perKm';
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

// Fare and waiting examples from what is typed (before saving)
function updateLive(key) {
  const s = formSettings(key);
  const money = (n) => formatMoney(n, s);
  const ex = (km) => `${km} km = ${money(calculateFare(km, s).total)}`;
  $(`fex_${key}`).textContent = isNaN(s.minimumFare) || isNaN(s.perKmRate) ? '' : `Examples: ${ex(1)} • ${ex(5)} • ${ex(10.5)}`;
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
  updateCalcBoxes();
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
  updateCalcBoxes();
  CostCalc.refresh();
  toast(`↩ ${vname(key)}: "${f.label}" back to the ${isOnline(key) ? 'API' : 'default'} value`);
}

function useApiValues(key) {
  const n = Object.keys(localFor(loadSettings(), key)).length;
  if (!n || !confirm(`Put all ${n} changed ${vname(key)} figure${n > 1 ? 's' : ''} back to the ${isOnline(key) ? 'API' : 'default'} values?`)) return;
  if (!saveLocal(key, {})) return toast('❌ This browser blocks saving (private mode?)');
  fillVehicle(key);
  updateCalcBoxes();
  CostCalc.refresh();
  toast(`↩ ${vname(key)}: using the ${isOnline(key) ? 'API' : 'default'} values`);
}

// ---------- Per km price from the Cost per km tab ----------
function currentPerKm(key) {
  if (!appConfig.vehicles[key]) key = appConfig.defaultVehicle;
  const vs = usedSettings(key);
  return {
    perKm: effectivePerKmRate(vs),
    source: vs.perKmOverride ? 'cost per km price, ticked in Settings'
      : sourceOf(key, 'perKmRate') === 'local' ? 'price changed on this phone'
        : isOnline(key) ? 'official online rates' : 'default price',
    online: isOnline(key)
  };
}

// The "Use cost per km price" tick in each fare tab
function updateCalcBoxes() {
  const s = loadSettings();
  vehicleKeys().forEach((key) => {
    const name = vname(key);
    const saved = Number((s.perKmCalculated || {})[key]);
    const used = !!(s.useCalculated || {})[key] && saved > 0;
    const plain = vehicleSettings({ ...s, useCalculated: {} }, key, appConfig, rateSet); // without the tick
    const m = (n) => formatMoney(n, s);
    const refName = isOnline(key) ? 'API' : 'default';
    $(`usecalc_${key}`).checked = used;
    $(`usecalc_${key}`).disabled = !(saved > 0);
    $(`usecalcText_${key}`).textContent = saved > 0
      ? `Use the Cost per km price (${m(saved)} per km)` : 'Use the Cost per km price';
    $(`usecalcHint_${key}`).textContent = !(saved > 0)
      ? `No ${name} cost per km price saved yet. Work one out in the 🧮 Cost per km tab and press Save.`
      : used ? `✓ Applied from the 🧮 Cost per km tab (${m(saved)} per km). Untick to go back to the ${refName} price (${m(effectivePerKmRate(plain))} per km).`
        : `Now charging the ${refName} price: ${m(effectivePerKmRate(plain))} per km.`;
    $(`calcSlot_${key}`).classList.toggle('active', used);
    updateLive(key);
  });
}

// The per km field shows the price in use (the Cost per km price while ticked)
function showCalcFields(key) {
  $(fid(key, 'perKmRate')).value = usedSettings(key).perKmRate;
  showSources(key);
}

function setUseCalculated(key, on) {
  const s = loadSettings();
  s.useCalculated = { ...(s.useCalculated || {}), [key]: on };
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  showCalcFields(key);
  updateCalcBoxes();
  CostCalc.refresh();
  toast(on ? `✅ ${vname(key)}: using the Cost per km price` : `↩ ${vname(key)}: back to the ${isOnline(key) ? 'API' : 'default'} price`);
}

function saveCalculatorPrice(perKm, key) {
  const s = loadSettings();
  s.perKmCalculated = { ...(s.perKmCalculated || {}), [key]: perKm };
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  showCalcFields(key);
  updateCalcBoxes();
  const used = (s.useCalculated || {})[key];
  toast(`💾 ${vname(key)}: ${formatMoney(perKm, s)} saved` + (used ? ' and in use' : ' — tick it in Fare rates to use it'));
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
    getCurrent: currentPerKm,
    getSaved: (key) => (loadSettings().perKmCalculated || {})[key],
    onSave: saveCalculatorPrice,
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
  ['minimumFare', (v) => v >= 0], ['perKmRate', (v) => v >= 0], ['waitingPerHour', (v) => v >= 0],
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
        return toast(`${vname(key)}: please enter a valid "${RATE_FIELDS.find((x) => x.id === bad[0]).label}"`);
      }
    }
  }
  if (s.adminPin.length < 4) return toast('PIN must be at least 4 characters');
  if (s.mapProvider === 'google' && !s.googleApiKey) return toast('Enter a Google API key, or choose OpenStreetMap');
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  vehicleKeys().forEach(showSources);
  updateCalcBoxes();
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
