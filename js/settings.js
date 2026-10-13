// Shared settings + fare logic. Settings live in the browser's localStorage (no database).
const SETTINGS_KEY = 'tuktuk_settings_v1';

// Fare figures of one vehicle type. Built-in last resort only: config.json gives each type its own
// defaults, the online rates file overrides them and Admin can change them on this phone.
const RATE_DEFAULTS = {
  minimumFare: 150,     // lowest fare for a trip's distance (Rs.)
  perKmRate: 65,        // price per km (Rs.)
  roundUpKm: false,     // true = charge partial km as a full km
  fareRoundMode: 'down', // total rounded 'down' | 'up' | 'nearest'...
  fareRoundTo: 10,      // ...to this many Rs.
  fuelEnabled: true,    // adjust the per km price by fuel price
  // Fuel. Per km price moves by fuelStepChange for every fuelStep the fuel price
  // is above/below the band of baseFuelPrice. Bands are multiples of fuelStep (400-424, 425-449...).
  fuelPrice: 414,       // current fuel price per liter
  baseFuelPrice: 414,   // fuel price the km prices were set at
  fuelStep: 25,         // every Rs. 25 band...
  fuelStepChange: 5,    // ...changes the per km price by Rs. 5
  fuelMinPerKm: 50,     // fuel change never takes the per km price below this...
  fuelMaxPerKm: 100,    // ...or above this
  kmPerLiter: 28,       // info only: fuel cost per km
  waitingEnabled: true, // charge for waiting time
  waitingPerHour: 300,  // waiting charge per hour
  waitingGraceMins: 0,  // first minutes of waiting are free...
  waitingStepMins: 1    // ...the rest is charged in blocks of this many minutes
};

const DEFAULT_SETTINGS = {
  enabledVehicles: ['tuktuk'], // vehicle types offered on the fare page (ticked in Admin)
  selectedVehicle: 'tuktuk',   // vehicle type last chosen on the fare page
  perKmCalculated: {},         // per km price saved from the Admin "Cost per km" tab, per type, e.g. { car: 66 }
  useCalculated: {},           // true = charge that saved price instead of the API/Admin per km price
                               // (no fuel adjustment on top, fuel is part of the calculation), e.g. { car: true }
  currency: 'Rs.',
  mapProvider: 'osm',   // 'osm' = OpenStreetMap (free) | 'google' = Google Maps (needs API key)
  googleApiKey: '',     // Google Maps API key (Maps JavaScript API + Places API (New) + Routes API)
  adminPin: '1234',
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

// ---------- Rate files (config.json defaults + online rates file) ----------
// Both files use the same shape per vehicle type (keys as in config.json: "tuktuk", "bike", "car"):
//   "fare":    { "minimumFare": 150, "perKm": 65, "roundUpKm": false, "roundMode": "down", "roundTo": 10 }
//   "waiting": { "enabled": true, "perHour": 300, "graceMins": 0, "stepMins": 1 }
//   "fuel":    { "enabled": true, "price": 414, "kmPerLitre": 25, "basePrice": 414,
//                "stepEvery": 25, "stepAmount": 5, "minPerKm": 50, "maxPerKm": 100 }
// Online rates file: { "schemaVersion": 2, "updatedAt": "2026-10-12", "vehicles": { "tuktuk": { "active": true, ... } } }
//   "active": true is required, plus fare.minimumFare and fare.perKm; otherwise that type uses this phone's rates.
//   Any other field left out (or null) = this phone decides (config.json default, or changed in Admin).
//   Values outside config.json "limits" are ignored, so a typo (650 instead of 65) is never charged.
// The last good copy of the online file is kept on the phone and used for "ratesCacheDays" days
// when the file can't be reached (no internet) or has an error.
// Older files ({ "THREE_WHEELER": { "MINIMUM_FARE": 150, "IS_STOPPED": false, ... }, "BIKE": ... }) still work.
// Must be https: the app is served over https on GitHub Pages and browsers block http requests from it.
const RATES_URL = 'https://tuktukfee.theguru.asia/tuktuk.json'; // when config.json has no https "ratesUrl"
const RATES_CACHE_KEY = 'tuktuk_rates_cache_v1';

const numberOk = (ok) => (v) => typeof v === 'number' && Number.isFinite(v) && ok(v);
const isBool = (v) => typeof v === 'boolean';
// [group, field in the files, setting name, valid?]
const RATE_MAP = [
  ['fare', 'minimumFare', 'minimumFare', numberOk((n) => n >= 0)],
  ['fare', 'perKm', 'perKmRate', numberOk((n) => n >= 0)],
  ['fare', 'roundUpKm', 'roundUpKm', isBool],
  ['fare', 'roundMode', 'fareRoundMode', (v) => ['down', 'up', 'nearest'].includes(v)],
  ['fare', 'roundTo', 'fareRoundTo', numberOk((n) => n > 0)],
  ['waiting', 'enabled', 'waitingEnabled', isBool],
  ['waiting', 'perHour', 'waitingPerHour', numberOk((n) => n >= 0)],
  ['waiting', 'graceMins', 'waitingGraceMins', numberOk((n) => n >= 0)],
  ['waiting', 'stepMins', 'waitingStepMins', numberOk((n) => n >= 1)],
  ['fuel', 'enabled', 'fuelEnabled', isBool],
  ['fuel', 'price', 'fuelPrice', numberOk((n) => n > 0)],
  ['fuel', 'kmPerLitre', 'kmPerLiter', numberOk((n) => n > 0)],
  ['fuel', 'basePrice', 'baseFuelPrice', numberOk((n) => n > 0)],
  ['fuel', 'stepEvery', 'fuelStep', numberOk((n) => n > 0)],
  ['fuel', 'stepAmount', 'fuelStepChange', numberOk((n) => n >= 0)],
  ['fuel', 'minPerKm', 'fuelMinPerKm', numberOk((n) => n >= 0)],
  ['fuel', 'maxPerKm', 'fuelMaxPerKm', numberOk((n) => n >= 0)]
];

// Settings from one vehicle block of config.json / the online file. Invalid or out-of-limits values are left out.
function readRateBlock(block, limits = {}) {
  const rates = {};
  RATE_MAP.forEach(([group, field, setting, valid]) => {
    let v = (block[group] || {})[field];
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(v)) v = Number(v); // "65" -> 65
    const range = (limits[group] || {})[field];
    if (!valid(v) || (range && (v < range[0] || v > range[1]))) return;
    rates[setting] = v;
  });
  if (rates.fuelMaxPerKm < rates.fuelMinPerKm) { delete rates.fuelMinPerKm; delete rates.fuelMaxPerKm; }
  return rates;
}

// Settings overrides from a vehicle block of the online file, or null (not active / no valid prices -> phone's rates)
function parseOnlineBlock(block, limits) {
  if (block.active !== true) return null;
  const rates = readRateBlock(block, limits);
  return 'minimumFare' in rates && 'perKmRate' in rates ? rates : null;
}

// Older online file: settings overrides from one set of UPPER_CASE fields (top level, or a vehicle block),
// or null when that set is stopped (IS_STOPPED not false) or has no valid prices.
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

// Block name of a vehicle type in an older online file, e.g. "THREE_WHEELER"
const LEGACY_BLOCKS = { tuktuk: 'THREE_WHEELER' };
const legacyBlockName = (key) => LEGACY_BLOCKS[key] || key.toUpperCase();
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// { format, main, vehicles: { tuktuk: overrides | null, ... }, updatedAt }, or null for a file that isn't a rates file
function parseRateFile(data, cfg) {
  if (!isObject(data)) return null;
  const vehicles = {};
  if (isObject(data.vehicles)) {
    Object.entries(data.vehicles).forEach(([key, block]) => {
      if (isObject(block)) vehicles[key.toLowerCase()] = parseOnlineBlock(block, cfg.limits || {});
    });
    return { format: 2, main: null, vehicles, updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '' };
  }
  const byName = Object.fromEntries(Object.entries(data).filter(([, b]) => isObject(b)).map(([n, b]) => [n.toUpperCase(), b]));
  Object.keys(cfg.vehicles).forEach((key) => {
    const block = byName[legacyBlockName(key)];
    if (block) vehicles[key] = parseRateBlock(block);
  });
  return { format: 1, main: parseRateBlock(data), vehicles, updatedAt: '' };
}

// Last good online file kept on this phone, if not older than config.json "ratesCacheDays"
function cachedRateSet(cfg) {
  try {
    const saved = JSON.parse(localStorage.getItem(RATES_CACHE_KEY) || 'null');
    const maxDays = Number(cfg.ratesCacheDays ?? 14);
    if (!saved || !(Date.now() - saved.savedAt <= maxDays * 864e5)) return null;
    const set = parseRateFile(saved.data, cfg);
    return set && { ...set, reachable: false, cachedAt: saved.savedAt };
  } catch (e) {
    return null;
  }
}

// Reads the online rates file: { format, main, vehicles, updatedAt, reachable, cachedAt? }.
// Not reachable / not valid JSON -> the saved copy, else no online rates (this phone's rates are used).
async function fetchOnlineRateSet() {
  const cfg = await loadAppConfig();
  const url = /^https:\/\//.test(cfg.ratesUrl || '') ? cfg.ratesUrl : RATES_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const set = parseRateFile(data, cfg);
    if (!set) throw new Error('not a rates file');
    try { localStorage.setItem(RATES_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data })); } catch (e) { /* storage blocked */ }
    return { ...set, reachable: true };
  } catch (e) {
    return cachedRateSet(cfg) || { format: 0, main: null, vehicles: {}, updatedAt: '', reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

// Name of a vehicle type's block in the online file, for messages, e.g. "tuktuk" or "THREE_WHEELER"
function onlineBlockName(key, cfg, rateSet) {
  return rateSet && rateSet.format === 1 ? legacyBlockName(key) : key;
}

// 'active' | 'stopped' | 'none' for a vehicle type's block in the online rates file
function onlineBlockState(key, cfg, rateSet) {
  const blocks = rateSet.vehicles || {};
  if (key in blocks) return blocks[key] ? 'active' : 'stopped';
  if (key === cfg.defaultVehicle && rateSet.main) return 'active'; // older file: top-level fields
  return 'none';
}

// Online settings overrides for a vehicle type, or null (= use this phone's rates)
function onlineBlock(key, cfg, rateSet) {
  const blocks = rateSet.vehicles || {};
  if (key in blocks) return blocks[key];
  return key === cfg.defaultVehicle ? rateSet.main || null : null;
}

// e.g. "✓ Official online rates (updated 2026-10-12)" / "✓ Official rates (offline copy from 12 Oct)"
function onlineSourceText(rateSet) {
  if (rateSet.cachedAt) {
    const day = new Date(rateSet.cachedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `✓ Official rates (offline copy from ${day})`;
  }
  return '✓ Official online rates' + (rateSet.updatedAt ? ` (updated ${rateSet.updatedAt})` : '');
}

// ---------- Vehicle types (config.json) ----------
// Loaded once per page. Without config.json the app still works, with the tuktuk only.
const FALLBACK_CONFIG = { defaultVehicle: 'tuktuk', vehicles: { tuktuk: { name: 'Tuktuk', icon: '🛺' } } };
let appConfigPromise = null;

function loadAppConfig() {
  if (!appConfigPromise) {
    appConfigPromise = fetch('config.json', { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((cfg) => (cfg && isObject(cfg.vehicles) && cfg.vehicles[cfg.defaultVehicle] ? cfg : FALLBACK_CONFIG))
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

// Rate figures saved by older versions of the app: top-level fields for the main type (the fuel price for
// every type), and "vehicleRates" for the others. They still win over config.json.
function legacyRates(admin, key, cfg) {
  if (key === cfg.defaultVehicle) {
    return Object.fromEntries(Object.keys(RATE_DEFAULTS).filter((f) => admin[f] !== undefined).map((f) => [f, admin[f]]));
  }
  const own = (admin.vehicleRates || {})[key] || {};
  return Object.fromEntries(Object.entries({
    fuelPrice: admin.fuelPrice, minimumFare: own.minimumFare, perKmRate: own.perKmRate, waitingPerHour: own.waitingPerHour
  }).filter(([, v]) => v !== undefined));
}

// Fare settings for one vehicle type. Layers, last one wins:
//   built-in -> config.json -> figures saved by older versions -> online rates file (API) -> changed on this phone (Admin)
//   admin   = this phone's settings (loadSettings())
//   rateSet = fetchOnlineRateSet() result
function vehicleSettings(admin, key, cfg, rateSet) {
  const saved = Number((admin.perKmCalculated || {})[key]);
  const perKmOverride = (admin.useCalculated || {})[key] && saved > 0 ? saved : null; // ticked cost per km price
  const configRates = readRateBlock(cfg.vehicles[key] || {});
  const online = onlineBlock(key, cfg, rateSet) || {};
  const vehicleNo = (admin.vehicleNumbers || {})[key] || ''; // this type's number plate (receipts)
  const local = (admin.localOverrides || {})[key] || {};     // changed on this phone
  return { ...admin, ...RATE_DEFAULTS, ...configRates, ...legacyRates(admin, key, cfg), ...online, ...local, perKmOverride, vehicleNo };
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

// Waiting minutes actually charged: the free minutes are taken off, the rest is charged in whole blocks.
// e.g. 5 free, blocks of 15: 4 min -> 0, 6 min -> 15, 21 min -> 30
function billedWaitingMins(mins, s) {
  const grace = Math.max(0, Number(s.waitingGraceMins) || 0);
  const step = Math.max(1, Number(s.waitingStepMins) || 1);
  return mins > grace ? Math.ceil((mins - grace) / step) * step : 0;
}

// Total rounding: 'down' | 'up' | 'nearest' to fareRoundTo Rs. (default down to 10)
function roundFare(exact, s) {
  const to = Number(s.fareRoundTo) > 0 ? Number(s.fareRoundTo) : 10;
  const steps = Math.round((exact / to) * 1e6) / 1e6; // ignore float noise like 89.99999999
  const n = s.fareRoundMode === 'up' ? Math.ceil(steps) : s.fareRoundMode === 'nearest' ? Math.round(steps) : Math.floor(steps);
  return n * to;
}

// e.g. "rounded down to 10", "rounded to the nearest 5"
function roundingText(s) {
  const to = Number(s.fareRoundTo) > 0 ? Number(s.fareRoundTo) : 10;
  return s.fareRoundMode === 'up' ? `rounded up to ${to}` : s.fareRoundMode === 'nearest' ? `rounded to the nearest ${to}` : `rounded down to ${to}`;
}

// e.g. "first 5 min free, then per 15 min", "" when every minute is charged
function waitingRuleText(s) {
  const grace = Math.max(0, Number(s.waitingGraceMins) || 0);
  const step = Math.max(1, Number(s.waitingStepMins) || 1);
  return [grace ? `first ${grace} min free` : '', step > 1 ? `charged per ${step} min` : ''].filter(Boolean).join(', ');
}

/**
 * Distance fare = km × per km price (incl. fuel adjustment), but never less than the minimum fare.
 * Fare = distance fare + waiting charge (after free minutes, in blocks), then rounded (default down to 10).
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
  const billedMins = billedWaitingMins(waitMins, s);
  const waitingPart = round2((billedMins / 60) * waitRate);
  if (km === 0) {
    return { km, perKmRate, minimumFare, kmPart: 0, minimumApplied: false, distanceFare: 0, waitRate, waitMins: 0, billedMins: 0, waitingPart: 0, exact: 0, total: 0 };
  }

  const kmPart = round2(km * perKmRate);
  const minimumApplied = kmPart < minimumFare;
  const distanceFare = minimumApplied ? minimumFare : kmPart;
  const exact = round2(distanceFare + waitingPart);
  const total = roundFare(exact, s); // default DOWN to nearest 10 (e.g. 89 -> 80, 68.68 -> 60)
  return { km, perKmRate, minimumFare, kmPart, minimumApplied, distanceFare, waitRate, waitMins, billedMins, waitingPart, exact, total };
}

function formatMoney(amount, s = loadSettings()) {
  const n = Number(amount);
  const decimals = Number.isInteger(n) ? 0 : 2; // 100 -> "100", 192.4 -> "192.40"
  return `${s.currency} ${n.toLocaleString('en-LK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
