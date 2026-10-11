let settings = loadSettings();
const $ = (id) => document.getElementById(id);

// ---------- Rates (online file first, admin settings as fallback) ----------
// e.g. " (incl. fuel +Rs. 5)" - the change actually applied after the min/max limits
function fuelNote() {
  const applied = effectiveNextKmRate(settings) - Number(settings.nextKmRate);
  return applied ? ` (incl. fuel ${applied > 0 ? '+' : '-'}${formatMoney(Math.abs(applied), settings)})` : '';
}

function showRateInfo(source) {
  $('rateInfo').textContent =
    `1st km: ${formatMoney(settings.firstKmRate, settings)}  •  ` +
    `Each next km: ${formatMoney(effectiveNextKmRate(settings), settings)}` +
    fuelNote() +
    (settings.roundUpKm ? '  •  partial km charged as full km' : '');
  $('rateSource').textContent = source;
}

$('rateInfo').textContent = 'Loading rates…';
// Every fare calculation waits for this, so a fare is never worked out with the wrong rates.
const ratesReady = fetchOnlineRates().then((online) => {
  if (online) {
    settings = { ...settings, ...online };
    showRateInfo('✓ Official online rates');
  } else {
    showRateInfo("Using this device's admin rates");
  }
});

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(tab.dataset.panel).classList.add('active');
  });
});

// ---------- Result ----------
let lastTrip = null; // details of the last calculated trip, used for the PDF receipt

function showResult(distanceKm, durationText, trip) {
  lastTrip = { ...trip, distanceKm, date: new Date() };
  const f = calculateFare(distanceKm, settings);
  $('resultDistance').textContent = `Distance: ${Number(distanceKm).toFixed(2)} km` +
    (settings.roundUpKm ? ` (charged as ${f.km} km)` : '');
  $('resultTotal').textContent = formatMoney(f.total, settings);
  $('resultDuration').textContent = durationText || '';

  $('resultBreakdown').innerHTML = `
    <tr><td>1st km</td><td>${formatMoney(f.firstPart, settings)}</td></tr>
    <tr><td>Next ${f.nextKm.toFixed(2)} km × ${formatMoney(f.nextRate, settings)}</td>
        <td>${formatMoney(f.nextPart.toFixed(2), settings)}</td></tr>
    <tr><td>Exact amount</td><td>${formatMoney(f.exact.toFixed(2), settings)}</td></tr>
    <tr><td><b>Total (rounded down to 10)</b></td><td><b>${formatMoney(f.total, settings)}</b></td></tr>`;

  $('resultCard').classList.remove('hidden');
  $('resultCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function hideResult() {
  $('resultCard').classList.add('hidden');
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

$('clearMeterBtn').addEventListener('click', () => {
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
    const r = await provider.route(points.start, points.end);
    if (r.km < 0.01) throw new Error('start and end are the same place.');
    provider.drawRoute(r.path);
    provider.fit([points.start, points.end]);
    mapError();
    showResult(r.km, `Approx. travel time: ${r.mins} min`, {
      mode: 'map', from: pointLabels.start, to: pointLabels.end, mins: r.mins
    });
  } catch (err) {
    mapError('Could not calculate route: ' + err.message);
    hideResult();
  } finally {
    $('calcMapBtn').disabled = false;
  }
});

$('clearMapBtn').addEventListener('click', () => {
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
  const total = formatMoney(calculateFare(lastTrip.distanceKm, settings).total, settings);

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
