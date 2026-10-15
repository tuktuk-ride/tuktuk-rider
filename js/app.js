const adminSettings = loadSettings();               // this phone's settings
let rateSet = { main: null, vehicles: {} };          // online rates file
let appConfig = FALLBACK_CONFIG;                     // vehicle types (config.json)
let currentVehicle = appConfig.defaultVehicle;
let settings = adminSettings;                        // fare settings of the selected vehicle type
const $ = (id) => document.getElementById(id);

// ---------- Trip type: one way / empty return / round trip ----------
const TRIP_KEY = 'tuktuk_trip_type';
let tripType = 'oneway';
try { tripType = tripTypeOk(localStorage.getItem(TRIP_KEY)); } catch (e) { /* storage blocked */ }

// The 3 buttons: name + this vehicle's price per km (rider); names only for passengers (every vehicle type)
function renderTripTypes() {
  const passenger = typeof isPassenger === 'function' && isPassenger();
  const prices = tripPrices(settings);
  document.querySelectorAll('#tripTypes .trip-type').forEach((b) => {
    const t = b.dataset.trip;
    b.classList.toggle('active', t === tripType);
    b.innerHTML = '<b></b><small></small>';
    b.querySelector('b').textContent = TRIP_TYPES[t].name;
    b.querySelector('small').textContent = passenger || !(prices[t] > 0) ? '' : `${formatMoney(prices[t], settings)}/km`;
  });
  $('tripTypeInfo').textContent = TRIP_TYPES[tripType].info;
}

document.querySelectorAll('#tripTypes .trip-type').forEach((b) => b.addEventListener('click', () => {
  tripType = tripTypeOk(b.dataset.trip);
  try { localStorage.setItem(TRIP_KEY, tripType); } catch (e) { /* storage blocked */ }
  renderTripTypes();
  if (typeof isPassenger === 'function' && isPassenger()) {
    if (!$('estimateCard').classList.contains('hidden')) renderEstimates();
    return;
  }
  showRateInfo($('rateSource').textContent);
  if (lastTrip && !$('resultCard').classList.contains('hidden')) renderResult();
}));

// ---------- Rates (online file first, admin settings as fallback) ----------
function showRateInfo(source) {
  renderTripTypes();
  $('rateInfo').textContent =
    `Minimum fare: ${formatMoney(settings.minimumFare, settings)}  •  ` +
    `${TRIP_TYPES[tripType].name}: ${formatMoney(tripPerKm(settings, tripType), settings)}/km` +
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
// "routePreference" in config.json: 'main' = the main road first (cars), else the shortest route first
const routeOptions = (key) => ({
  avoidExpressways: !(expresswayAllowed(key) && $('useExpressway').checked),
  prefer: (appConfig.vehicles[key] || {}).routePreference === 'main' ? 'main' : 'shortest'
});
const usesExpressway = (r, key) => !!(r && r.expressway && expresswayAllowed(key) && $('useExpressway').checked);
// e.g. "tuktuk and bike": the types that never use expressways (config.json)
const noExpresswayNames = () => {
  const names = Object.values(appConfig.vehicles).filter((v) => v.avoidExpressways).map((v) => v.name.toLowerCase());
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names.join('');
};
const TOLL_WORDS = ' + expressway toll';

// The tick only matters for vehicle types allowed on expressways
function updateExpresswayBox() {
  const passenger = typeof isPassenger === 'function' && isPassenger();
  const anyAllowed = Object.keys(appConfig.vehicles).some(expresswayAllowed);
  $('expresswayBox').classList.toggle('hidden', passenger ? !anyAllowed : !expresswayAllowed(currentVehicle));
  $('expresswayHint').textContent = passenger
    ? `Not for ${noExpresswayNames() || 'every type'}: they never use expressways. The toll is paid on top of the fare.`
    : 'The toll is not included: the fare will read "+ expressway toll".';
}

$('useExpressway').addEventListener('change', () => {
  // re-route a trip that is on screen
  const shown = !$('resultCard').classList.contains('hidden') || !$('estimateCard').classList.contains('hidden');
  if (shown && points.start && points.end) $('calcMapBtn').click();
});

// how: 'suggested' | 'chosen' (another route from the list) | 'own' (the rider's own road, via the ✚ pin)
function routeNote(r, opts, how = 'suggested') {
  const kind = how === 'own' ? 'your own road (via the ✚ pin)' : how === 'chosen' ? 'route you chose'
    : opts.prefer === 'main' ? 'main road route' : 'shortest route';
  if (r.fallback && opts.avoidExpressways) return `${kind} (may use an expressway: the expressway-free route service could not be reached)`;
  if (opts.avoidExpressways) return `${kind} without expressways`;
  if (r.expressway) return r.expresswayKm ? `${kind}, ${r.expresswayKm} km on the expressway` : `${kind}, via the expressway`;
  return `${kind} (no expressway needed)`;
}

// Types ticked in Admin, in config.json order (every type until Admin is saved; at least the main type)
function enabledVehicles() {
  const all = Object.keys(appConfig.vehicles);
  if (!Array.isArray(adminSettings.enabledVehicles)) return all;
  const ticked = all.filter((k) => adminSettings.enabledVehicles.includes(k));
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
    // a map trip needs this vehicle's own route (e.g. no expressway for a tuktuk); a meter trip keeps its km
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
    const seats = vehicleSettings(adminSettings, k, appConfig, rateSet).passengers;
    opt.textContent = vehicleLabel(appConfig, k) + (seats ? `  ·  ${seatsText(seats)}` : '');
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
    if (tab.dataset.panel === 'mapPanel') setTimeout(() => provider && provider.resize && provider.resize(), 50); // map was hidden
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
  lastTrip.tripType = tripType;
  const f = calculateFare(lastTrip.distanceKm, settings, lastTrip.waitingMins, tripType);
  $('resultDistance').textContent = `${vehicleLabel(appConfig, currentVehicle)}  •  ${TRIP_TYPES[tripType].name}  •  ` +
    `Distance: ${Number(lastTrip.distanceKm).toFixed(2)} km` +
    (lastTrip.mode === 'distance' ? ' (entered)' : '') +
    (settings.roundUpKm ? ` (charged as ${f.km} km)` : '') +
    (f.waitMins ? `  •  Waiting: ${formatWaiting(f.waitMins)}` : '');
  $('resultTotal').textContent = formatMoney(f.total, settings) + (lastTrip.plusToll ? TOLL_WORDS : '');
  $('resultDuration').textContent = lastTrip.durationText || '';
  renderRouteChoices();

  $('resultBreakdown').innerHTML = `
    <tr><td>${f.km.toFixed(2)} km × ${formatMoney(f.perKmRate, settings)} (${TRIP_TYPES[f.tripType].name.toLowerCase()})</td>
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

// ---------- Route choices (map trips) ----------
// Every route found, with its km, time and fare; the rider taps the road they will really take,
// or drags a ✚ pin onto another road ("your own road", one more option)
const ROUTE_COLORS = ['#1a73e8', '#8e24aa', '#00897b', '#6d4c41', '#3949ab', '#c2185b']; // route 1, 2, 3… (also the list dots)
const OWN_ROAD_COLOR = '#ef6c00';
let viaPoint = null; // the ✚ pin

const routeColor = (r, i) => (r.own ? OWN_ROAD_COLOR : ROUTE_COLORS[i % ROUTE_COLORS.length]);

function renderRouteChoices() {
  const routes = lastTrip.mode === 'map' ? lastTrip.routes || [] : [];
  $('routeChoices').classList.toggle('hidden', !routes.length);
  if (!routes.length) return;
  const found = routes.filter((r) => !r.own).length;
  const minKm = Math.min(...routes.map((r) => r.km)), minMins = Math.min(...routes.map((r) => r.mins));
  $('routeChoiceTitle').textContent = routes.length > 1
    ? `🛣 Choose the road (${found} route${found > 1 ? 's' : ''} found${viaPoint ? ' + your own road' : ''})` : '🛣 Road';
  const list = $('routeChoiceList');
  list.innerHTML = '';
  routes.forEach((r, i) => {
    const fare = calculateFare(r.km, settings, lastTrip.waitingMins, tripType).total;
    const tags = routes.length > 1 ? [r.km === minKm ? 'shortest' : '', r.mins === minMins ? 'fastest' : ''].filter(Boolean).join(', ') : '';
    const onExpressway = usesExpressway(r, currentVehicle);
    const item = document.createElement('div');
    item.className = 'route-choice' + (i === lastTrip.routeIndex ? ' selected' : '');
    item.style.borderColor = i === lastTrip.routeIndex ? routeColor(r, i) : '';
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.innerHTML = '<span class="route-dot"></span><span class="rc-text"><b></b><small></small></span><span class="rc-fare"></span>';
    item.querySelector('.route-dot').style.background = routeColor(r, i);
    item.querySelector('b').textContent = (r.own ? 'Your road (via ✚ pin)' : `Route ${i + 1}`) + (tags ? ` (${tags})` : '');
    item.querySelector('small').textContent = `${r.km.toFixed(2)} km  •  ~${r.mins} min` +
      (onExpressway ? `  •  🛣 ${r.expresswayKm ? r.expresswayKm + ' km on' : 'uses'} the expressway` : '');
    item.querySelector('.rc-fare').textContent = formatMoney(fare, settings) + (onExpressway ? ' + toll' : '');
    item.addEventListener('click', () => selectRoute(i));
    item.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && selectRoute(i));
    if (r.own) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'rc-remove';
      x.title = 'Remove your own road';
      x.textContent = '✕';
      x.addEventListener('click', (e) => { e.stopPropagation(); clearVia(true); });
      item.appendChild(x);
    }
    list.appendChild(item);
  });
  $('routeExpresswayLegend').classList.toggle('hidden', !routes.some((r) => usesExpressway(r, currentVehicle)));
  $('ownRoadBtn').textContent = viaPoint ? '✚ Drag the ✚ pin on the map onto your road' : '➕ Choose my own road';
  $('ownRoadBtn').disabled = !!viaPoint;
}

// Expressway routes first, then the roads without it; the same road found twice is listed once
function mergeRoutes(withExpressway, without) {
  const same = (a, b) => Math.abs(a.km - b.km) < 0.05 && Math.abs(a.mins - b.mins) <= 1;
  const out = [...withExpressway];
  without.forEach((r) => { if (!out.some((x) => same(x, r))) out.push({ ...r, expressway: false }); });
  return out.slice(0, ROUTE_COLORS.length);
}

function drawTripRoutes() {
  provider.drawRoutes(lastTrip.routes.map((r, i) => ({
    path: r.path, color: routeColor(r, i),
    expresswayParts: usesExpressway(r, currentVehicle) ? (r.expresswayParts && r.expresswayParts.length ? r.expresswayParts : [r.path]) : []
  })), lastTrip.routeIndex, { onPick: selectRoute, onLineTap: placeVia });
}

function selectRoute(i) {
  if (!lastTrip || lastTrip.mode !== 'map' || !lastTrip.routes[i]) return;
  const r = lastTrip.routes[i];
  Object.assign(lastTrip, {
    routeIndex: i, route: r, distanceKm: r.km, mins: r.mins,
    durationText: `Approx. travel time: ${r.mins} min  •  ${routeNote(r, lastTrip.routeOpts, r.own ? 'own' : i ? 'chosen' : 'suggested')}`
  });
  renderResult();
  drawTripRoutes();
}

// ✚ pin: put it on the route (tap / press), then drag it onto the road the rider will take
function placeVia(pos, startEvent) {
  if (!lastTrip || lastTrip.mode !== 'map') return;
  viaPoint = pos;
  provider.setVia(pos, (p) => { viaPoint = p; routeViaPin(); }, startEvent);
  renderRouteChoices();
  mapError();
}

// The rider's own road: the route through the ✚ pin, one more option (selected)
async function routeViaPin() {
  const trip = lastTrip;
  if (!trip || trip.mode !== 'map' || !viaPoint) return;
  mapError('Finding a road through the ✚ pin…');
  try {
    const r = await provider.route(points.start, points.end, trip.routeOpts, viaPoint);
    if (lastTrip !== trip) return; // trip changed meanwhile
    const own = { ...r, own: true, options: undefined };
    const i = trip.routes.findIndex((x) => x.own);
    if (i >= 0) trip.routes[i] = own; else trip.routes.push(own);
    mapError();
    selectRoute(i >= 0 ? i : trip.routes.length - 1);
  } catch (err) {
    mapError('No road found through the ✚ pin: ' + err.message + ' Drag the pin onto a road.');
  }
}

// Remove the ✚ pin (and, when asked, its road from the list)
function clearVia(fromList = false) {
  viaPoint = null;
  if (provider && provider.removeVia) provider.removeVia();
  if (!fromList || !lastTrip || !lastTrip.routes) return;
  const wasOwn = lastTrip.route && lastTrip.route.own;
  lastTrip.routes = lastTrip.routes.filter((r) => !r.own);
  if (wasOwn) selectRoute(0); else { renderResult(); drawTripRoutes(); }
}

$('ownRoadBtn').addEventListener('click', () => {
  const p = lastTrip && lastTrip.route && lastTrip.route.path;
  if (p && p.length) placeVia(p[Math.floor(p.length / 2)]); // middle of the selected route
});

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
['startMeter', 'endMeter'].forEach((id) => ['input', 'change'].forEach((ev) => $(id).addEventListener(ev, hideResult)));

// Waiting time changed: update the shown fare straight away
['waitHours', 'waitMinutes'].forEach((id) => ['input', 'change'].forEach((ev) => $(id).addEventListener(ev, () => {
  if (lastTrip && !$('resultCard').classList.contains('hidden')) renderResult();
})));

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

// ---------- Distance mode (km typed in) ----------
const MAX_DISTANCE_KM = 1000; // more than this is surely a typo

$('calcDistanceBtn').addEventListener('click', async () => {
  await ratesReady;
  $('distanceError').textContent = '';
  const km = parseFloat($('distanceKm').value);
  if (!(km > 0)) {
    $('distanceError').textContent = 'Please enter the trip distance in km.';
    return hideResult();
  }
  if (km > MAX_DISTANCE_KM) {
    $('distanceError').textContent = `Please check the distance: more than ${MAX_DISTANCE_KM} km.`;
    return hideResult();
  }
  if (isPassenger()) return passengerDistanceEstimate(km); // every vehicle type
  showResult(km, '', { mode: 'distance' });
});

// Distance changed: old fare/receipt no longer valid
['input', 'change'].forEach((ev) => $('distanceKm').addEventListener(ev, hideResult));
$('distanceKm').addEventListener('keydown', (e) => e.key === 'Enter' && $('calcDistanceBtn').click());

$('clearDistanceBtn').addEventListener('click', () => {
  clearWaiting();
  $('distanceKm').value = '';
  $('distanceError').textContent = '';
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
  clearVia(); // a new start / end: the ✚ pin belonged to the old trip
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
    // Expressway ticked (vehicle types allowed on it): also the routes without the expressway, to choose from
    if (!opts.avoidExpressways) {
      const plain = await provider.route(points.start, points.end, { ...opts, avoidExpressways: true }).catch(() => null);
      if (plain) r.options = mergeRoutes(r.options || [r], plain.options || [plain]);
    }
    provider.fit([points.start, points.end]);
    mapError();
    showResult(r.km, `Approx. travel time: ${r.mins} min  •  ${routeNote(r, opts)}`, {
      mode: 'map', from: pointLabels.start, to: pointLabels.end, mins: r.mins, route: r,
      routes: r.options || [r], routeIndex: 0, routeOpts: opts
    });
    drawTripRoutes();
    if (viaPoint) await routeViaPin(); // keep the rider's own road (e.g. after changing vehicle type)
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
  clearVia();
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
  const total = formatMoney(calculateFare(lastTrip.distanceKm, settings, lastTrip.waitingMins, lastTrip.tripType).total, settings) +
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
