import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface OsrmStep {
  distance: number;
  name: string;
  maneuver: { type: string; modifier?: string; location: [number, number] };
}

interface Suggestion {
  lat: string;
  lon: string;
  display_name: string;
}

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: { amenity?: string; name?: string };
}

interface Step {
  icon: string;
  instruction: string;
  distance: string;
}

interface RouteInfo {
  distance: string;
  duration: number;
  steps: Step[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Plain Unicode arrows — no emoji variation selectors
const maneuverIcon = (type: string, modifier?: string): string => {
  if (type === "depart")  return "↑";
  if (type === "arrive")  return "●";
  if (type === "roundabout" || type === "rotary") return "↻";
  switch (modifier) {
    case "uturn":        return "↩";
    case "sharp left":   return "↰";
    case "left":         return "←";
    case "slight left":  return "↖";
    case "slight right": return "↗";
    case "right":        return "→";
    case "sharp right":  return "↱";
    default:             return "↑";
  }
};

const stepInstruction = (step: OsrmStep): string => {
  const { type, modifier } = step.maneuver;
  const on = step.name ? ` on ${step.name}` : "";
  if (type === "depart")   return `Start walking${on}`;
  if (type === "arrive")   return "You have arrived";
  if (type === "new name" || type === "notification") return `Continue${on}`;
  if (type === "continue") return `Continue straight${on}`;
  if (type === "merge")    return `Merge${on}`;
  if (type === "fork")     return modifier?.includes("right") ? `Keep right${on}` : `Keep left${on}`;
  if (type === "end of road") return modifier?.includes("right") ? `Turn right${on}` : `Turn left${on}`;
  if (type === "turn") {
    const labels: Record<string, string> = {
      "sharp left": "Turn sharply left", left: "Turn left",
      "slight left": "Keep slightly left", straight: "Go straight",
      "slight right": "Keep slightly right", right: "Turn right",
      "sharp right": "Turn sharply right", uturn: "Make a U-turn",
    };
    return `${labels[modifier ?? ""] ?? "Turn"}${on}`;
  }
  return `Continue${on}`;
};

const fmtDist = (m: number) => {
  if (m < 50)   return `${Math.round(m)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
};

const haversine = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const createUserDot = () => {
  const wrap = document.createElement("div");
  wrap.className = "p-userdot";
  wrap.innerHTML = `<div class="p-pulse"></div><div class="p-dot"></div>`;
  return wrap;
};

const createPinMarker = () => {
  const el = document.createElement("img");
  el.src = "/pin.svg";
  el.style.cssText = "width:36px;height:36px;cursor:pointer;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.3))";
  return el;
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function MapLibreTest() {
  const mapRef       = useRef<HTMLDivElement>(null);
  const mapInst      = useRef<maplibregl.Map | null>(null);
  const searchMarker = useRef<maplibregl.Marker | null>(null);
  const userMarker   = useRef<maplibregl.Marker | null>(null);
  const poiMarkers   = useRef<maplibregl.Marker[]>([]);
  const searchedLoc  = useRef<{ lat: number; lng: number } | null>(null);
  const userLoc      = useRef<{ lat: number; lng: number } | null>(null);
  const watchId      = useRef<number | null>(null);
  const osrmSteps    = useRef<OsrmStep[]>([]);
  const destination  = useRef<{ lat: number; lng: number } | null>(null);
  const stepIdxRef   = useRef(0);

  const ROUTE_SRC  = "route-line";
  const ROUTE_CASE = "route-casing";

  const [query, setQuery]             = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [routeInfo, setRouteInfo]     = useState<RouteInfo | null>(null);
  const [isNavigating, setIsNavigating] = useState(false);
  const [stepIndex, setStepIndex]     = useState(0);
  const [distToTurn, setDistToTurn]   = useState<number | null>(null);
  const [arrived, setArrived]         = useState(false);

  // Inject all component CSS once
  useEffect(() => {
    const s = document.createElement("style");
    s.textContent = `
      /* GPS dot */
      .p-userdot { position:relative; width:22px; height:22px; }
      .p-dot {
        width:22px; height:22px; border-radius:50%;
        background:#1a73e8; border:3px solid #fff;
        box-shadow:0 2px 8px rgba(0,0,0,0.35);
        position:relative; z-index:1;
      }
      .p-pulse {
        position:absolute; top:-11px; left:-11px;
        width:44px; height:44px; border-radius:50%;
        background:rgba(26,115,232,0.2);
        animation:p-gps 2s ease-out infinite;
      }
      @keyframes p-gps {
        0%   { transform:scale(.4); opacity:1; }
        100% { transform:scale(2);  opacity:0; }
      }

      /* Search + buttons container */
      .p-controls {
        position:absolute; top:12px;
        left:12px; right:12px;
        z-index:10;
        display:flex; flex-direction:column; gap:8px;
      }
      @media (min-width:520px) {
        .p-controls {
          left:50%; right:auto;
          transform:translateX(-50%);
          width:360px;
        }
      }

      /* Search input */
      .p-input {
        width:100%; padding:12px 16px;
        border-radius:24px; border:none;
        box-shadow:0 2px 10px rgba(0,0,0,0.18);
        font-size:16px; /* 16px prevents iOS zoom */
        box-sizing:border-box;
        outline:none;
        font-family:inherit;
      }

      /* Suggestion list */
      .p-suggestions {
        background:#fff; border-radius:14px; margin-top:2px;
        max-height:200px; overflow-y:auto;
        box-shadow:0 4px 12px rgba(0,0,0,0.15);
      }
      .p-suggestion-item {
        padding:11px 16px; cursor:pointer; font-size:14px;
        border-bottom:1px solid #f0f0f0; line-height:1.4;
        -webkit-tap-highlight-color:transparent;
      }
      .p-suggestion-item:last-child { border-bottom:none; }
      .p-suggestion-item:active { background:#f5f5f5; }

      /* Action buttons row */
      .p-btns {
        display:flex; gap:8px;
      }
      .p-btn {
        flex:1; padding:12px 10px;
        border-radius:24px; border:none;
        background:#1a1a1a; color:#fff;
        cursor:pointer; font-size:14px; font-weight:600;
        box-shadow:0 2px 8px rgba(0,0,0,0.2);
        min-height:44px; /* touch target */
        font-family:inherit;
        -webkit-tap-highlight-color:transparent;
      }
      .p-btn:active { background:#333; }

      /* Navigation top banner */
      .p-nav-banner {
        position:absolute; top:0; left:0; right:0; z-index:30;
        background:#1a73e8; color:#fff;
        padding:env(safe-area-inset-top, 0) 0 0;
        box-shadow:0 4px 16px rgba(0,0,0,0.25);
      }
      .p-nav-inner {
        padding:14px 16px;
        display:flex; align-items:center; gap:12px;
      }

      /* Direction icon badge */
      .p-dir-icon {
        width:40px; height:40px; border-radius:10px;
        background:rgba(255,255,255,0.2);
        display:flex; align-items:center; justify-content:center;
        font-size:20px; font-weight:700; flex-shrink:0; color:#fff;
        line-height:1;
      }
      .p-dir-icon-sm {
        width:34px; height:34px; border-radius:8px; flex-shrink:0;
        display:flex; align-items:center; justify-content:center;
        font-size:17px; font-weight:700; line-height:1;
      }

      /* End nav button */
      .p-end-btn {
        background:rgba(255,255,255,0.2); border:none; border-radius:10px;
        color:#fff; padding:8px 14px; cursor:pointer;
        font-size:13px; font-weight:600; white-space:nowrap;
        min-height:44px; font-family:inherit;
        -webkit-tap-highlight-color:transparent;
      }
      .p-end-btn:active { background:rgba(255,255,255,0.35); }

      /* Directions bottom sheet */
      .p-sheet {
        position:absolute; bottom:0; left:0; right:0; z-index:20;
        background:#fff; border-radius:20px 20px 0 0;
        box-shadow:0 -4px 24px rgba(0,0,0,0.12);
        max-height:52vh; display:flex; flex-direction:column;
        padding-bottom:env(safe-area-inset-bottom, 0);
      }
      .p-sheet-header {
        padding:16px 16px 12px;
        border-bottom:1px solid #f0f0f0;
        display:flex; align-items:center; justify-content:space-between;
        flex-shrink:0; gap:10px;
      }
      .p-start-btn {
        background:#1a73e8; color:#fff; border:none;
        border-radius:22px; padding:10px 18px;
        cursor:pointer; font-weight:700; font-size:14px;
        min-height:44px; white-space:nowrap; font-family:inherit;
        -webkit-tap-highlight-color:transparent;
      }
      .p-start-btn:active { background:#1558b0; }
      .p-close-btn {
        background:#f0f0f0; border:none; border-radius:50%;
        width:36px; height:36px; cursor:pointer; font-size:15px;
        display:flex; align-items:center; justify-content:center;
        flex-shrink:0; font-family:inherit;
        -webkit-tap-highlight-color:transparent;
      }
      .p-close-btn:active { background:#e0e0e0; }
      .p-sheet-steps { overflow-y:auto; padding:4px 0; }
      .p-step {
        display:flex; align-items:flex-start; gap:12px;
        padding:11px 16px;
        border-bottom:1px solid #f8f8f8;
        border-left:3px solid transparent;
      }
      .p-step:last-child { border-bottom:none; }
      .p-step.active {
        background:#e8f0fe;
        border-left-color:#1a73e8;
      }

      /* Arrived modal */
      .p-arrived-overlay {
        position:absolute; inset:0; z-index:50;
        background:rgba(0,0,0,0.4);
        display:flex; align-items:center; justify-content:center;
        padding:24px;
      }
      .p-arrived-card {
        background:#fff; border-radius:20px;
        padding:32px 28px; text-align:center;
        box-shadow:0 12px 48px rgba(0,0,0,0.25);
        width:100%; max-width:320px;
      }
      .p-done-btn {
        margin-top:20px; padding:12px 32px; border-radius:22px;
        border:none; background:#1a73e8; color:#fff;
        cursor:pointer; font-weight:700; font-size:16px;
        width:100%; font-family:inherit;
        -webkit-tap-highlight-color:transparent;
      }
      .p-done-btn:active { background:#1558b0; }
    `;
    document.head.appendChild(s);
    return () => s.remove();
  }, []);

  // Initialise map
  useEffect(() => {
    if (!mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapRef.current,
      center: [78.9629, 20.5937],
      zoom: 5,
      style: "https://tiles.openfreemap.org/styles/liberty",
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl());
    mapInst.current = map;
    return () => map.remove();
  }, []);

  // Cleanup watchPosition on unmount
  useEffect(() => () => { stopWatch(); }, []);

  // ── Helpers ───────────────────────────────────────────────────────────────

  const stopWatch = () => {
    if (watchId.current !== null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
  };

  const clearRoute = () => {
    const m = mapInst.current;
    if (m) {
      if (m.getLayer(ROUTE_SRC))  m.removeLayer(ROUTE_SRC);
      if (m.getLayer(ROUTE_CASE)) m.removeLayer(ROUTE_CASE);
      if (m.getSource(ROUTE_SRC)) m.removeSource(ROUTE_SRC);
    }
    stopWatch();
    osrmSteps.current   = [];
    destination.current = null;
    setRouteInfo(null);
    setIsNavigating(false);
    setArrived(false);
    setStepIndex(0);
    stepIdxRef.current = 0;
    setDistToTurn(null);
  };

  const placeUserMarker = (lng: number, lat: number) => {
    if (userMarker.current) {
      userMarker.current.setLngLat([lng, lat]);
    } else {
      userMarker.current = new maplibregl.Marker({ element: createUserDot(), anchor: "center" })
        .setLngLat([lng, lat])
        .addTo(mapInst.current!);
    }
  };

  // ── Routing ───────────────────────────────────────────────────────────────

  const getRoute = async (
    startLng: number, startLat: number,
    endLng: number,   endLat: number,
  ): Promise<RouteInfo | null> => {
    const res  = await fetch(
      `https://router.project-osrm.org/route/v1/walking/` +
      `${startLng},${startLat};${endLng},${endLat}` +
      `?overview=full&geometries=geojson&steps=true`
    );
    const data = await res.json();
    if (!data.routes?.length) { alert("Could not find a walking route."); return null; }

    const route = data.routes[0];
    const map   = mapInst.current!;

    if (map.getLayer(ROUTE_SRC))  map.removeLayer(ROUTE_SRC);
    if (map.getLayer(ROUTE_CASE)) map.removeLayer(ROUTE_CASE);
    if (map.getSource(ROUTE_SRC)) map.removeSource(ROUTE_SRC);

    map.addSource(ROUTE_SRC, {
      type: "geojson",
      data: { type: "Feature", geometry: route.geometry, properties: {} },
    });
    map.addLayer({ id: ROUTE_CASE, type: "line", source: ROUTE_SRC,
      paint: { "line-color": "#fff", "line-width": 11, "line-opacity": 0.85 } });
    map.addLayer({ id: ROUTE_SRC, type: "line", source: ROUTE_SRC,
      paint: { "line-color": "#1a73e8", "line-width": 6 } });

    const coords = route.geometry.coordinates as [number, number][];
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );
    map.fitBounds(bounds, { padding: 90 });

    const rawSteps: OsrmStep[] = route.legs[0]?.steps ?? [];
    osrmSteps.current   = rawSteps;
    destination.current = { lat: endLat, lng: endLng };

    const steps: Step[] = rawSteps.map((s) => ({
      icon:        maneuverIcon(s.maneuver.type, s.maneuver.modifier),
      instruction: stepInstruction(s),
      distance:    fmtDist(s.distance),
    }));

    const info: RouteInfo = {
      distance: fmtDist(route.distance),
      duration: Math.round(route.duration / 60),
      steps,
    };
    setRouteInfo(info);
    setStepIndex(0);
    stepIdxRef.current = 0;
    setArrived(false);
    return info;
  };

  // ── Navigation ────────────────────────────────────────────────────────────

  const startNavigation = () => {
    if (!navigator.geolocation) { alert("Geolocation not supported"); return; }
    if (!routeInfo) return;
    setIsNavigating(true);

    if (userMarker.current) { userMarker.current.remove(); userMarker.current = null; }

    navigator.geolocation.getCurrentPosition(({ coords }) => {
      placeUserMarker(coords.longitude, coords.latitude);
      mapInst.current?.flyTo({ center: [coords.longitude, coords.latitude], zoom: 17, speed: 1.5 });
    });

    watchId.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const lat = coords.latitude;
        const lng = coords.longitude;
        userLoc.current = { lat, lng };

        placeUserMarker(lng, lat);
        mapInst.current?.easeTo({ center: [lng, lat], zoom: 17, duration: 600 });

        const steps = osrmSteps.current;
        const idx   = stepIdxRef.current;

        const nextOsrm = steps[idx + 1];
        if (nextOsrm) {
          const [nLng, nLat] = nextOsrm.maneuver.location;
          const d = haversine(lat, lng, nLat, nLng);
          setDistToTurn(d);
          if (d < 15 && idx + 1 < steps.length - 1) {
            stepIdxRef.current = idx + 1;
            setStepIndex(idx + 1);
          }
        }

        const dest = destination.current;
        if (dest && haversine(lat, lng, dest.lat, dest.lng) < 20) {
          stopWatch();
          setIsNavigating(false);
          setArrived(true);
        }
      },
      () => alert("GPS access denied — enable location to navigate."),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
  };

  const endNavigation = () => { stopWatch(); setIsNavigating(false); };

  // ── Location & search ─────────────────────────────────────────────────────

  const getUserLocation = () => {
    if (!navigator.geolocation) { alert("Geolocation not supported"); return; }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const lat = coords.latitude;
        const lng = coords.longitude;
        userLoc.current = { lat, lng };
        placeUserMarker(lng, lat);
        mapInst.current?.flyTo({ center: [lng, lat], zoom: 15 });
      },
      () => alert("Location permission denied")
    );
  };

  const fetchSuggestions = async (text: string) => {
    if (!text) { setSuggestions([]); return; }
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(text)}&limit=5`
    );
    setSuggestions(await res.json());
  };

  const selectLocation = (place: Suggestion) => {
    const lat = Number(place.lat);
    const lon = Number(place.lon);
    searchedLoc.current = { lat, lng: lon };
    setSuggestions([]);
    setQuery(place.display_name);
    searchMarker.current?.remove();
    searchMarker.current = new maplibregl.Marker({ element: createPinMarker(), anchor: "bottom" })
      .setLngLat([lon, lat])
      .setPopup(new maplibregl.Popup().setText("Destination"))
      .addTo(mapInst.current!);
    mapInst.current?.flyTo({ center: [lon, lat], zoom: 15 });
  };

  // ── POI search ────────────────────────────────────────────────────────────

  const findRestrooms = async () => {
    const source = userLoc.current || searchedLoc.current;
    if (!source) { alert("Search or use your location first"); return; }

    poiMarkers.current.forEach((m) => m.remove());
    poiMarkers.current = [];
    clearRoute();

    const { lat, lng } = source;
    const oq = `[out:json];(
      node["amenity"="toilets"](around:2500,${lat},${lng});
      node["shop"="mall"](around:2500,${lat},${lng});
      node["amenity"~"hospital|clinic"](around:2500,${lat},${lng});
      node["amenity"~"restaurant|cafe|fast_food"](around:2500,${lat},${lng});
      node["railway"="station"]["station"="subway"](around:2500,${lat},${lng});
    );out center;`;

    const res  = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: oq });
    const data = await res.json();

    (data.elements as OverpassElement[]).forEach((place) => {
      const plat = place.lat ?? place.center?.lat;
      const plng = place.lon ?? place.center?.lon;
      if (!plat || !plng) return;

      const isPublic = place.tags?.amenity === "toilets";
      const name     = place.tags?.name;

      const popup = new maplibregl.Popup({ maxWidth: "280px" }).setHTML(`
        <div style="font-family:system-ui,sans-serif;padding:4px 0">
          <strong style="font-size:14px">${name || (isPublic ? "Public Restroom" : "Nearby Location")}</strong><br/>
          <span style="font-size:12px;color:#666">${isPublic ? "Public Restroom" : "Restroom Likely Available"}</span><br/>
          <span style="font-size:11px;color:#999">Parihar India</span><br/><br/>
          <button id="dir-btn" style="
            width:100%;padding:10px;border-radius:8px;border:none;
            background:#1a73e8;color:#fff;cursor:pointer;
            font-size:14px;font-weight:600;font-family:system-ui,sans-serif;">
            Get Walking Directions
          </button>
        </div>
      `);

      popup.on("open", () => {
        document.getElementById("dir-btn")?.addEventListener("click", async () => {
          const start = userLoc.current || searchedLoc.current;
          if (!start) return;
          const btn = document.getElementById("dir-btn");
          if (btn) { btn.textContent = "Calculating..."; btn.setAttribute("disabled", "true"); }
          await getRoute(start.lng, start.lat, plng, plat);
          popup.remove();
        });
      });

      const m = new maplibregl.Marker({ element: createPinMarker(), anchor: "bottom" })
        .setLngLat([plng, plat])
        .setPopup(popup)
        .addTo(mapInst.current!);
      poiMarkers.current.push(m);
    });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const curStep  = routeInfo?.steps[stepIndex];
  const nextStep = routeInfo?.steps[stepIndex + 1];

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative", overflow: "hidden" }}>

      {/* Navigation banner */}
      {isNavigating && curStep && (
        <div className="p-nav-banner">
          <div className="p-nav-inner">
            <div className="p-dir-icon">{curStep.icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 17, lineHeight: 1.25 }}>
                {curStep.instruction}
              </div>
              {distToTurn !== null && nextStep && (
                <div style={{ fontSize: 13, opacity: 0.82, marginTop: 3 }}>
                  In {fmtDist(distToTurn)} · then {nextStep.instruction}
                </div>
              )}
            </div>
            <button className="p-end-btn" onClick={endNavigation}>End</button>
          </div>
        </div>
      )}

      {/* Arrived overlay */}
      {arrived && (
        <div className="p-arrived-overlay">
          <div className="p-arrived-card">
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "#1a73e8", margin: "0 auto",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <div style={{ color: "#fff", fontSize: 26, fontWeight: 700 }}>●</div>
            </div>
            <div style={{ fontWeight: 800, fontSize: 22, marginTop: 16 }}>You have arrived</div>
            <div style={{ color: "#666", fontSize: 14, marginTop: 6 }}>
              You have reached your destination.
            </div>
            <button className="p-done-btn" onClick={() => { setArrived(false); clearRoute(); }}>
              Done
            </button>
          </div>
        </div>
      )}

      {/* Search + action buttons */}
      {!isNavigating && (
        <div className="p-controls">
          <input
            className="p-input"
            value={query}
            placeholder="Search location..."
            onChange={(e) => { setQuery(e.target.value); fetchSuggestions(e.target.value); }}
          />
          {suggestions.length > 0 && (
            <div className="p-suggestions">
              {suggestions.map((p, i) => (
                <div key={i} className="p-suggestion-item" onClick={() => selectLocation(p)}>
                  {p.display_name}
                </div>
              ))}
            </div>
          )}
          <div className="p-btns">
            <button className="p-btn" onClick={getUserLocation}>My Location</button>
            <button className="p-btn" onClick={findRestrooms}>Find Restrooms</button>
          </div>
        </div>
      )}

      {/* Directions bottom sheet */}
      {routeInfo && !isNavigating && !arrived && (
        <div className="p-sheet">
          <div className="p-sheet-header">
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 18 }}>
                {routeInfo.duration} min walk
              </div>
              <div style={{ color: "#666", fontSize: 13, marginTop: 2 }}>
                {routeInfo.distance} · Walking directions
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
              <button className="p-start-btn" onClick={startNavigation}>
                Start Walking
              </button>
              <button className="p-close-btn" onClick={clearRoute}>×</button>
            </div>
          </div>

          <div className="p-sheet-steps">
            {routeInfo.steps.map((s, i) => (
              <div key={i} className={`p-step${i === stepIndex ? " active" : ""}`}>
                <div className="p-dir-icon-sm" style={{
                  background: i === stepIndex ? "#1a73e8" : "#e8eaed",
                  color: i === stepIndex ? "#fff" : "#444",
                }}>
                  {s.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, lineHeight: 1.3,
                    fontWeight: i === stepIndex ? 600 : 400,
                    color: "#1a1a1a",
                  }}>
                    {s.instruction}
                  </div>
                  {s.distance !== "0 m" && (
                    <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{s.distance}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={mapRef} style={{ width: "100vw", height: "100vh" }} />
    </div>
  );
}
