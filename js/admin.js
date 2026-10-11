const $ = (id) => document.getElementById(id);
const FIELDS = ['minimumFare', 'perKmRate', 'currency', 'googleApiKey', 'adminPin',
                'driverName', 'vehicleNo', 'driverPhone'];
// Waiting charge fields (waitingEnabled is a checkbox)
const WAITING_FIELDS = ['waitingEnabled', 'waitingPerHour'];
const FUEL_FIELDS = ['fuelPrice', 'baseFuelPrice', 'fuelStep', 'fuelStepChange', 'fuelMinPerKm', 'fuelMaxPerKm', 'kmPerLiter'];

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2000);
}

function fillForm(s) {
  FIELDS.concat(FUEL_FIELDS).forEach((f) => ($(f).value = s[f]));
  $('roundUpKm').checked = !!s.roundUpKm;
  $('fuelEnabled').checked = !!s.fuelEnabled;
  $('waitingEnabled').checked = !!s.waitingEnabled;
  $('waitingPerHour').value = s.waitingPerHour;
  const radio = document.querySelector(`input[name="mapProvider"][value="${s.mapProvider}"]`) ||
                document.querySelector('input[name="mapProvider"][value="osm"]');
  radio.checked = true;
  updateExample();
  updateMapBox();
}

function readForm() {
  return {
    minimumFare: parseFloat($('minimumFare').value),
    perKmRate: parseFloat($('perKmRate').value),
    currency: $('currency').value.trim() || 'Rs.',
    googleApiKey: $('googleApiKey').value.trim(),
    adminPin: $('adminPin').value.trim(),
    driverName: $('driverName').value.trim(),
    vehicleNo: $('vehicleNo').value.trim(),
    driverPhone: $('driverPhone').value.trim(),
    roundUpKm: $('roundUpKm').checked,
    fuelEnabled: $('fuelEnabled').checked,
    waitingEnabled: $('waitingEnabled').checked,
    waitingPerHour: parseFloat($('waitingPerHour').value),
    ...Object.fromEntries(FUEL_FIELDS.map((f) => [f, parseFloat($(f).value)])),
    mapProvider: document.querySelector('input[name="mapProvider"]:checked').value,
    perKmOverride: loadSettings().perKmOverride // only changed by the Cost per km tab / reset button
  };
}

// Only show the API key field when Google Maps is selected
function updateMapBox() {
  $('googleKeyBox').classList.toggle('hidden', readForm().mapProvider !== 'google');
}

// Shows what the fuel figures do to the per km price
function updateFuelSummary() {
  const s = readForm();
  if (Number(s.perKmOverride) > 0) {
    return ($('fuelSummary').textContent = `Fuel adjustment is not used while the cost calculator price (${formatMoney(s.perKmOverride, s)} per km) is applied.`);
  }
  if (!s.fuelEnabled) return ($('fuelSummary').textContent = 'Fuel adjustment is off: per km price is not changed by fuel price.');
  if (FUEL_FIELDS.some((f) => !(s[f] >= 0)) || isNaN(s.perKmRate)) return ($('fuelSummary').textContent = '');
  const adj = fuelAdjustment(s);
  const charged = effectivePerKmRate(s);
  const applied = charged - s.perKmRate;
  const sign = (n) => (n < 0 ? '-' : '+');
  const lowBand = Math.floor(s.fuelPrice / s.fuelStep) * s.fuelStep;
  let note = '';
  if (s.perKmRate < s.fuelMinPerKm || s.perKmRate > s.fuelMaxPerKm) note = ' (per km price is outside the limits, so no fuel change)';
  else if (applied !== adj) note = ` (limited to ${formatMoney(applied > 0 || adj > 0 ? s.fuelMaxPerKm : s.fuelMinPerKm, s)})`;
  $('fuelSummary').innerHTML = '';
  [
    s.kmPerLiter > 0 ? `Fuel cost per km: ${formatMoney((s.fuelPrice / s.kmPerLiter).toFixed(2), s)}` : 'Fuel cost per km: - (km per liter not set)',
    `Fuel band: ${lowBand} – ${lowBand + s.fuelStep - 0.01} → per km ${sign(adj)} ${formatMoney(Math.abs(adj), s)}`,
    `Per km price charged: ${formatMoney(s.perKmRate, s)} ${sign(applied)} ${formatMoney(Math.abs(applied), s)} = ${formatMoney(charged, s)}${note}`
  ].forEach((t) => { const d = document.createElement('div'); d.textContent = t; $('fuelSummary').appendChild(d); });
}

// e.g. "Example: 25 min waiting = Rs. 125"
function updateWaitingExample() {
  const s = readForm();
  $('waitingExample').textContent = waitingRate(s)
    ? `Example: 25 min waiting = ${formatMoney(((25 / 60) * waitingRate(s)).toFixed(2), s)} • 1 h = ${formatMoney(waitingRate(s), s)}`
    : 'Waiting charge is off.';
}

// Live example so admin can see the effect of the rates
function updateExample() {
  updateFuelSummary();
  updateWaitingExample();
  const s = readForm();
  if (isNaN(s.minimumFare) || isNaN(s.perKmRate)) return ($('example').textContent = '');
  const ex = (km) => `${km} km = ${formatMoney(calculateFare(km, s).total, s)}`;
  $('example').textContent = `Examples: ${ex(1)} • ${ex(5)} • ${ex(10.5)}`;
}

// ---------- Online rates ----------
// When the online rates file is active (IS_STOPPED false), its prices replace the admin ones
let onlineRates = null;

function applyOnlineRates() {
  const locked = !!onlineRates;
  if (locked) {
    $('minimumFare').value = onlineRates.minimumFare;
    $('perKmRate').value = onlineRates.perKmRate;
  }
  $('minimumFare').disabled = locked;
  $('perKmRate').disabled = locked;
  // The tick is only locked if the online file sets ROUND_UP_KM
  const tickLocked = locked && typeof onlineRates.roundUpKm === 'boolean';
  if (tickLocked) $('roundUpKm').checked = onlineRates.roundUpKm;
  $('roundUpKm').disabled = tickLocked;
  $('onlineRatesNotice').classList.toggle('hidden', !locked);

  // Lock each fuel field the online file provides; the rest stay editable here
  let anyFuelLocked = false;
  ['fuelEnabled'].concat(FUEL_FIELDS).forEach((f) => {
    const fromApi = locked && onlineRates[f] !== undefined;
    if (fromApi) {
      if (f === 'fuelEnabled') $(f).checked = onlineRates[f];
      else $(f).value = onlineRates[f];
    }
    $(f).disabled = fromApi;
    anyFuelLocked = anyFuelLocked || fromApi;
  });
  $('onlineFuelNotice').classList.toggle('hidden', !anyFuelLocked);

  // Waiting charge: locked when the online file sets IS_WAITING true
  let anyWaitingLocked = false;
  WAITING_FIELDS.forEach((f) => {
    const fromApi = locked && onlineRates[f] !== undefined;
    if (fromApi) {
      if (f === 'waitingEnabled') $(f).checked = onlineRates[f];
      else $(f).value = onlineRates[f];
    }
    $(f).disabled = fromApi;
    anyWaitingLocked = anyWaitingLocked || fromApi;
  });
  $('onlineWaitingNotice').classList.toggle('hidden', !anyWaitingLocked);
  updateExample();
}

// ---------- Per km price from the Cost per km tab ----------
// What the fare page charges per km now, and where it comes from
function currentPerKm() {
  const merged = { ...loadSettings(), ...(onlineRates || {}) };
  const applied = Number(merged.perKmOverride) > 0;
  return {
    perKm: effectivePerKmRate(merged),
    source: applied ? 'cost calculator price applied on this phone' : onlineRates ? 'official online rates' : "this phone's admin price",
    online: !!onlineRates
  };
}

function updateOverrideNotice() {
  const applied = Number(loadSettings().perKmOverride);
  $('overrideNotice').classList.toggle('hidden', !(applied > 0));
  if (!(applied > 0)) return;
  const base = effectivePerKmRate({ ...loadSettings(), ...(onlineRates || {}), perKmOverride: null });
  $('overrideText').innerHTML = '';
  const b = document.createElement('b');
  b.textContent = `🧮 Per km price comes from the cost calculator: ${formatMoney(applied, loadSettings())}`;
  const p = document.createElement('div');
  p.textContent = `This phone uses it instead of the ${onlineRates ? 'online (API)' : 'Admin'} per km price (${formatMoney(base, loadSettings())}). ` +
    'Press Reset to go back to the API price.';
  $('overrideText').append(b, p);
}

$('overrideResetBtn').addEventListener('click', () => {
  const s = loadSettings();
  s.perKmOverride = null;
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  updateOverrideNotice();
  updateExample();
  CostCalc.refresh();
  toast('↩ Back to the API / Admin per km price');
});

function applyCalculatorPrice(perKm) {
  const s = loadSettings();
  s.perKmOverride = perKm;
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  updateOverrideNotice();
  updateExample();
  toast(`✅ ${formatMoney(perKm, s)} per km applied. Reset it any time in Settings.`);
}

// ---------- Tabs ----------
function showPanel(id) {
  document.querySelectorAll('#adminTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === id));
  ['settingsForm', 'costPanel'].forEach((p) => $(p).classList.toggle('hidden', p !== id));
  window.scrollTo(0, 0);
}
document.querySelectorAll('#adminTabs .tab, [data-goto]').forEach((b) =>
  b.addEventListener('click', () => showPanel(b.dataset.panel || b.dataset.goto)));

// ---------- Login ----------
async function login() {
  if ($('pinInput').value === loadSettings().adminPin) {
    $('loginCard').classList.add('hidden');
    $('adminTabs').classList.remove('hidden');
    $('settingsForm').classList.remove('hidden');
    fillForm(loadSettings());
    updateOverrideNotice();
    // Start the Cost per km tab now; it refreshes once the online rates have loaded
    CostCalc.init({ getCurrent: currentPerKm, onApply: applyCalculatorPrice });
    onlineRates = await fetchOnlineRates();
    applyOnlineRates();
    updateOverrideNotice();
    CostCalc.refresh();
  } else {
    $('loginError').textContent = 'Wrong PIN.';
  }
}
$('loginBtn').addEventListener('click', login);
$('pinInput').addEventListener('keydown', (e) => e.key === 'Enter' && login());

// ---------- Save / reset ----------
$('settingsForm').addEventListener('input', () => { updateExample(); updateMapBox(); });

$('settingsForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let s = readForm();
  if (onlineRates) {
    const own = loadSettings();
    ['fuelEnabled'].concat(FUEL_FIELDS, WAITING_FIELDS).forEach((f) => { if (onlineRates[f] !== undefined) s[f] = own[f]; });
  }
  if (isNaN(s.minimumFare) || isNaN(s.perKmRate) || s.minimumFare < 0 || s.perKmRate < 0) {
    return toast('Please enter valid prices');
  }
  if (s.adminPin.length < 4) return toast('PIN must be at least 4 characters');
  if (!(s.fuelPrice > 0) || !(s.baseFuelPrice > 0) || !(s.fuelStep > 0) || !(s.kmPerLiter > 0) || isNaN(s.fuelStepChange)) {
    return toast('Please enter valid fuel figures');
  }
  if (!(s.fuelMinPerKm >= 0) || !(s.fuelMaxPerKm >= s.fuelMinPerKm)) {
    return toast('Per km highest price must be more than the lowest');
  }
  if (!(s.waitingPerHour >= 0)) return toast('Please enter a valid waiting charge per hour');
  if (s.mapProvider === 'google' && !s.googleApiKey) return toast('Enter a Google API key, or choose OpenStreetMap');
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  toast('✅ Settings saved');
  updateOverrideNotice();
  CostCalc.refresh();
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('Reset all settings to defaults (Rs.100 / Rs.65, OpenStreetMap, PIN 1234, no API key)?')) return;
  resetSettings();
  fillForm(loadSettings());
  applyOnlineRates();
  updateOverrideNotice();
  CostCalc.refresh();
  toast('Settings reset');
});
