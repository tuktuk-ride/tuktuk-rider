const adminSettings = loadSettings();               // this phone's settings
let rateSet = { main: null, vehicles: {} };          // online rates file
let appConfig = FALLBACK_CONFIG;                     // vehicle types (config.json)
let currentVehicle = appConfig.defaultVehicle;
let settings = adminSettings;                        // fare settings of the selected vehicle type
const $ = (id) => document.getElementById(id);

// ---------- Rates (online file first, admin settings as fallback) ----------
// e.g. " (incl. fuel +Rs. 5)" - the change actually applied after the min/max limits
function fuelNote() {
  if (Number(settings.perKmOverride) > 0) return ' (admin cost calculator price)';
  const applied = effectivePerKmRate(settings) - Number(settings.perKmRate);
  return applied ? ` (incl. fuel ${applied > 0 ? '+' : '-'}${formatMoney(Math.abs(applied), settings)})` : '';
}

function showRateInfo(source) {
  $('rateInfo').textContent =
    `Minimum fare: ${formatMoney(settings.minimumFare, settings)}  •  ` +
    `Per km: ${formatMoney(effectivePerKmRate(settings), settings)}` +
    fuelNote() +
    (settings.roundUpKm ? '  •  partial km charged as full km' : '') +
    (waitingRate(settings) ? `  •  Waiting: ${formatMoney(waitingRate(settings), settings)}/hour` +
      (waitingRuleText(settings) ? ` (${waitingRuleText(settings)})` : '') : '');
  $('rateSource').textContent = source;

  $('waitingCard').classList.toggle('hidden', !waitingRate(settings));
  $('waitingInfo').textContent = `Charged at ${formatMoney(waitingRate(settings), settings)} per hour` +
    (waitingRuleText(settings) ? ` (${waitingRuleText(settings)}).` : '.');
}

// ---------- Vehicle type ----------
// Route rules per vehicle type: 3-wheelers and motorbikes may never use expressways (config.json);
// the others use them only when "Use the expressway" is ticked. The toll is not added to the fare:
// a fare on an expressway route reads "Rs. 1,100 + expressway toll".
const expresswayAllowed = (key) => !(appConfig.vehicles[key] || {}).avoidExpressways;
const routeOptions = (key) => ({ avoidExpressways: !(expresswayAllowed(key) && $('useExpressway').checked) });
const usesExpressway = (r, key) => !!(r && r.expressway && expresswayAllowed(key) && $('useExpressway').checked);
const TOLL_WORDS = ' + expressway toll';

// The tick only matters for vehicle types allowed on expressways
function updateExpresswayBox() {
  const passenger = typeof isPassenger === 'function' && isPassenger();
  const anyAllowed = Object.keys(appConfig.vehicles).some(expresswayAllowed);
  $('expresswayBox').classList.toggle('hidden', passenger ? !anyAllowed : !expresswayAllowed(currentVehicle));
  $('expresswayHint').textContent = passenger
    ? 'For cars. Tuk-tuks and bikes never use expressways. The toll is paid on top of the fare.'
    : 'The toll is not included: the fare will read "+ expressway toll".';
}

$('useExpressway').addEventListener('change', () => {
  // re-route a trip that is on screen
  const shown = !$('resultCard').classList.contains('hidden') || !$('estimateCard').classList.contains('hidden');
  if (shown && points.start && points.end) $('calcMapBtn').click();
});

function routeNote(r, opts) {
  if (r.fallback && opts.avoidExpressways) return 'route may use an expressway (the expressway-free route service could not be reached)';
  if (opts.avoidExpressways) return 'shortest route without expressways';
  if (r.expressway) return r.expresswayKm ? `shortest route, ${r.expresswayKm} km on the expressway` : 'shortest route, via the expressway';
  return 'shortest route (no expressway needed)';
}

// Types ticked in Admin, in config.json order (at least the main type)
function enabledVehicles() {
  const ticked = Object.keys(appConfig.vehicles).filter((k) => (adminSettings.enabledVehicles || []).includes(k));
  return ticked.length ? ticked : [appConfig.defaultVehicle];
}

function applyVehicle(key, remember = true) {
  currentVehicle = key;
  settings = vehicleSettings(adminSettings, key, appConfig, rateSet);
  const changed = Object.keys((adminSettings.localOverrides || {})[key] || {}).length;
  const online = vehicleOnline(key, appConfig, rateSet);
  updateExpresswayBox();
  showRateInfo(online
    ? onlineSourceText(rateSet) + (changed ? ', with figures changed on this phone' : '')
    : (changed ? "Using this phone's rates" : 'Using the default rates'));
  if (lastTrip && !$('resultCard').classList.contains('hidden')) {
    // a map trip needs this vehicle's own route (e.g. no expressway for tuk-tuks); a meter trip keeps its km
    if (lastTrip.mode === 'map' && points.start && points.end) $('calcMapBtn').click();
    else renderResult();
  }
  if (remember) saveSettings({ ...loadSettings(), selectedVehicle: key });
}

$('vehicleSelect').addEventListener('change', () => applyVehicle($('vehicleSelect').value));

$('rateInfo').textContent = 'Loading rates…';
// Every fare calculation waits for this, so a fare is never worked out with the wrong rates.
const ratesReady = Promise.all([fetchOnlineRateSet(), loadAppConfig()]).then(([set, cfg]) => {
  rateSet = set;
  appConfig = cfg;
  const keys = enabledVehicles();
  $('vehicleSelect').innerHTML = '';
  keys.forEach((k) => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.textContent = vehicleLabel(appConfig, k);
    $('vehicleSelect').appendChild(opt);
  });
  const start = keys.includes(adminSettings.selectedVehicle) ? adminSettings.selectedVehicle : keys[0];
  $('vehicleSelect').value = start;
  applyVehicle(start, false);
});

// ---------- Tabs ----------
// The waiting time box sits just above the Calculate Fare button of whichever tab is open
function placeWaitingBox(panelId) {
  $(panelId).querySelector('.waiting-slot').appendChild($('waitingCard'));
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.panel).classList.add('active');
    placeWaitingBox(tab.dataset.panel);
  });
});
placeWaitingBox(document.querySelector('.tab.active').dataset.panel);

// ---------- Result ----------
let lastTrip = null; // details of the last calculated trip, used for the PDF receipt

// Waiting time from the Hours / Minutes boxes, in whole minutes (blank or negative = 0)
function getWaitingMins() {
  if (!waitingRate(settings)) return 0;
  const h = Math.max(0, parseFloat($('waitHours').value) || 0);
  const m = Math.max(0, parseFloat($('waitMinutes').value) || 0);
  return Math.round(h * 60 + m);
}

function showResult(distanceKm, durationText, trip) {
  lastTrip = { ...trip, distanceKm, durationText, date: new Date() };
  renderResult();
  $('resultCard').classList.remove('hidden');
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderResult() {
  lastTrip.waitingMins = getWaitingMins();
  lastTrip.vehicleName = (appConfig.vehicles[currentVehicle] || {}).name || currentVehicle;
  lastTrip.plusToll = lastTrip.mode === 'map' && usesExpressway(lastTrip.route, currentVehicle);
  const f = calculateFare(lastTrip.distanceKm, settings, lastTrip.waitingMins);
  $('resultDistance').textContent = `${vehicleLabel(appConfig, currentVehicle)}  •  Distance: ${Number(lastTrip.distanceKm).toFixed(2)} km` +
    (settings.roundUpKm ? ` (charged as ${f.km} km)` : '') +
    (f.waitMins ? `  •  Waiting: ${formatWaiting(f.waitMins)}` : '');
  $('resultTotal').textContent = formatMoney(f.total, settings) + (lastTrip.plusToll ? TOLL_WORDS : '');
  $('resultDuration').textContent = lastTrip.durationText || '';

  $('resultBreakdown').innerHTML = `
    <tr><td>${f.km.toFixed(2)} km × ${formatMoney(f.perKmRate, settings)}</td>
        <td>${formatMoney(f.kmPart.toFixed(2), settings)}</td></tr>` +
    (f.minimumApplied ? `
    <tr><td>Minimum fare applied</td><td>${formatMoney(f.minimumFare, settings)}</td></tr>` : '') +
    (f.waitMins ? `
    <tr><td>Waiting ${formatWaiting(f.waitMins)}${f.billedMins !== f.waitMins ? ` (charged ${formatWaiting(f.billedMins)})` : ''} × ${formatMoney(f.waitRate, settings)}/hour</td>
        <td>${formatMoney(f.waitingPart.toFixed(2), settings)}</td></tr>` : '') + `
    <tr><td>Exact amount</td><td>${formatMoney(f.exact.toFixed(2), settings)}</td></tr>
    <tr><td><b>Total (${roundingText(settings)})</b></td><td><b>${formatMoney(f.total, settings)}</b></td></tr>` +
    (lastTrip.plusToll ? `
    <tr><td>Expressway toll (${lastTrip.route.expresswayKm} km on the expressway)</td><td>paid on top</td></tr>` : '');
}

function hideResult() {
  $('resultCard').classList.add('hidden');
  $('estimateCard').classList.add('hidden'); // passenger estimate (js/passenger.js)
}

// ---------- Meter mode ----------
$('calcMeterBtn').addEventListener('click', async () => {
  await ratesReady;
  $('meterError').textContent = '';
  const start = parseFloat($('startMeter').value);
  const end = parseFloat($('endMeter').value);

  if (isNaN(start) || isNaN(end)) {
    $('meterError').textContent = 'Please enter both start and end meter readings.';
    return hideResult();
  }
  if (end <= start) {
    $('meterError').textContent = 'End meter reading must be greater than start reading.';
    return hideResult();
  }
  showResult(end - start, '', { mode: 'meter', startMeter: start, endMeter: end });
});

// Readings changed: old fare/receipt no longer valid
['startMeter', 'endMeter'].forEach((id) => $(id).addEventListener('input', hideResult));

// Waiting time changed: update the shown fare straight away
['waitHours', 'waitMinutes'].forEach((id) => $(id).addEventListener('input', () => {
  if (lastTrip && !$('resultCard').classList.contains('hidden')) renderResult();
}));

function clearWaiting() {
  $('waitHours').value = '';
  $('waitMinutes').value = '';
}

$('clearMeterBtn').addEventListener('click', () => {
  clearWaiting();
  $('startMeter').value = '';
  $('endMeter').value = '';
  $('meterError').textContent = '';
  hideResult();
});

// ---------- Map mode (OpenStreetMap or Google, chosen in Admin) ----------
const points = { start: null, end: null };
const pointLabels = { start: '', end: '' };
let provider = null;

function mapError(msg) { $('mapError').textContent = msg || ''; }

function pickProvider() {
  if (settings.mapProvider === 'google') {
    if (settings.googleApiKey) return createGoogleProvider(settings.googleApiKey);
    $('mapNotice').textContent = 'Google Maps is selected but no API key is set in Admin — using OpenStreetMap instead.';
    $('mapNotice').classList.remove('hidden');
  }
  return createOsmProvider();
}

function setPoint(which, pos, label) {
  points[which] = pos;
  pointLabels[which] = label && label !== 'Pinned on map'
    ? label
    : `Pinned location (${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)})`;
  $(which + 'Text').textContent =
    `${which === 'start' ? 'A' : 'B'}: ${label || 'Pinned on map'} (${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)})`;
  provider.setMarker(which, pos, (p) => setPoint(which, p, 'Pinned on map'));
  provider.clearRoute();
  hideResult(); // trip changed: old fare/receipt no longer valid
  mapError();
  if (points.start && points.end) provider.fit([points.start, points.end]);
}

// Search boxes
document.querySelectorAll('.search-row').forEach((form) => {
  const which = form.dataset.which;
  const list = $(which + 'Results');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $(which + 'Search').value.trim();
    if (!provider) return mapError('Map is not loaded yet.');
    if (q.length < 2 || q === FINDING_ADDRESS) return;

    list.innerHTML = '<li class="muted">Searching…</li>';
    list.classList.remove('hidden');
    try {
      const results = await provider.search(q);
      list.innerHTML = '';
      if (!results.length) {
        list.innerHTML = '<li class="muted">No places found. Try another name, or tap the map.</li>';
        return;
      }
      results.forEach((r) => {
        const li = document.createElement('li');
        li.textContent = r.label;
        li.addEventListener('click', () => {
          list.classList.add('hidden');
          $(which + 'Search').value = r.label.split(',')[0].split(' — ')[0];
          setPoint(which, { lat: r.lat, lng: r.lng }, r.label);
          if (!(points.start && points.end)) provider.focus(r);
        });
        list.appendChild(li);
      });
    } catch (err) {
      list.innerHTML = '<li class="muted"></li>';
      list.firstChild.textContent = 'Search failed: ' + err.message;
    }
  });
});

// ---------- Use my location ----------
const FINDING_ADDRESS = 'My location (finding address…)';
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
              (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function getPosition(options) {
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(resolve, reject, options));
}

// Precise GPS first; if that is slow or unavailable (indoors, GPS just switched on), fall back to
// the faster network/Wi-Fi location. A permission refusal is not retried.
async function findMyPosition() {
  try {
    return await getPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  } catch (err) {
    if (err.code === 1) throw err; // PERMISSION_DENIED
    return getPosition({ enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
  }
}

function locationErrorMessage(err) {
  if (!window.isSecureContext) return 'Location only works on the https:// address of the site.';
  const installedApp = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (err.code === 1 && installedApp && !isIos) {
    return 'Location is blocked. Long-press the TukTuk Rider icon → App info → Permissions → Location → Allow, and make sure the phone Location is ON. Then tap the button again.';
  }
  if (err.code === 1) {
    return isIos
      ? 'Location is blocked. iPhone: Settings → Privacy & Security → Location Services → turn ON, then Safari Websites → "While Using the App". Then tap the button again.'
      : 'Location is blocked. Tap the 🔒 icon next to the web address → Permissions → Location → Allow, and make sure the phone Location is ON. Then tap the button again.';
  }
  if (err.code === 2) return 'Your phone could not find its location. Turn ON Location (GPS) in the phone settings, or search the start place / tap the map instead.';
  return 'Finding your location took too long. Move near a window or outside and try again, or search the start place / tap the map instead.';
}

$('myLocationBtn').addEventListener('click', async () => {
  if (!provider) return mapError('Map is not loaded yet. Check your internet connection.');
  if (!navigator.geolocation) return mapError('This browser does not support location. Search the start place or tap the map instead.');

  const btn = $('myLocationBtn');
  btn.disabled = true;
  btn.textContent = '📡 Finding your location…';
  mapError();
  try {
    const p = await findMyPosition();
    const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
    const accuracy = Math.round(p.coords.accuracy);
    setPoint('start', pos, `My location (±${accuracy} m)`);
    $('startSearch').value = FINDING_ADDRESS;
    if (!points.end) provider.focus(pos);

    // Put the street address in the Start box (full address below it and on the receipt)
    const address = provider.reverse ? await provider.reverse(pos).catch(() => null) : null;
    if (points.start !== pos) return; // user picked another start meanwhile
    if (address) {
      setPoint('start', pos, `${address} (my location, ±${accuracy} m)`);
      $('startSearch').value = address.split(',').slice(0, 3).map((t) => t.trim()).join(', ');
    } else {
      $('startSearch').value = `My location (${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)})`;
    }
  } catch (err) {
    mapError(locationErrorMessage(err));
  } finally {
    btn.disabled = false;
    btn.textContent = '📡 Use my location as start';
  }
});

$('calcMapBtn').addEventListener('click', async () => {
  if (!provider) return mapError('Map is not loaded yet.');
  if (!points.start || !points.end) return mapError('Please select both start and end locations.');

  mapError('Calculating route…');
  $('calcMapBtn').disabled = true;
  try {
    await ratesReady;
    if (isPassenger()) return await passengerEstimate(); // every vehicle type, each on its own route
    const opts = routeOptions(currentVehicle);
    const r = await provider.route(points.start, points.end, opts);
    if (r.km < 0.01) throw new Error('start and end are the same place.');
    provider.drawRoute(r.path);
    provider.fit([points.start, points.end]);
    mapError();
    showResult(r.km, `Approx. travel time: ${r.mins} min  •  ${routeNote(r, opts)}`, {
      mode: 'map', from: pointLabels.start, to: pointLabels.end, mins: r.mins, route: r
    });
  } catch (err) {
    mapError('Could not calculate route: ' + err.message);
    hideResult();
  } finally {
    $('calcMapBtn').disabled = false;
  }
});

$('clearMapBtn').addEventListener('click', () => {
  clearWaiting();
  ['start', 'end'].forEach((w) => {
    points[w] = null;
    provider && provider.removeMarker(w);
    $(w + 'Text').textContent = '';
    $(w + 'Search').value = '';
    $(w + 'Results').classList.add('hidden');
  });
  provider && provider.clearRoute();
  mapError();
  hideResult();
});

// ---------- PDF receipt ----------
function buildReceipt() {
  if (!lastTrip) return null;
  if (!window.jspdf) {
    alert('PDF library could not load. Check your internet connection.');
    return null;
  }
  return createReceiptPdf({ ...lastTrip, passenger: $('passengerName').value.trim() }, settings);
}

$('downloadReceiptBtn').addEventListener('click', () => {
  const r = buildReceipt();
  if (r) r.doc.save(r.fileName);
});

$('shareReceiptBtn').addEventListener('click', async () => {
  const r = buildReceipt();
  if (!r) return;
  const file = new File([r.doc.output('blob')], r.fileName, { type: 'application/pdf' });
  const total = formatMoney(calculateFare(lastTrip.distanceKm, settings, lastTrip.waitingMins).total, settings) +
    (lastTrip.plusToll ? TOLL_WORDS : '');

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'TukTuk Rider receipt', text: `Trip fare: ${total}` });
    } catch (e) { /* user closed the share sheet */ }
  } else {
    // Desktop browsers usually can't share files: download instead
    r.doc.save(r.fileName);
    alert('Sharing is not supported on this browser, so the receipt was downloaded instead.');
  }
});

// ---------- Start ----------
(async () => {
  const p = pickProvider();
  $('mapSource').textContent = `Map: ${p.name}`;
  try {
    await p.init($('map'), (pos) => setPoint(points.start ? 'end' : 'start', pos, 'Pinned on map'));
    provider = p;
  } catch (err) {
    mapError(err.message + ' You can still use Meter mode.');
  }
})();
