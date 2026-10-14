// Map providers. Both expose the same interface so app.js doesn't care which one is used:
//   init(el, onMapClick)            -> Promise
//   search(query)                   -> Promise<[{ label, lat, lng }]>
//   setMarker(which, pos, onDrag)   which = 'start' | 'end', pos = { lat, lng }
//   removeMarker(which)
//   route(a, b, { avoidExpressways, prefer }, via) -> Promise<{ km, mins, path, expressway, expresswayParts, fallback, options }>
//                                    the suggested route + options: every route found (up to 3, suggested first)
//                                    prefer 'shortest' (tuk-tuks, bikes) | 'main' (cars: the router's normal best route)
//                                    avoidExpressways for 3-wheelers / motorbikes
//                                    via { lat, lng }: one route that passes there (the rider's own road)
//   drawRoutes(routes, selected, { onPick, onLineTap })  routes [{ path, color, expresswayParts }]: the selected one
//                                    on top; tap another to pick it, tap / press the selected one for a ✚ pin
//   setVia(pos, onMoved, startEvent) / removeVia()        the draggable ✚ pin of the rider's own road
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

// One Valhalla trip (all legs joined) -> route. expresswayParts: the stretches on the expressway
function valhallaTrip(t) {
  const path = [], parts = [];
  let expresswayKm = 0;
  t.legs.forEach((leg) => {
    const pts = decodePolyline6(leg.shape);
    const offset = path.length ? path.length - 1 : 0; // legs share their joining point
    path.push(...(path.length ? pts.slice(1) : pts));
    (leg.maneuvers || []).filter((m) => m.highway).forEach((m) => {
      expresswayKm += m.length || 0;
      parts.push(path.slice(offset + m.begin_shape_index, offset + m.end_shape_index + 1));
    });
  });
  return {
    km: t.summary.length, mins: Math.round(t.summary.time / 60), path,
    expressway: !!t.summary.has_highway, expresswayKm: Math.round(expresswayKm * 10) / 10, expresswayParts: parts
  };
}

// Every route Valhalla found, suggested one first (only one when it must pass a via point)
async function valhallaRoute(a, b, { avoidExpressways = false, prefer = 'shortest' } = {}, via = null) {
  const request = {
    locations: [{ lat: a.lat, lon: a.lng }, ...(via ? [{ lat: via.lat, lon: via.lng, type: 'through' }] : []), { lat: b.lat, lon: b.lng }],
    costing: 'auto',
    costing_options: { auto: { shortest: prefer !== 'main', exclude_highways: !!avoidExpressways } },
    alternates: via ? 0 : 2, // up to 2 other routes to choose from
    units: 'kilometers',
    directions_type: 'maneuvers' // tells which parts are on the expressway
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(request))}`, { signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    if (data && data.trip) return [data.trip, ...(data.alternates || []).map((x) => x.trip)].map(valhallaTrip);
    const err = new Error(data && data.error_code ? 'no road route found between these points.' : 'route service unavailable');
    err.noRoute = !!(data && data.error_code); // the service answered: there is no such route
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function osrmRoute(a, b, { prefer = 'shortest' } = {}, via = null) {
  const at = [a, ...(via ? [via] : []), b].map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetch(`${OSRM_URL}${at}?overview=full&geometries=geojson${via ? '' : '&alternatives=2'}`);
  if (!res.ok) throw new Error('the free route service is busy. Please try again in a moment.');
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes.length) throw new Error(data.message || 'No road route found between these points.');
  const routes = data.routes.map((r) => ({
    km: r.distance / 1000,
    mins: Math.round(r.duration / 60),
    path: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
    expressway: null, // unknown
    fallback: true
  }));
  return prefer === 'main' ? routes : routes.sort((x, y) => x.km - y.km);
}

// The suggested route (first), with every route found as its options
const withOptions = (routes) => ({ ...routes[0], options: routes });
const EXPRESSWAY_COLOR = '#d50000'; // expressway stretches of a route, drawn over its own colour

// ======================= OpenStreetMap (free, no key) =======================
// Map: Leaflet + OSM tiles. Search: Nominatim. Road distance: OSRM public server.
function createOsmProvider() {
  let map, routeLayer, viaMarker;
  let ignoreClickUntil = 0; // the click a browser sends at the end of a ✚ pin drag is not a new A/B pin
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
      map.on('click', (e) => { if (Date.now() >= ignoreClickUntil) onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng }); });
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

    async route(a, b, opts = {}, via = null) {
      try {
        return withOptions(await valhallaRoute(a, b, opts, via));
      } catch (e) {
        if (e.noRoute) throw e;
        return withOptions(await osrmRoute(a, b, opts, via)); // Valhalla unreachable: car routes (may use an expressway)
      }
    },

    drawRoute(path) {
      this.drawRoutes([{ path, color: '#1a73e8' }], 0);
    },

    drawRoutes(routes, selected, { onPick, onLineTap } = {}) {
      this.clearRoute();
      const layers = [];
      const ll = (p) => p.map((x) => [x.lat, x.lng]);
      // the others first, so the selected route is drawn on top
      routes.map((r, i) => i).filter((i) => i !== selected).concat(selected).forEach((i) => {
        const r = routes[i], on = i === selected;
        const style = { weight: on ? 7 : 5, opacity: on ? 1 : 0.7, bubblingMouseEvents: false }; // a tap on a route is not a new A/B pin
        if (on) layers.push(L.polyline(ll(r.path), { color: '#fff', weight: 11, opacity: 0.9, interactive: false })); // white edge
        const lines = [L.polyline(ll(r.path), { ...style, color: r.color })]
          .concat((r.expresswayParts || []).map((p) => L.polyline(ll(p), { ...style, color: EXPRESSWAY_COLOR })));
        lines.forEach((pl) => {
          if (!on && onPick) pl.on('click', () => onPick(i));
          // press (and drag) / tap on the selected route: a ✚ pin there, for the rider's own road
          if (on && onLineTap) pl.on('mousedown', (e) => onLineTap({ lat: e.latlng.lat, lng: e.latlng.lng }, e.originalEvent));
        });
        layers.push(...lines);
      });
      routeLayer = L.layerGroup(layers).addTo(map);
    },

    clearRoute() {
      if (routeLayer) map.removeLayer(routeLayer);
      routeLayer = null;
    },

    // ✚ pin of the rider's own road. startEvent: the press on the route, so the pin follows the same drag
    setVia(pos, onMoved, startEvent) {
      this.removeVia();
      viaMarker = L.marker([pos.lat, pos.lng], { icon: pinIcon('✚'), draggable: true, zIndexOffset: 1000 }).addTo(map);
      viaMarker.on('dragstart', () => (ignoreClickUntil = Infinity));
      viaMarker.on('dragend', () => {
        ignoreClickUntil = Date.now() + 500;
        map.dragging.enable();
        const p = viaMarker.getLatLng();
        onMoved({ lat: p.lat, lng: p.lng });
      });
      if (startEvent && startEvent.type === 'mousedown') {
        map.dragging.disable(); // the press moves the pin, not the map
        const restore = () => {
          map.dragging.enable();
          ignoreClickUntil = Date.now() + 500; // tap or drag: the click that follows is not a new A/B pin
          document.removeEventListener('mouseup', restore);
        };
        document.addEventListener('mouseup', restore);
        try { viaMarker.dragging._draggable._onDown(startEvent); } catch (e) { /* tap only: the pin can still be dragged */ }
      }
    },

    removeVia() {
      if (viaMarker) map.removeLayer(viaMarker);
      viaMarker = null;
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
  let map, routeLine, viaMarker;
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

    async route(a, b, opts = {}, via = null) {
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
          ...(via ? { intermediates: [{ via: true, location: { latLng: { latitude: via.lat, longitude: via.lng } } }] } : {}),
          travelMode: 'DRIVE',
          routingPreference: 'TRAFFIC_UNAWARE',
          computeAlternativeRoutes: !via, // up to 3 routes to choose from
          routeModifiers: { avoidHighways: !!opts.avoidExpressways }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Route request failed');
      if (!data.routes || !data.routes.length) throw new Error('No road route found between these points.');
      const routes = data.routes.map((r) => ({
        expressway: opts.avoidExpressways ? false : null,
        km: r.distanceMeters / 1000,
        mins: Math.round(parseInt(r.duration, 10) / 60),
        path: google.maps.geometry.encoding.decodePath(r.polyline.encodedPolyline)
          .map((p) => ({ lat: p.lat(), lng: p.lng() }))
      }));
      // Google lists its best route first ("main"); shortest first for tuk-tuks / bikes
      return withOptions(opts.prefer === 'main' ? routes : routes.sort((x, y) => x.km - y.km));
    },

    drawRoute(path) {
      this.drawRoutes([{ path, color: '#1a73e8' }], 0);
    },

    drawRoutes(routes, selected, { onPick, onLineTap } = {}) {
      this.clearRoute();
      routeLine = [];
      routes.map((r, i) => i).filter((i) => i !== selected).concat(selected).forEach((i) => { // selected on top
        const r = routes[i], on = i === selected;
        const line = (p, color) => {
          const pl = new google.maps.Polyline({
            path: p, map, clickable: !!(on ? onLineTap : onPick), zIndex: on ? 3 : 1,
            strokeColor: color, strokeWeight: on ? 7 : 5, strokeOpacity: on ? 1 : 0.7
          });
          if (!on && onPick) pl.addListener('click', () => onPick(i));
          if (on && onLineTap) pl.addListener('click', (e) => onLineTap({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
          routeLine.push(pl);
        };
        line(r.path, r.color);
        (r.expresswayParts || []).forEach((p) => line(p, EXPRESSWAY_COLOR));
      });
    },

    clearRoute() {
      (routeLine || []).forEach((l) => l.setMap(null));
      routeLine = null;
    },

    setVia(pos, onMoved) {
      this.removeVia();
      viaMarker = new google.maps.Marker({ position: pos, map, label: '✚', draggable: true, zIndex: 1000 });
      viaMarker.addListener('dragend', (e) => onMoved({ lat: e.latLng.lat(), lng: e.latLng.lng() }));
    },

    removeVia() {
      if (viaMarker) viaMarker.setMap(null);
      viaMarker = null;
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
