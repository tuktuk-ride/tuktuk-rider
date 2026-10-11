// Map providers. Both expose the same interface so app.js doesn't care which one is used:
//   init(el, onMapClick)            -> Promise
//   search(query)                   -> Promise<[{ label, lat, lng }]>
//   setMarker(which, pos, onDrag)   which = 'start' | 'end', pos = { lat, lng }
//   removeMarker(which)
//   route(a, b, { avoidExpressways }) -> Promise<{ km, mins, path: [{ lat, lng }], expressway, fallback }>
//                                    shortest legal route; avoidExpressways for 3-wheelers / motorbikes
//   reverse(pos) (optional)         -> Promise<address string | null>
//   drawRoute(path) / clearRoute()
//   fit(points) / focus(pos, zoom)

const DEFAULT_CENTER = { lat: 6.9271, lng: 79.8612 }; // Colombo

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

// ---------- Free routing ----------
// Valhalla (OpenStreetMap community server): shortest route, and it can leave out expressways,
// which three-wheelers and motorbikes may not use in Sri Lanka. OSRM is the fallback if it can't be reached.
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving/';

// Valhalla route lines are encoded polylines with 6 decimal places
function decodePolyline6(str) {
  const path = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const axis of ['lat', 'lng']) {
      let shift = 0, result = 0, byte;
      do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 'lat') lat += delta; else lng += delta;
    }
    path.push({ lat: lat / 1e6, lng: lng / 1e6 });
  }
  return path;
}

async function valhallaRoute(a, b, { avoidExpressways = false } = {}) {
  const request = {
    locations: [{ lat: a.lat, lon: a.lng }, { lat: b.lat, lon: b.lng }],
    costing: 'auto',
    costing_options: { auto: { shortest: true, exclude_highways: !!avoidExpressways } },
    units: 'kilometers',
    directions_type: 'maneuvers' // tells which parts are on the expressway
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(request))}`, { signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (data && data.trip) {
      const t = data.trip;
      const expresswayKm = (t.legs[0].maneuvers || []).filter((m) => m.highway).reduce((sum, m) => sum + (m.length || 0), 0);
      return {
        km: t.summary.length, mins: Math.round(t.summary.time / 60), path: decodePolyline6(t.legs[0].shape),
        expressway: !!t.summary.has_highway, expresswayKm: Math.round(expresswayKm * 10) / 10
      };
    }
    const err = new Error(data && data.error_code ? 'no road route found between these points.' : 'route service unavailable');
    err.noRoute = !!(data && data.error_code); // the service answered: there is no such route
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function osrmRoute(a, b) {
  const res = await fetch(`${OSRM_URL}${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`);
  if (!res.ok) throw new Error('the free route service is busy. Please try again in a moment.');
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error(data.message || 'No road route found between these points.');
  const r = data.routes[0];
  return {
    km: r.distance / 1000,
    mins: Math.round(r.duration / 60),
    path: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
    expressway: null, // unknown
    fallback: true
  };
}

// ======================= OpenStreetMap (free, no key) =======================
// Map: Leaflet + OSM tiles. Search: Nominatim. Road distance: OSRM public server.
function createOsmProvider() {
  let map, routeLayer;
  const markers = {};

  const pinIcon = (text) => L.divIcon({
    className: 'pin',
    html: `<span><b>${text}</b></span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30]
  });

  return {
    name: 'OpenStreetMap',

    async init(el, onMapClick) {
      loadCss('https://unpkg.com/leaflet@1.9.4/dist/leaflet.css');
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
      map = L.map(el).setView([DEFAULT_CENTER.lat, DEFAULT_CENTER.lng], 13);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap contributors'
      }).addTo(map);
      map.on('click', (e) => onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng }));
    },

    async reverse(pos) {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${pos.lat}&lon=${pos.lng}`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) return null;
      const data = await res.json();
      return data.display_name || null;
    },

    async search(query) {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8' +
                  '&countrycodes=lk&q=' + encodeURIComponent(query);
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      // A district or province (e.g. "Galle District") is a whole area: the map can only show its middle,
      // which gives a wrong distance. Leave such areas out when a real town / place matches.
      const places = data.map((p) => ({ label: p.display_name, lat: +p.lat, lng: +p.lon, area: Number(p.place_rank) < 16 }));
      const real = places.filter((p) => !p.area);
      return (real.length ? real : places.map((p) => ({ ...p, label: p.label + ' (whole area — pick a town or place for an accurate fare)' })))
        .slice(0, 5);
    },

    setMarker(which, pos, onDrag) {
      this.removeMarker(which);
      markers[which] = L.marker([pos.lat, pos.lng], {
        icon: pinIcon(which === 'start' ? 'A' : 'B'),
        draggable: true
      }).addTo(map);
      markers[which].on('dragend', (e) => {
        const p = e.target.getLatLng();
        onDrag({ lat: p.lat, lng: p.lng });
      });
    },

    removeMarker(which) {
      if (markers[which]) map.removeLayer(markers[which]);
      markers[which] = null;
    },

    async route(a, b, opts = {}) {
      try {
        return await valhallaRoute(a, b, opts);
      } catch (e) {
        if (e.noRoute) throw e;
        return osrmRoute(a, b); // Valhalla unreachable: fastest car route (may use an expressway)
      }
    },

    drawRoute(path) {
      this.clearRoute();
      routeLayer = L.polyline(path.map((p) => [p.lat, p.lng]), { color: '#1a73e8', weight: 5 }).addTo(map);
    },

    clearRoute() {
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = null;
    },

    fit(points) {
      map.fitBounds(points.map((p) => [p.lat, p.lng]), { padding: [40, 40] });
    },

    focus(pos, zoom = 15) {
      map.setView([pos.lat, pos.lng], zoom);
    },

    resize() {
      map.invalidateSize();
    }
  };
}

// ======================= Google Maps (needs API key) =======================
// Needs: Maps JavaScript API, Places API (New), Routes API enabled for the key.
function createGoogleProvider(apiKey) {
  let map, routeLine;
  const markers = {};

  return {
    name: 'Google Maps',

    init(el, onMapClick) {
      return new Promise((resolve, reject) => {
        window.gm_authFailure = () => {
          document.getElementById('mapError').textContent =
            'Google rejected the API key. Check the key and enabled APIs in Admin.';
          reject(new Error('Google rejected the API key.'));
        };
        window.__initGoogleMap = () => {
          map = new google.maps.Map(el, {
            center: DEFAULT_CENTER,
            zoom: 13,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false,
            gestureHandling: 'greedy'
          });
          map.addListener('click', (e) => onMapClick({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
          resolve();
        };
        loadScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
                   `&v=weekly&loading=async&libraries=geometry&callback=__initGoogleMap`)
          .catch(reject);
      });
    },

    async search(query) {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
        },
        body: JSON.stringify({ textQuery: query, regionCode: 'lk', maxResultCount: 5 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Search failed');
      return (data.places || []).map((p) => ({
        label: [p.displayName?.text, p.formattedAddress].filter(Boolean).join(' — '),
        lat: p.location.latitude,
        lng: p.location.longitude
      }));
    },

    setMarker(which, pos, onDrag) {
      this.removeMarker(which);
      markers[which] = new google.maps.Marker({
        position: pos,
        map,
        label: which === 'start' ? 'A' : 'B',
        draggable: true
      });
      markers[which].addListener('dragend', (e) => onDrag({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
    },

    removeMarker(which) {
      if (markers[which]) markers[which].setMap(null);
      markers[which] = null;
    },

    async route(a, b, opts = {}) {
      const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline'
        },
        body: JSON.stringify({
          origin: { location: { latLng: { latitude: a.lat, longitude: a.lng } } },
          destination: { location: { latLng: { latitude: b.lat, longitude: b.lng } } },
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
          computeAlternativeRoutes: true,
          routeModifiers: { avoidHighways: !!opts.avoidExpressways }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Route request failed');
      if (!data.routes || !data.routes.length) throw new Error('No road route found between these points.');
      const r = data.routes.reduce((best, x) => (x.distanceMeters < best.distanceMeters ? x : best)); // shortest
      return {
        expressway: opts.avoidExpressways ? false : null,
        km: r.distanceMeters / 1000,
        mins: Math.round(parseInt(r.duration, 10) / 60),
        path: google.maps.geometry.encoding.decodePath(r.polyline.encodedPolyline)
          .map((p) => ({ lat: p.lat(), lng: p.lng() }))
      };
    },

    drawRoute(path) {
      this.clearRoute();
      routeLine = new google.maps.Polyline({ path, strokeColor: '#1a73e8', strokeWeight: 5, map });
    },

    clearRoute() {
      if (routeLine) routeLine.setMap(null);
      routeLine = null;
    },

    fit(points) {
      const b = new google.maps.LatLngBounds();
      points.forEach((p) => b.extend(p));
      map.fitBounds(b, 60);
    },

    focus(pos, zoom = 15) {
      map.panTo(pos);
      map.setZoom(zoom);
    }
  };
}
