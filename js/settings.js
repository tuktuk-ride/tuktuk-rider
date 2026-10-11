// Shared settings + fare logic. Settings live in the browser's localStorage (no database).
const SETTINGS_KEY = 'tuktuk_settings_v1';

const DEFAULT_SETTINGS = {
  minimumFare: 150,     // lowest fare for a trip's distance (Rs.)
  perKmRate: 65,        // price per km (Rs.)
  enabledVehicles: ['tuktuk'], // vehicle types offered on the fare page (ticked in Admin)
  selectedVehicle: 'tuktuk',   // vehicle type last chosen on the fare page
  vehicleRates: {},            // Admin fare rates for the other vehicle types,
                               // e.g. { car: { minimumFare: 500, perKmRate: 110, waitingPerHour: 400 } }
  perKmCalculated: {},         // per km price saved from the Admin "Cost per km" tab, per type, e.g. { car: 66 }
  useCalculated: {},           // true = charge that saved price instead of the API/Admin per km price
                               // (no fuel adjustment on top, fuel is part of the calculation), e.g. { car: true }
  roundUpKm: false,     // true = charge partial km as a full km
  currency: 'Rs.',
  mapProvider: 'osm',   // 'osm' = OpenStreetMap (free) | 'google' = Google Maps (needs API key)
  googleApiKey: '',     // Google Maps API key (Maps JavaScript API + Places API (New) + Routes API)
  adminPin: '1234',
  fuelEnabled: true,    // adjust the per km price by fuel price (API IS_FUEL_PRICE overrides this)
  // Fuel. Per km price moves by fuelStepChange for every fuelStep the fuel price
  // is above/below the band of baseFuelPrice. Bands are multiples of fuelStep (400-424, 425-449...).
  fuelPrice: 414,       // current fuel price per liter
  baseFuelPrice: 414,   // fuel price the km prices were set at
  fuelStep: 25,         // every Rs. 25 band...
  fuelStepChange: 5,    // ...changes the per km price by Rs. 5
  fuelMinPerKm: 50,     // fuel change never takes the per km price below this...
  fuelMaxPerKm: 100,    // ...or above this
  kmPerLiter: 28,       // info only: fuel cost per km
  waitingEnabled: true, // charge for waiting time (API IS_WAITING true overrides this)
  waitingPerHour: 300,  // waiting charge per hour
  driverName: '',       // shown on PDF receipts
  localOverrides: {},   // figures changed in Admin on this phone, per vehicle type; they win over the API,
                        // e.g. { car: { perKmRate: 120, waitingPerHour: 350 } }. Unchanged figures follow the API.
  vehicleNumbers: {},   // number plate per vehicle type, shown on that type's receipts, e.g. { tuktuk: 'WP ABC-1234' }
  driverPhone: ''
};

// Settings saved by older versions used "1st km / next km" names: carry them over
const OLD_NAMES = { firstKmRate: 'minimumFare', nextKmRate: 'perKmRate', fuelMinNextKm: 'fuelMinPerKm', fuelMaxNextKm: 'fuelMaxPerKm' };

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    Object.entries(OLD_NAMES).forEach(([oldName, newName]) => {
      if (saved[oldName] !== undefined && saved[newName] === undefined) saved[newName] = saved[oldName];
      delete saved[oldName];
    });
    // Older versions applied cost calculator prices straight away: keep them, ticked
    const applied = { ...(saved.perKmOverrides || {}) };
    if (Number(saved.perKmOverride) > 0 && !applied.tuktuk) applied.tuktuk = Number(saved.perKmOverride);
    Object.entries(applied).forEach(([k, v]) => {
      if (!(Number(v) > 0)) return;
      saved.perKmCalculated = { ...(saved.perKmCalculated || {}), [k]: Number(v) };
      saved.useCalculated = { ...(saved.useCalculated || {}), [k]: true };
    });
    delete saved.perKmOverride;
    delete saved.perKmOverrides;
    // Older versions had one vehicle number for the phone: it becomes the tuktuk's
    if (saved.vehicleNo && !saved.vehicleNumbers) saved.vehicleNumbers = { tuktuk: saved.vehicleNo };
    delete saved.vehicleNo;
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

// Returns false if the browser blocks storage (e.g. some private-browsing modes)
function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (e) {
    return false;
  }
}

function resetSettings() {
  try { localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* storage blocked */ }
}

// ---------- Online rates ----------
// Central rates file, e.g.
// { "MINIMUM_FARE": 100, "PER_KM": 65, "ROUND_UP_KM": false, "IS_STOPPED": false,
//   "IS_FUEL_PRICE": true, "FUEL_PRICE": 414, "BASE_FUEL_PRICE": 414, "PER_LITER": 28,
//   "CHANGE_PRICE_PER": 25, "CHANGE_AMOUNT": 5, "MIN_CHANGE": 50, "MAX_CHANGE": 100 }
// IS_STOPPED false -> these values are used everywhere (matching admin fields are locked).
// IS_STOPPED true, or file unreachable -> each device's admin settings are used for everything.
// ROUND_UP_KM optional: overrides the admin "partial km as full km" tick; missing = admin tick.
// Fuel rule (BASE_FUEL_PRICE, CHANGE_PRICE_PER, CHANGE_AMOUNT, MIN_CHANGE, MAX_CHANGE): taken from the
//   API when present, otherwise admin values.
// IS_FUEL_PRICE true  = FUEL_PRICE / PER_LITER from the API (fuel adjustment on).
// IS_FUEL_PRICE false = fuel price, km per liter and the on/off tick from admin settings.
// IS_WAITING true  = waiting charge on, WAITING_PER_HOUR from the API (admin rate if missing/invalid).
// IS_WAITING false or missing = waiting on/off tick and rate from admin settings.
// Each vehicle type has a block with these fields, named by its config.json "apiKey":
//   "THREE_WHEELER": { ... }, "BIKE": { ... }, "CAR": { ... }
// Each block has its own IS_STOPPED: true -> that type uses its Admin rates.
// Older files with the fields at the top level (no "THREE_WHEELER" block) still work for the main type.
// Must be https: the app is served over https on GitHub Pages and browsers block http requests from it.
const RATES_URL = 'https://tuktukfee.theguru.asia/tuktuk.json';

// Settings overrides from one set of fields (top level, or a vehicle block), or null when that set is
// stopped (IS_STOPPED not false) or has no valid prices -> Admin settings are used instead.
function parseRateBlock(data) {
  const minFare = Number(data.MINIMUM_FARE);
  const perKm = Number(data.PER_KM);
  if (data.IS_STOPPED !== false) return null;                // stopped (or missing) -> use admin rates
  if (!(minFare >= 0) || !(perKm >= 0)) return null;         // missing / bad numbers -> use admin rates
  const rates = { minimumFare: minFare, perKmRate: perKm };
  if (typeof data.ROUND_UP_KM === 'boolean') rates.roundUpKm = data.ROUND_UP_KM;

  // Copies API number fields into settings. Only valid numbers are taken; anything else keeps the admin value.
  const take = (map, isValid) => Object.entries(map).forEach(([key, setting]) => {
    const n = Number(data[key]);
    if (data[key] !== undefined && data[key] !== null && data[key] !== '' && isValid(n, key)) rates[setting] = n;
  });

  // Fuel rule
  take({
    BASE_FUEL_PRICE: 'baseFuelPrice', CHANGE_PRICE_PER: 'fuelStep', CHANGE_AMOUNT: 'fuelStepChange',
    MIN_CHANGE: 'fuelMinPerKm', MAX_CHANGE: 'fuelMaxPerKm'
  }, (n, key) => (key === 'CHANGE_AMOUNT' ? n >= 0 : n > 0));

  // Fuel price: from the API only when IS_FUEL_PRICE is true, otherwise admin settings
  if (data.IS_FUEL_PRICE === true) {
    take({ FUEL_PRICE: 'fuelPrice', PER_LITER: 'kmPerLiter' }, (n) => n > 0);
    rates.fuelEnabled = rates.fuelPrice > 0; // no usable API fuel price -> no fuel adjustment (never guess)
  }

  // Waiting charge: from the API only when IS_WAITING is true, otherwise admin settings
  if (data.IS_WAITING === true) {
    rates.waitingEnabled = true;
    take({ WAITING_PER_HOUR: 'waitingPerHour' }, (n) => n >= 0);
  }
  return rates;
}

// Reads the online rates file: { main: overrides | null, vehicles: { bike: overrides | null, car: ... }, reachable }
async function fetchOnlineRateSet() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(RATES_URL, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return { main: null, vehicles: {}, reachable: false };
    const data = await res.json();
    const vehicles = {};
    Object.entries(data).forEach(([key, block]) => {
      if (block && typeof block === 'object' && !Array.isArray(block)) vehicles[key.toLowerCase()] = parseRateBlock(block);
    });
    return { main: parseRateBlock(data), vehicles, reachable: true };
  } catch (e) {
    return { main: null, vehicles: {}, reachable: false };     // offline / blocked / timeout / not valid JSON
  } finally {
    clearTimeout(timer);
  }
}

// Block name in the online rates file for a vehicle type, e.g. "THREE_WHEELER"
function onlineBlockName(key, cfg) {
  return String(((cfg.vehicles[key] || {}).apiKey) || key).toUpperCase();
}

// 'active' | 'stopped' | 'none' for a vehicle type's block in the online rates file
function onlineBlockState(key, cfg, rateSet) {
  const blocks = rateSet.vehicles || {};
  const name = onlineBlockName(key, cfg).toLowerCase();
  if (name in blocks) return blocks[name] ? 'active' : 'stopped';
  if (key === cfg.defaultVehicle && rateSet.main) return 'active'; // older file: top-level fields
  return 'none';
}

// Online settings overrides for a vehicle type, or null (= use Admin settings)
function onlineBlock(key, cfg, rateSet) {
  const blocks = rateSet.vehicles || {};
  const name = onlineBlockName(key, cfg).toLowerCase();
  if (name in blocks) return blocks[name];
  return key === cfg.defaultVehicle ? rateSet.main : null;
}

// ---------- Vehicle types (config.json) ----------
// Loaded once per page. Without config.json the app still works, with the tuktuk only.
const FALLBACK_CONFIG = { defaultVehicle: 'tuktuk', vehicles: { tuktuk: { name: 'Tuktuk', icon: '🛺', fare: {} } } };
let appConfigPromise = null;

function loadAppConfig() {
  if (!appConfigPromise) {
    appConfigPromise = fetch('config.json', { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => (cfg && cfg.vehicles && cfg.vehicles[cfg.defaultVehicle] ? cfg : FALLBACK_CONFIG))
      .catch(() => FALLBACK_CONFIG);
  }
  return appConfigPromise;
}

function vehicleLabel(cfg, key) {
  const v = cfg.vehicles[key];
  return v ? `${v.icon || ''} ${v.name}`.trim() : key;
}

// Is this vehicle type using the online rates file right now?
function vehicleOnline(key, cfg, rateSet) {
  return !!onlineBlock(key, cfg, rateSet);
}

// Admin fare rates for an extra vehicle type: Admin value, else config.json default
function vehicleAdminRates(admin, key, cfg) {
  const fare = (cfg.vehicles[key] || {}).fare || {};
  const own = (admin.vehicleRates || {})[key] || {};
  return {
    minimumFare: own.minimumFare ?? fare.minimumFare ?? admin.minimumFare,
    perKmRate: own.perKmRate ?? fare.perKm ?? admin.perKmRate,
    waitingPerHour: own.waitingPerHour ?? fare.waitingPerHour ?? admin.waitingPerHour
  };
}

// Fare settings for one vehicle type. Layers, last one wins:
//   defaults (config.json / built-in) -> online rates file (API) -> figures changed on this phone (Admin).
//   admin   = this phone's settings (loadSettings())
//   rateSet = fetchOnlineRateSet() result
// Main type: its online block ("THREE_WHEELER", or the top-level fields of an older file), else Admin.
// Other types: their online block ("BIKE", "CAR"), else their Admin rates / config.json defaults;
// shared Admin settings (fuel price, waiting on/off, partial km...) fill in anything a block leaves out.
function vehicleSettings(admin, key, cfg, rateSet) {
  const saved = Number((admin.perKmCalculated || {})[key]);
  const perKmOverride = (admin.useCalculated || {})[key] && saved > 0 ? saved : null; // ticked cost per km price
  const online = onlineBlock(key, cfg, rateSet) || {};
  const vehicleNo = (admin.vehicleNumbers || {})[key] || ''; // this type's number plate (receipts)
  const local = (admin.localOverrides || {})[key] || {};     // changed on this phone
  if (key === cfg.defaultVehicle) return { ...admin, ...online, ...local, perKmOverride, vehicleNo };
  return { ...admin, ...vehicleAdminRates(admin, key, cfg), ...online, ...local, perKmOverride, vehicleNo };
}

// Rs. added to (or taken off) the per km price because of the fuel price.
// e.g. base 414, step 25, change 5: 425-449 -> +5, 450-474 -> +10, 375-399 -> -5, below 375 -> -10
function fuelAdjustment(s) {
  if (!s.fuelEnabled) return 0;
  const step = Number(s.fuelStep), change = Number(s.fuelStepChange);
  const fuel = Number(s.fuelPrice), base = Number(s.baseFuelPrice);
  if (!(step > 0) || !(fuel > 0) || !(base > 0) || isNaN(change)) return 0;
  return (Math.floor(fuel / step) - Math.floor(base / step)) * change;
}

// Per km price actually charged = base per km price (API or admin) + fuel adjustment,
// kept within min..max. If the base price itself is outside min..max, no fuel adjustment is applied.
function effectivePerKmRate(s) {
  if (Number(s.perKmOverride) > 0) return Number(s.perKmOverride); // cost calculator price wins
  const base = Number(s.perKmRate);
  const min = Number(s.fuelMinPerKm), max = Number(s.fuelMaxPerKm);
  if (!s.fuelEnabled || base < min || base > max) return base;
  return Math.min(max, Math.max(min, base + fuelAdjustment(s)));
}

// Waiting charge per hour actually used (0 = waiting charge off)
function waitingRate(s) {
  const rate = Number(s.waitingPerHour);
  return s.waitingEnabled && rate > 0 ? rate : 0;
}

// 85 -> "1 h 25 min", 25 -> "25 min", 120 -> "2 h"
function formatWaiting(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return [h ? `${h} h` : '', m || !h ? `${m} min` : ''].filter(Boolean).join(' ');
}

/**
 * Distance fare = km × per km price (incl. fuel adjustment), but never less than the minimum fare.
 * Fare = distance fare + waiting charge, then rounded down to the nearest 10.
 */
function calculateFare(distanceKm, s = loadSettings(), waitingMins = 0) {
  // Round to 2 decimals first so float errors (4.1 - 1.1 = 2.9999999999999996) can't change the fare
  const round2 = (n) => Math.round(n * 100) / 100;
  let km = round2(Math.max(0, Number(distanceKm) || 0));
  if (s.roundUpKm) km = Math.ceil(km);

  const perKmRate = effectivePerKmRate(s);
  const minimumFare = Number(s.minimumFare);
  const waitRate = waitingRate(s);
  const waitMins = waitRate ? Math.max(0, Math.round(Number(waitingMins) || 0)) : 0;
  const waitingPart = round2((waitMins / 60) * waitRate);
  if (km === 0) {
    return { km, perKmRate, minimumFare, kmPart: 0, minimumApplied: false, distanceFare: 0, waitRate, waitMins: 0, waitingPart: 0, exact: 0, total: 0 };
  }

  const kmPart = round2(km * perKmRate);
  const minimumApplied = kmPart < minimumFare;
  const distanceFare = minimumApplied ? minimumFare : kmPart;
  const exact = round2(distanceFare + waitingPart);
  const total = Math.floor(exact / 10) * 10; // round DOWN to nearest 10 (e.g. 89 -> 80, 68.68 -> 60)
  return { km, perKmRate, minimumFare, kmPart, minimumApplied, distanceFare, waitRate, waitMins, waitingPart, exact, total };
}

function formatMoney(amount, s = loadSettings()) {
  const n = Number(amount);
  const decimals = Number.isInteger(n) ? 0 : 2; // 100 -> "100", 192.4 -> "192.40"
  return `${s.currency} ${n.toLocaleString('en-LK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
