const $ = (id) => document.getElementById(id);
const FIELDS = ['firstKmRate', 'nextKmRate', 'currency', 'googleApiKey', 'adminPin',
                'driverName', 'vehicleNo', 'driverPhone'];
const FUEL_FIELDS = ['fuelPrice', 'baseFuelPrice', 'fuelStep', 'fuelStepChange', 'fuelMinNextKm', 'fuelMaxNextKm', 'kmPerLiter'];

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 2000);
}

function fillForm(s) {
  FIELDS.concat(FUEL_FIELDS).forEach((f) => ($(f).value = s[f]));
  $('roundUpKm').checked = !!s.roundUpKm;
  $('fuelEnabled').checked = !!s.fuelEnabled;
  const radio = document.querySelector(`input[name="mapProvider"][value="${s.mapProvider}"]`) ||
                document.querySelector('input[name="mapProvider"][value="osm"]');
  radio.checked = true;
  updateExample();
  updateMapBox();
}

function readForm() {
  return {
    firstKmRate: parseFloat($('firstKmRate').value),
    nextKmRate: parseFloat($('nextKmRate').value),
    currency: $('currency').value.trim() || 'Rs.',
    googleApiKey: $('googleApiKey').value.trim(),
    adminPin: $('adminPin').value.trim(),
    driverName: $('driverName').value.trim(),
    vehicleNo: $('vehicleNo').value.trim(),
    driverPhone: $('driverPhone').value.trim(),
    roundUpKm: $('roundUpKm').checked,
    fuelEnabled: $('fuelEnabled').checked,
    ...Object.fromEntries(FUEL_FIELDS.map((f) => [f, parseFloat($(f).value)])),
    mapProvider: document.querySelector('input[name="mapProvider"]:checked').value
  };
}

// Only show the API key field when Google Maps is selected
function updateMapBox() {
  $('googleKeyBox').classList.toggle('hidden', readForm().mapProvider !== 'google');
}

// Shows what the fuel figures do to the next km price
function updateFuelSummary() {
  const s = readForm();
  if (!s.fuelEnabled) return ($('fuelSummary').textContent = 'Fuel adjustment is off: next km price is not changed by fuel price.');
  if (FUEL_FIELDS.some((f) => !(s[f] >= 0)) || isNaN(s.nextKmRate)) return ($('fuelSummary').textContent = '');
  const adj = fuelAdjustment(s);
  const charged = effectiveNextKmRate(s);
  const applied = charged - s.nextKmRate;
  const sign = (n) => (n < 0 ? '-' : '+');
  const lowBand = Math.floor(s.fuelPrice / s.fuelStep) * s.fuelStep;
  let note = '';
  if (s.nextKmRate < s.fuelMinNextKm || s.nextKmRate > s.fuelMaxNextKm) note = ' (next km price is outside the limits, so no fuel change)';
  else if (applied !== adj) note = ` (limited to ${formatMoney(applied > 0 || adj > 0 ? s.fuelMaxNextKm : s.fuelMinNextKm, s)})`;
  $('fuelSummary').innerHTML = '';
  [
    s.kmPerLiter > 0 ? `Fuel cost per km: ${formatMoney((s.fuelPrice / s.kmPerLiter).toFixed(2), s)}` : 'Fuel cost per km: - (km per liter not set)',
    `Fuel band: ${lowBand} – ${lowBand + s.fuelStep - 0.01} → next km ${sign(adj)} ${formatMoney(Math.abs(adj), s)}`,
    `Next km price charged: ${formatMoney(s.nextKmRate, s)} ${sign(applied)} ${formatMoney(Math.abs(applied), s)} = ${formatMoney(charged, s)}${note}`
  ].forEach((t) => { const d = document.createElement('div'); d.textContent = t; $('fuelSummary').appendChild(d); });
}

// Live example so admin can see the effect of the rates
function updateExample() {
  updateFuelSummary();
  const s = readForm();
  if (isNaN(s.firstKmRate) || isNaN(s.nextKmRate)) return ($('example').textContent = '');
  const ex = (km) => `${km} km = ${formatMoney(calculateFare(km, s).total, s)}`;
  $('example').textContent = `Examples: ${ex(1)} • ${ex(5)} • ${ex(10.5)}`;
}

// ---------- Online rates ----------
// When the online rates file is active (IS_STOPPED false), its prices replace the admin ones
let onlineRates = null;

function applyOnlineRates() {
  const locked = !!onlineRates;
  if (locked) {
    $('firstKmRate').value = onlineRates.firstKmRate;
    $('nextKmRate').value = onlineRates.nextKmRate;
  }
  $('firstKmRate').disabled = locked;
  $('nextKmRate').disabled = locked;
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
  updateExample();
}

// ---------- Login ----------
async function login() {
  if ($('pinInput').value === loadSettings().adminPin) {
    $('loginCard').classList.add('hidden');
    $('settingsForm').classList.remove('hidden');
    fillForm(loadSettings());
    onlineRates = await fetchOnlineRates();
    applyOnlineRates();
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
    ['fuelEnabled'].concat(FUEL_FIELDS).forEach((f) => { if (onlineRates[f] !== undefined) s[f] = own[f]; });
  }
  if (isNaN(s.firstKmRate) || isNaN(s.nextKmRate) || s.firstKmRate < 0 || s.nextKmRate < 0) {
    return toast('Please enter valid prices');
  }
  if (s.adminPin.length < 4) return toast('PIN must be at least 4 characters');
  if (!(s.fuelPrice > 0) || !(s.baseFuelPrice > 0) || !(s.fuelStep > 0) || !(s.kmPerLiter > 0) || isNaN(s.fuelStepChange)) {
    return toast('Please enter valid fuel figures');
  }
  if (!(s.fuelMinNextKm >= 0) || !(s.fuelMaxNextKm >= s.fuelMinNextKm)) {
    return toast('Next km highest price must be more than the lowest');
  }
  if (s.mapProvider === 'google' && !s.googleApiKey) return toast('Enter a Google API key, or choose OpenStreetMap');
  if (!saveSettings(s)) return toast('❌ This browser blocks saving (private mode?)');
  toast('✅ Settings saved');
});

$('resetBtn').addEventListener('click', () => {
  if (!confirm('Reset all settings to defaults (Rs.100 / Rs.65, OpenStreetMap, PIN 1234, no API key)?')) return;
  resetSettings();
  fillForm(loadSettings());
  applyOnlineRates();
  toast('Settings reset');
});
