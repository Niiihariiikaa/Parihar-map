import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export default function RestroomFinder() {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const markersRef = useRef([]);
  const searchedLocationRef = useRef(null);
  const routeLayerId = "route-line";

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);


  useEffect(() => {
    if (!mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      center: [78.9629, 20.5937],
      zoom: 5,
      style: "/india-style.json", // your custom style
    });

    map.addControl(new maplibregl.NavigationControl());
    mapInstance.current = map;

    return () => map.remove();
  }, []);

  /* ===================== SEARCH ===================== */
  const fetchSuggestions = async (text) => {
    if (!text) {
      setSuggestions([]);
      return;
    }

    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(
        text
      )}&limit=5`
    );

    const data = await res.json();
    setSuggestions(data);
  };

  const selectLocation = (place) => {
    const lat = Number(place.lat);
    const lon = Number(place.lon);

    searchedLocationRef.current = { lat, lng: lon };
    setSuggestions([]);
    setQuery(place.display_name);

    mapInstance.current.flyTo({
      center: [lon, lat],
      zoom: 15,
    });
  };

  /* ===================== ROUTING ===================== */
  const getRoute = async (start, end) => {
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/walking/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`
    );

    const data = await res.json();
    if (!data.routes?.length) return;

    const route = data.routes[0];

    if (mapInstance.current.getSource(routeLayerId)) {
      mapInstance.current.removeLayer(routeLayerId);
      mapInstance.current.removeSource(routeLayerId);
    }

    mapInstance.current.addSource(routeLayerId, {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: route.geometry,
      },
    });

    mapInstance.current.addLayer({
      id: routeLayerId,
      type: "line",
      source: routeLayerId,
      paint: {
        "line-color": "#000",
        "line-width": 5,
      },
    });

    return {
      distance: (route.distance / 1000).toFixed(2),
      duration: Math.round(route.duration / 60),
    };
  };

 
  const findPlaces = async () => {
    if (!searchedLocationRef.current) {
      alert("Search a location first");
      return;
    }

    const { lat, lng } = searchedLocationRef.current;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const query = `
      [out:json];
      (
        node["amenity"="toilets"](around:2000,${lat},${lng});
        node["shop"="mall"](around:2000,${lat},${lng});
        node["amenity"~"hospital|clinic"](around:2000,${lat},${lng});
        node["amenity"~"restaurant|cafe|fast_food"](around:2000,${lat},${lng});
        node["railway"="station"]["station"="subway"](around:2000,${lat},${lng});
      );
      out center;
    `;

    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
    });

    const data = await res.json();

    data.elements.forEach((place) => {
      const latitude = place.lat ?? place.center?.lat;
      const longitude = place.lon ?? place.center?.lon;
      if (!latitude || !longitude) return;

      const isPublic = place.tags?.amenity === "toilets";
      const name = place.tags?.name;

      const popup = new maplibregl.Popup().setHTML(`
        <strong>${name || (isPublic ? "Public Restroom" : "Location")}</strong><br/>
        ${isPublic ? "Public Restroom" : "Restroom Likely"}<br/>
        <br/>
        <button style="
          padding:6px 10px;
          border-radius:6px;
          border:none;
          background:black;
          color:white;
          cursor:pointer;
        ">Get Directions</button>
      `);

      popup.on("open", () => {
        const btn = popup.getElement().querySelector("button");
        if (btn) {
          btn.onclick = async () => {
            const routeInfo = await getRoute(
              searchedLocationRef.current,
              { lat: latitude, lng: longitude }
            );

            if (routeInfo) {
              popup.setHTML(`
                <strong>${name || (isPublic ? "Public Restroom" : "Location")}</strong><br/>
                ${isPublic ? "Public Restroom" : "Restroom Likely"}<br/>
                <br/>
                Distance: ${routeInfo.distance} km<br/>
                ETA: ${routeInfo.duration} mins
              `);
            }
          };
        }
      });

      const marker = new maplibregl.Marker()
        .setLngLat([longitude, latitude])
        .setPopup(popup)
        .addTo(mapInstance.current);

      markersRef.current.push(marker);
    });
  };

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <div
        style={{
          position: "absolute",
          top: 20,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 10,
        }}
      >
        <input
          value={query}
          placeholder="Search location..."
          onChange={(e) => {
            setQuery(e.target.value);
            fetchSuggestions(e.target.value);
          }}
          style={{
            padding: "10px 16px",
            borderRadius: 20,
            width: 280,
          }}
        />

        {suggestions.length > 0 && (
          <div
            style={{
              background: "white",
              borderRadius: 12,
              marginTop: 6,
              maxHeight: 200,
              overflowY: "auto",
              boxShadow: "0 4px 10px rgba(0,0,0,0.15)",
            }}
          >
            {suggestions.map((place, index) => (
              <div
                key={index}
                onClick={() => selectLocation(place)}
                style={{
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {place.display_name}
              </div>
            ))}
          </div>
        )}
      </div>

      <button
        onClick={findPlaces}
        style={{
          position: "absolute",
          top: 80,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: 10,
          padding: "8px 14px",
          borderRadius: 20,
          background: "black",
          color: "white",
          cursor: "pointer",
        }}
      >
        Show Certified Restrooms
      </button>

      <div ref={mapRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}