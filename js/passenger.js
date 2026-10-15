// Rider / Passenger mode.
// Rider: the full fare tool (map, meter, waiting, receipts, Admin).
// Passenger: an estimate for every vehicle type, from the official online rates only
// (never a rider phone's own changes). Mode is remembered on the phone; ?mode=passenger or
// ?mode=rider in the link sets it (e.g. a QR code inside the vehicle).
const MODE_KEY = 'tuktuk_app_mode';
const ESTIMATE_SPREAD = 1.15; // upper end of the range allows ~15% for detours / traffic

function readMode() {
  const fromLink = new URLSearchParams(location.search).get('mode');
  if (fromLink === 'rider' || fromLink === 'passenger') { saveMode(fromLink); return fromLink; }
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'rider' || saved === 'passenger') return saved;
    if (localStorage.getItem(SETTINGS_KEY)) return 'rider'; // a phone already set up by a rider
  } catch (e) { /* storage blocked */ }
  return ''; // ask
}

function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* storage blocked */ }
}

let appMode = readMode();
const isPassenger = () => appMode === 'passenger';

function setMode(mode) {
  appMode = mode;
  saveMode(mode);
  applyMode();
  window.scrollTo(0, 0);
}

function applyMode() {
  document.body.dataset.mode = appMode || 'choose';
  $('modeSwitch').innerHTML = isPassenger() ? '🛺<span class="hide-small"> Rider</span>' : '🙋<span class="hide-small"> Passenger</span>';
  $('modeSwitch').title = isPassenger() ? 'Switch to Rider mode' : 'Switch to Passenger mode';
  hideResult();
  if (isPassenger()) {
    // passengers use the map or a typed distance (no meter)
    if (document.querySelector('.tab.active').dataset.panel === 'meterPanel') document.querySelector('.tab[data-panel="mapPanel"]').click();
    $('calcMapBtn').textContent = 'Estimate fare';
    $('calcDistanceBtn').textContent = 'Estimate fare';
    ratesReady.then(() => isPassenger() && updateExpresswayBox());
    renderTripTypes(); // names only: each vehicle type has its own price per km
    $('waitingTitle').textContent = '⏱ Expected waiting (optional)';
    ratesReady.then(() => {
      if (!isPassenger()) return;
      $('waitingCard').classList.remove('hidden');
      $('waitingInfo').textContent = "Each vehicle type's waiting charge is added to its estimate.";
    });
  } else {
    $('calcMapBtn').textContent = 'Calculate Fare';
    $('calcDistanceBtn').textContent = 'Calculate Fare';
    $('waitingTitle').textContent = '⏱ Waiting time';
    ratesReady.then(() => { if (appMode === 'rider') applyVehicle(currentVehicle, false); }); // rider's waiting box / rates
  }
  // the map was hidden while choosing: let it measure itself again
  setTimeout(() => provider && provider.resize && provider.resize(), 50);
}

document.querySelectorAll('[data-choose]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.choose)));
$('modeSwitch').addEventListener('click', (e) => {
  e.preventDefault();
  setMode(isPassenger() ? 'rider' : 'passenger');
});

// ---------- Estimates ----------
let lastRoutes = null; // { vehicleKey: route }

// One route per route rule (tuk-tuk + bike: no expressways; car: may use them), then each vehicle type's estimate
async function passengerEstimate() {
  const keys = Object.keys(appConfig.vehicles);
  const rules = [...new Set(keys.map((k) => JSON.stringify(routeOptions(k))))];
  const found = await Promise.all(rules.map((rule) => provider.route(points.start, points.end, JSON.parse(rule))));
  const byRule = Object.fromEntries(rules.map((rule, i) => [rule, found[i]]));
  const routes = Object.fromEntries(keys.map((k) => [k, byRule[JSON.stringify(routeOptions(k))]]));
  const main = routes[appConfig.defaultVehicle];
  if (main.km < 0.01) throw new Error('start and end are the same place.');
  provider.drawRoute(main.path); // the main vehicle type's route on the map
  provider.fit([points.start, points.end]);
  mapError();
  showEstimates(routes);
}

// Typed distance: the same km for every vehicle type, no route
function passengerDistanceEstimate(km) {
  showEstimates(Object.fromEntries(Object.keys(appConfig.vehicles).map((k) => [k, { km, entered: true }])));
}

// Official rates only: built-in defaults + online file, nothing changed on this phone
const officialBase = () => ({ ...DEFAULT_SETTINGS, currency: adminSettings.currency || DEFAULT_SETTINGS.currency });

function expectedWaitMins() {
  const h = Math.max(0, parseFloat($('waitHours').value) || 0);
  const m = Math.max(0, parseFloat($('waitMinutes').value) || 0);
  return Math.round(h * 60 + m);
}

function showEstimates(routes) {
  lastRoutes = routes;
  renderEstimates();
  $('estimateCard').classList.remove('hidden');
  $('estimateCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function estimateFor(key, route, waitMins) {
  const s = vehicleSettings(officialBase(), key, appConfig, rateSet);
  const low = calculateFare(route.km, s, waitMins, tripType).total;
  const high = route.entered ? low : calculateFare(route.km * ESTIMATE_SPREAD, s, waitMins, tripType).total; // typed km: exact
  return { key, s, low, high, plusToll: usesExpressway(route, key), official: vehicleOnline(key, appConfig, rateSet) };
}

function priceText(e) {
  const price = e.low === e.high ? formatMoney(e.low, e.s) : `${formatMoney(e.low, e.s)} – ${formatMoney(e.high, e.s).replace(e.s.currency + ' ', '')}`;
  return price + (e.plusToll ? TOLL_WORDS : '');
}

function renderEstimates() {
  if (!lastRoutes) return;
  const waitMins = expectedWaitMins();
  const list = Object.keys(appConfig.vehicles).map((key) => ({ ...estimateFor(key, lastRoutes[key], waitMins), route: lastRoutes[key] }));

  const entered = list[0].route.entered;
  $('estimateTrip').textContent = TRIP_TYPES[tripType].name + '  •  ' + (entered ? `Distance entered: ${list[0].route.km} km`
    : 'Shortest route for each vehicle type' +
      ($('useExpressway').checked ? ` (expressway allowed; never for ${noExpresswayNames()})` : ' (no expressways)')) +
    (waitMins ? `  •  ${formatWaiting(waitMins)} waiting` : '');
  $('estimateFrom').textContent = entered ? '' : 'From: ' + (pointLabels.start || '-');
  $('estimateTo').textContent = entered ? '' : 'To: ' + (pointLabels.end || '-');

  const box = $('estimateList');
  box.innerHTML = '';
  list.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'est-row';
    row.innerHTML = '<div class="est-name"><b></b><small></small></div><div class="est-price"></div>';
    row.querySelector('b').textContent = vehicleLabel(appConfig, e.key);
    row.querySelector('small').textContent =
      `${e.route.km.toFixed(1)} km` + (e.route.mins ? ` (~${e.route.mins} min)` : '') +
      (e.plusToll && e.route.expresswayKm ? ` incl. ${e.route.expresswayKm} km expressway (toll extra)` : '') +
      ` • minimum ${formatMoney(e.s.minimumFare, e.s)} • ${formatMoney(tripPerKm(e.s, tripType), e.s)} per km` +
      (waitMins && waitingRate(e.s) ? ` • waiting ${formatMoney(waitingRate(e.s), e.s)}/h` : '');
    row.querySelector('.est-price').textContent = priceText(e);
    box.appendChild(row);
  });

  const allOfficial = list.every((e) => e.official);
  $('estimateNote').textContent = (allOfficial
    ? 'Estimated with the official TukTuk Rider rates. '
    : "Today's official rates couldn't be loaded for every vehicle type, so standard rates are used where needed. ") +
    'The final fare is worked out by the driver from the actual distance and waiting time. ' +
    (entered ? 'Worked out from the distance you entered.' : 'The range allows for small detours and traffic.');
  lastEstimates = list;
}

let lastEstimates = [];

function estimateText() {
  const lines = [
    '🛺 TukTuk Rider — fare estimate',
    ...[$('estimateFrom').textContent, $('estimateTo').textContent].filter(Boolean),
    $('estimateTrip').textContent.replace(/\s+•\s+/g, ' • '),
    ...lastEstimates.map((e) => `${vehicleLabel(appConfig, e.key)} (${e.route.km.toFixed(1)} km): ${priceText(e)}`)
  ];
  return lines.join('\n');
}

$('shareEstimateBtn').addEventListener('click', async () => {
  const url = location.origin + location.pathname + '?mode=passenger';
  const text = estimateText();
  if (navigator.share) {
    try { await navigator.share({ title: 'TukTuk Rider fare estimate', text, url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text + '\n' + url);
    alert('Estimate copied. Paste it into WhatsApp, Viber or SMS.');
  } catch (e) {
    alert(text);
  }
});

// Expected waiting changed: update the estimates on screen
['waitHours', 'waitMinutes'].forEach((id) => $(id).addEventListener('input', () => {
  if (isPassenger() && !$('estimateCard').classList.contains('hidden')) renderEstimates();
}));

applyMode();
