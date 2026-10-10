// Map providers. Both expose the same interface so app.js doesn't care which one is used:
//   init(el, onMapClick)            -> Promise
//   search(query)                   -> Promise<[{ label, lat, lng }]>
//   setMarker(which, pos, onDrag)   which = 'start' | 'end', pos = { lat, lng }
//   removeMarker(which)
//   route(a, b)                     -> Promise<{ km, mins, path: [{ lat, lng }] }>
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

    async search(query) {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5' +
                  '&countrycodes=lk&q=' + encodeURIComponent(query);
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) throw new Error('Search failed');
      const data = await res.json();
      return data.map((p) => ({ label: p.display_name, lat: +p.lat, lng: +p.lon }));
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

    async route(a, b) {
      const url = `https://router.project-osrm.org/route/v1/driving/` +
                  `${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes.length) {
        throw new Error(data.message || 'No road route found between these points.');
      }
      const r = data.routes[0];
      return {
        km: r.distance / 1000,
        mins: Math.round(r.duration / 60),
        path: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }))
      };
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

    async route(a, b) {
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
          routingPreference: 'TRAFFIC_UNAWARE'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Route request failed');
      if (!data.routes || !data.routes.length) throw new Error('No road route found between these points.');
      const r = data.routes[0];
      return {
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
