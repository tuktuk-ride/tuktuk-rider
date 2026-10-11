// Shared settings + fare logic. Settings live in the browser's localStorage (no database).
const SETTINGS_KEY = 'tuktuk_settings_v1';

const DEFAULT_SETTINGS = {
  firstKmRate: 100,     // price for the 1st km (Rs.)
  nextKmRate: 65,       // price for every km after the 1st (Rs.)
  roundUpKm: false,     // true = charge partial km as a full km
  currency: 'Rs.',
  mapProvider: 'osm',   // 'osm' = OpenStreetMap (free) | 'google' = Google Maps (needs API key)
  googleApiKey: '',     // Google Maps API key (Maps JavaScript API + Places API (New) + Routes API)
  adminPin: '1234',
  fuelEnabled: true,    // adjust the next km price by fuel price (API IS_FUEL_PRICE overrides this)
  // Fuel. Next km price moves by fuelStepChange for every fuelStep the fuel price
  // is above/below the band of baseFuelPrice. Bands are multiples of fuelStep (400-424, 425-449...).
  fuelPrice: 414,       // current fuel price per liter
  baseFuelPrice: 414,   // fuel price the km prices were set at
  fuelStep: 25,         // every Rs. 25 band...
  fuelStepChange: 5,    // ...changes the next km price by Rs. 5
  fuelMinNextKm: 50,    // fuel change never takes the next km price below this...
  fuelMaxNextKm: 100,   // ...or above this
  kmPerLiter: 28,       // info only: fuel cost per km
  driverName: '',       // shown on PDF receipts
  vehicleNo: '',
  driverPhone: ''
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
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
// { "1ST_KM": 100, "NEXT_KMS": 65, "ROUND_UP_KM": false, "IS_STOPPED": false,
//   "IS_FUEL_PRICE": true, "FUEL_PRICE": 414, "BASE_FUEL_PRICE": 414, "PER_LITER": 28,
//   "CHANGE_PRICE_PER": 25, "CHANGE_AMOUNT": 5, "MIN_CHANGE": 50, "MAX_CHANGE": 100 }
// IS_STOPPED false -> these values are used everywhere (matching admin fields are locked).
// IS_STOPPED true, or file unreachable -> each device's admin settings are used for everything.
// ROUND_UP_KM optional: overrides the admin "partial km as full km" tick; missing = admin tick.
// Fuel rule (BASE_FUEL_PRICE, CHANGE_PRICE_PER, CHANGE_AMOUNT, MIN_CHANGE, MAX_CHANGE): taken from the
//   API when present, otherwise admin values.
// IS_FUEL_PRICE true  = FUEL_PRICE / PER_LITER from the API (fuel adjustment on).
// IS_FUEL_PRICE false = fuel price, km per liter and the on/off tick from admin settings.
// Must be https: the app is served over https on GitHub Pages and browsers block http requests from it.
const RATES_URL = 'https://tuktukfee.theguru.asia/tuktuk.json';

// Resolves to settings overrides ({ firstKmRate, nextKmRate, ... }) when online rates are active, otherwise null.
async function fetchOnlineRates() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(RATES_URL, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const first = Number(data['1ST_KM']);
    const next = Number(data['NEXT_KMS']);
    if (data.IS_STOPPED !== false) return null;               // stopped (or missing) -> use admin rates
    if (!(first >= 0) || !(next >= 0)) return null;            // bad numbers -> use admin rates
    const rates = { firstKmRate: first, nextKmRate: next };
    if (typeof data.ROUND_UP_KM === 'boolean') rates.roundUpKm = data.ROUND_UP_KM;

    // Copies API number fields into settings. Only valid numbers are taken; anything else keeps the admin value.
    const take = (map, isValid) => Object.entries(map).forEach(([key, setting]) => {
      const n = Number(data[key]);
      if (data[key] !== undefined && data[key] !== null && data[key] !== '' && isValid(n, key)) rates[setting] = n;
    });

    // Fuel rule
    take({
      BASE_FUEL_PRICE: 'baseFuelPrice', CHANGE_PRICE_PER: 'fuelStep', CHANGE_AMOUNT: 'fuelStepChange',
      MIN_CHANGE: 'fuelMinNextKm', MAX_CHANGE: 'fuelMaxNextKm'
    }, (n, key) => (key === 'CHANGE_AMOUNT' ? n >= 0 : n > 0));

    // Fuel price: from the API only when IS_FUEL_PRICE is true, otherwise admin settings
    if (data.IS_FUEL_PRICE === true) {
      take({ FUEL_PRICE: 'fuelPrice', PER_LITER: 'kmPerLiter' }, (n) => n > 0);
      rates.fuelEnabled = rates.fuelPrice > 0; // no usable API fuel price -> no fuel adjustment (never guess)
    }
    return rates;
  } catch (e) {
    return null;                                               // offline / blocked / timeout
  } finally {
    clearTimeout(timer);
  }
}

// Rs. added to (or taken off) the next km price because of the fuel price.
// e.g. base 414, step 25, change 5: 425-449 -> +5, 450-474 -> +10, 375-399 -> -5, below 375 -> -10
function fuelAdjustment(s) {
  if (!s.fuelEnabled) return 0;
  const step = Number(s.fuelStep), change = Number(s.fuelStepChange);
  const fuel = Number(s.fuelPrice), base = Number(s.baseFuelPrice);
  if (!(step > 0) || !(fuel > 0) || !(base > 0) || isNaN(change)) return 0;
  return (Math.floor(fuel / step) - Math.floor(base / step)) * change;
}

// Next km price actually charged = base next km price (API or admin) + fuel adjustment,
// kept within min..max. If the base price itself is outside min..max, no fuel adjustment is applied.
function effectiveNextKmRate(s) {
  const base = Number(s.nextKmRate);
  const min = Number(s.fuelMinNextKm), max = Number(s.fuelMaxNextKm);
  if (!s.fuelEnabled || base < min || base > max) return base;
  return Math.min(max, Math.max(min, base + fuelAdjustment(s)));
}

/**
 * Fare = first km price + (remaining km × next km price incl. fuel adjustment).
 * Any trip up to 1 km is charged the first km price (minimum fare).
 */
function calculateFare(distanceKm, s = loadSettings()) {
  // Round to 2 decimals first so float errors (4.1 - 1.1 = 2.9999999999999996) can't change the fare
  const round2 = (n) => Math.round(n * 100) / 100;
  let km = round2(Math.max(0, Number(distanceKm) || 0));
  if (s.roundUpKm) km = Math.ceil(km);

  const nextRate = effectiveNextKmRate(s);
  if (km === 0) return { km, nextRate, firstPart: 0, nextKm: 0, nextPart: 0, exact: 0, total: 0 };

  const nextKm = round2(Math.max(0, km - 1));
  const firstPart = Number(s.firstKmRate);
  const nextPart = round2(nextKm * nextRate);
  const exact = round2(firstPart + nextPart);
  const total = Math.floor(exact / 10) * 10; // round DOWN to nearest 10 (e.g. 89 -> 80, 68.68 -> 60)
  return { km, nextRate, firstPart, nextKm, nextPart, exact, total };
}

function formatMoney(amount, s = loadSettings()) {
  const n = Number(amount);
  const decimals = Number.isInteger(n) ? 0 : 2; // 100 -> "100", 192.4 -> "192.40"
  return `${s.currency} ${n.toLocaleString('en-LK', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
