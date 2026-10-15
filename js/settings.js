// Shared settings + fare logic. Settings live in the browser's localStorage (no database).
const SETTINGS_KEY = 'tuktuk_settings_v1';

// Fare figures of one vehicle type. Built-in last resort only: config.json gives each type its own
// defaults, the online rates file overrides them and Admin can change them on this phone.
const RATE_DEFAULTS = {
  minimumFare: 150,     // lowest fare for a trip's distance (Rs.)
  expensePerKm: 33.85,  // what one km costs to run (fuel, service, tyres...), no profit (Rs.)
  oneWayProfitPct: 50,  // profit on a one way trip and an empty return (%)
  roundTripProfitPct: 15, // profit on a round trip (%)
  roundUpKm: false,     // true = charge partial km as a full km
  fareRoundMode: 'down', // total rounded 'down' | 'up' | 'nearest'...
  fareRoundTo: 10,      // ...to this many Rs.
  waitingEnabled: true, // charge for waiting time
  waitingPerHour: 300,  // waiting charge per hour
  waitingGraceMins: 0,  // first minutes of waiting are free...
  waitingStepMins: 1    // ...the rest is charged in blocks of this many minutes
};

const DEFAULT_SETTINGS = {
  enabledVehicles: null,       // vehicle types offered on the fare page (ticked in Admin); null = all of config.json
  selectedVehicle: 'tuktuk',   // vehicle type last chosen on the fare page
  currency: 'Rs.',
  mapProvider: 'osm',   // 'osm' = OpenStreetMap (free) | 'google' = Google Maps (needs API key)
  googleApiKey: '',     // Google Maps API key (Maps JavaScript API + Places API (New) + Routes API)
  adminPin: '1234',
  driverName: '',       // shown on PDF receipts
  localOverrides: {},   // figures changed in Admin on this phone, per vehicle type; they win over the API,
                        // e.g. { car: { expensePerKm: 48, oneWayProfitPct: 40 } }. Unchanged figures follow the API.
  vehicleNumbers: {},   // number plate per vehicle type, shown on that type's receipts, e.g. { tuktuk: 'WP ABC-1234' }
  driverPhone: ''
};

// Settings saved by older versions used "1st km / next km" names: carry them over
const OLD_NAMES = { firstKmRate: 'minimumFare' };
// Figures of older versions that are no longer used: per km prices (now expenses per km + profit margins),
// the cost per km price, return empty prices and the fuel adjustment
const REMOVED_FIELDS = ['perKmRate', 'nextKmRate', 'perKmCalculated', 'useCalculated', 'perKmOverride', 'perKmOverrides',
  'returnPerKm', 'returnCalculated', 'fuelEnabled', 'fuelPrice', 'baseFuelPrice', 'fuelStep', 'fuelStepChange', 'fuelMinPerKm', 'fuelMaxPerKm',
  'kmPerLiter', 'fuelMinNextKm', 'fuelMaxNextKm'];

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    Object.entries(OLD_NAMES).forEach(([oldName, newName]) => {
      if (saved[oldName] !== undefined && saved[newName] === undefined) saved[newName] = saved[oldName];
      delete saved[oldName];
    });
    // Older versions had one vehicle number for the phone: it becomes the tuktuk's
    if (saved.vehicleNo && !saved.vehicleNumbers) saved.vehicleNumbers = { tuktuk: saved.vehicleNo };
    delete saved.vehicleNo;
    // Forget figures that are no longer used, top level and changed on this phone
    REMOVED_FIELDS.forEach((f) => delete saved[f]);
    Object.entries(saved.localOverrides || {}).forEach(([k, o]) => {
      REMOVED_FIELDS.forEach((f) => delete o[f]);
      if (!Object.keys(o).length) delete saved.localOverrides[k];
    });
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
//   "fare":    { "minimumFare": 150, "expensePerKm": 33.85, "roundUpKm": false, "roundMode": "down", "roundTo": 10 }
//   "waiting": { "enabled": true, "perHour": 300, "graceMins": 0, "stepMins": 1 }
// and the profit margins, the same for every vehicle type:  "profit": { "oneWayPct": 50, "roundTripPct": 15 }
// Online rates file: { "schemaVersion": 2, "updatedAt": "2026-10-15", "profit": { ... },
//                      "vehicles": { "tuktuk": { "active": true, ... } } }
//   "active": true is required, plus fare.minimumFare and fare.expensePerKm; otherwise that type uses this phone's rates.
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
  ['fare', 'expensePerKm', 'expensePerKm', numberOk((n) => n > 0)],
  ['fare', 'roundUpKm', 'roundUpKm', isBool],
  ['fare', 'roundMode', 'fareRoundMode', (v) => ['down', 'up', 'nearest'].includes(v)],
  ['fare', 'roundTo', 'fareRoundTo', numberOk((n) => n > 0)],
  ['waiting', 'enabled', 'waitingEnabled', isBool],
  ['waiting', 'perHour', 'waitingPerHour', numberOk((n) => n >= 0)],
  ['waiting', 'graceMins', 'waitingGraceMins', numberOk((n) => n >= 0)],
  ['waiting', 'stepMins', 'waitingStepMins', numberOk((n) => n >= 1)]
];

// Profit margins ("profit" block of config.json / the online file), for every vehicle type
const PROFIT_MAP = [['oneWayPct', 'oneWayProfitPct'], ['roundTripPct', 'roundTripProfitPct']];
function readProfit(block, limits = {}) {
  const rates = {};
  PROFIT_MAP.forEach(([field, setting]) => {
    let v = (block || {})[field];
    if (typeof v === 'string' && v.trim() !== '' && !isNaN(v)) v = Number(v);
    const range = limits[field];
    if (numberOk((n) => n >= 0)(v) && !(range && (v < range[0] || v > range[1]))) rates[setting] = v;
  });
  return rates;
}

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
  return rates;
}

// Settings overrides from a vehicle block of the online file, or null (not active / no valid prices -> phone's rates)
function parseOnlineBlock(block, limits) {
  if (block.active !== true) return null;
  const rates = readRateBlock(block, limits);
  return 'minimumFare' in rates && 'expensePerKm' in rates ? rates : null;
}

// Older online file: settings overrides from one set of UPPER_CASE fields (top level, or a vehicle block),
// or null when that set is stopped (IS_STOPPED not false) or has no valid prices.
function parseRateBlock(data) {
  const minFare = Number(data.MINIMUM_FARE);
  const perKm = Number(data.PER_KM);
  if (data.IS_STOPPED !== false) return null;                // stopped (or missing) -> use admin rates
  if (!(minFare >= 0) || !(perKm >= 0)) return null;         // missing / bad numbers -> use admin rates
  const rates = { minimumFare: minFare }; // its PER_KM is a price, not expenses: not used
  if (typeof data.ROUND_UP_KM === 'boolean') rates.roundUpKm = data.ROUND_UP_KM;

  // Copies API number fields into settings. Only valid numbers are taken; anything else keeps the admin value.
  const take = (map, isValid) => Object.entries(map).forEach(([key, setting]) => {
    const n = Number(data[key]);
    if (data[key] !== undefined && data[key] !== null && data[key] !== '' && isValid(n, key)) rates[setting] = n;
  });

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
    return { format: 2, main: null, vehicles, profit: readProfit(data.profit, (cfg.limits || {}).profit),
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '' };
  }
  const byName = Object.fromEntries(Object.entries(data).filter(([, b]) => isObject(b)).map(([n, b]) => [n.toUpperCase(), b]));
  Object.keys(cfg.vehicles).forEach((key) => {
    const block = byName[legacyBlockName(key)];
    if (block) vehicles[key] = parseRateBlock(block);
  });
  return { format: 1, main: parseRateBlock(data), vehicles, profit: {}, updatedAt: '' };
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
    return cachedRateSet(cfg) || { format: 0, main: null, vehicles: {}, profit: {}, updatedAt: '', reachable: false };
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

// Rate figures saved by older versions of the app: top-level fields for the main type, and "vehicleRates"
// for the others. They still win over config.json.
function legacyRates(admin, key, cfg) {
  if (key === cfg.defaultVehicle) {
    return Object.fromEntries(Object.keys(RATE_DEFAULTS).filter((f) => admin[f] !== undefined).map((f) => [f, admin[f]]));
  }
  const own = (admin.vehicleRates || {})[key] || {};
  return Object.fromEntries(Object.entries({
    minimumFare: own.minimumFare, waitingPerHour: own.waitingPerHour
  }).filter(([, v]) => v !== undefined));
}

// Fare settings for one vehicle type. Layers, last one wins:
//   built-in -> config.json -> figures saved by older versions -> online rates file (API) -> changed on this phone (Admin)
//   The profit margins come from the "profit" block (config.json, then the online file), for every vehicle type.
//   admin   = this phone's settings (loadSettings())
//   rateSet = fetchOnlineRateSet() result
function vehicleSettings(admin, key, cfg, rateSet) {
  const configRates = { ...readRateBlock(cfg.vehicles[key] || {}), ...readProfit(cfg.profit) };
  const online = { ...((rateSet && rateSet.profit) || {}), ...(onlineBlock(key, cfg, rateSet) || {}) };
  const vehicleNo = (admin.vehicleNumbers || {})[key] || ''; // this type's number plate (receipts)
  const local = (admin.localOverrides || {})[key] || {};     // changed on this phone
  return { ...admin, ...RATE_DEFAULTS, ...configRates, ...legacyRates(admin, key, cfg), ...online, ...local, vehicleNo };
}

// ---------- Trip types ----------
// E = expenses per km. The km is always the one-way distance (A -> B).
//   one way       E × (1 + one way profit)            the passenger pays one way
//   empty return  E × 2 + E × one way profit          one way, the driver comes back empty (profit on one way only)
//   round trip    E × 2 × (1 + round trip profit)     there and back with the passenger
const TRIP_TYPES = {
  oneway: { name: 'One way', info: 'The passenger pays one way.' },
  empty: { name: 'Empty return', info: 'One way, and the driver comes back empty.' },
  round: { name: 'Round trip', info: 'There and back, with the passenger.' }
};
const tripTypeOk = (t) => (TRIP_TYPES[t] ? t : 'oneway');

// Price per km for a trip type, to 2 decimals
function tripPerKm(s, type = 'oneway') {
  const e = Number(s.expensePerKm) || 0;
  const one = (Number(s.oneWayProfitPct) || 0) / 100, round = (Number(s.roundTripProfitPct) || 0) / 100;
  const price = type === 'empty' ? e * 2 + e * one : type === 'round' ? e * 2 * (1 + round) : e * (1 + one);
  return Math.round(price * 100 + 1e-6) / 100; // + 1e-6: 50.775 is stored as 50.77499999… -> still 50.78
}
const tripPrices = (s) => Object.fromEntries(Object.keys(TRIP_TYPES).map((t) => [t, tripPerKm(s, t)]));

// ---------- Trip expenses (Admin "Cost per km" figures) ----------
const COST_STORE_KEY = 'tuktuk_cost_calc_v2'; // figures saved in the Cost per km tab, per vehicle type

// What one km costs to run (no profit): [label, Rs per km, note] for each part
function tripExpenseParts(x) {
  const n = (v) => Number(v) || 0;
  const div = (a, b) => (n(b) > 0 ? n(a) / n(b) : 0); // 0 instead of an error when dividing by 0
  const parts = [
    ['Fuel cost per km', div(x.fuelPrice, x.kmPerLitre), 'Fuel price ÷ km per litre'],
    ['Servicing per km', div(x.serviceCost, x.serviceKm), 'Service cost ÷ km between services'],
    ['Tyres per km', div(x.tyreCost, x.tyreKm), 'Tyre set ÷ km it lasts'],
    ['Repairs & wear per km', n(x.repairsPerKm), ''],
    ['Depreciation per km', n(x.depreciationPerKm), ''],
    ['Fixed costs per km', div(x.yearlyFixed, x.kmPerYear), 'Yearly fixed costs ÷ km per year']
  ];
  if (n(x.driverMonthly)) parts.push(['Driver income per km', div(n(x.driverMonthly) * 12, x.kmPerYear), 'Monthly target × 12 ÷ km per year']);
  return parts;
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
 * Distance fare = km × the trip type's price per km, but never less than the minimum fare.
 * Fare = distance fare + waiting charge (after free minutes, in blocks), then rounded (default down to 10).
 */
function calculateFare(distanceKm, s = loadSettings(), waitingMins = 0, tripType = 'oneway') {
  // Round to 2 decimals first so float errors (4.1 - 1.1 = 2.9999999999999996) can't change the fare
  const round2 = (n) => Math.round(n * 100) / 100;
  let km = round2(Math.max(0, Number(distanceKm) || 0));
  if (s.roundUpKm) km = Math.ceil(km);

  tripType = tripTypeOk(tripType);
  const perKmRate = tripPerKm(s, tripType);
  const minimumFare = Number(s.minimumFare);
  const waitRate = waitingRate(s);
  const waitMins = waitRate ? Math.max(0, Math.round(Number(waitingMins) || 0)) : 0;
  const billedMins = billedWaitingMins(waitMins, s);
  const waitingPart = round2((billedMins / 60) * waitRate);
  if (km === 0) {
    return { km, tripType, perKmRate, minimumFare, kmPart: 0, minimumApplied: false, distanceFare: 0, waitRate, waitMins: 0, billedMins: 0, waitingPart: 0, exact: 0, total: 0 };
  }

  const kmPart = round2(km * perKmRate);
  const minimumApplied = kmPart < minimumFare;
  const distanceFare = minimumApplied ? minimumFare : kmPart;
  const exact = round2(distanceFare + waitingPart);
  const total = roundFare(exact, s); // default DOWN to nearest 10 (e.g. 89 -> 80, 68.68 -> 60)
  return { km, tripType, perKmRate, minimumFare, kmPart, minimumApplied, distanceFare, waitRate, waitMins, billedMins, waitingPart, exact, total };
}

function formatMoney(amount, s = loadSettings()) {
  const n = Number(amount);
  const decimals = Number.isInteger(n) ? 0 : 2; // 100 -> "100", 192.4 -> "192.40"
  return `${s.currency} ${n.toLocaleString('en-LK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
