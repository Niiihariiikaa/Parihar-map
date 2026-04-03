import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

const createSvgMarker = () => {
  const el = document.createElement("img");
  el.src = "/pin.svg";
  el.style.width = "40px";
  el.style.height = "40px";
  el.style.cursor = "pointer";
  el.style.filter = "drop-shadow(0 3px 6px rgba(0,0,0,0.3))";
  return el;
};

export default function MapLibreTest() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<maplibregl.Map | null>(null);
  const searchMarkerRef = useRef<maplibregl.Marker | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const restroomMarkersRef = useRef<maplibregl.Marker[]>([]);
  const searchedLocationRef = useRef<{ lat: number; lng: number } | null>(null);
  const userLocationRef = useRef<{ lat: number; lng: number } | null>(null);
  const routeLayerId = "route-line";

  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [query, setQuery] = useState("");


  useEffect(() => {
    if (!mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapRef.current,
      center: [78.9629, 20.5937],
      zoom: 5,
      style: "/india-style.json",
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl());
    mapInstance.current = map;

    return () => map.remove();
  }, []);


  const getRoute = async (
    startLng: number,
    startLat: number,
    endLng: number,
    endLat: number
  ) => {
    const res = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${endLng},${endLat}?overview=full&geometries=geojson`
    );

    const data = await res.json();
    if (!data.routes?.length) return;

    const route = data.routes[0];

    if (mapInstance.current?.getSource(routeLayerId)) {
      mapInstance.current.removeLayer(routeLayerId);
      mapInstance.current.removeSource(routeLayerId);
    }

    mapInstance.current?.addSource(routeLayerId, {
      type: "geojson",
      data: {
        type: "Feature",
        geometry: route.geometry,
      },
    });

    mapInstance.current?.addLayer({
      id: routeLayerId,
      type: "line",
      source: routeLayerId,
      paint: {
        "line-color": "#111",
        "line-width": 5,
      },
    });

    const coords = route.geometry.coordinates;
    const bounds = coords.reduce(
      (b: any, coord: any) => b.extend(coord),
      new maplibregl.LngLatBounds(coords[0], coords[0])
    );

    mapInstance.current?.fitBounds(bounds, { padding: 60 });

    return {
      distance: (route.distance / 1000).toFixed(2),
      duration: Math.round(route.duration / 60),
    };
  };


  const getUserLocation = () => {
    if (!navigator.geolocation) {
      alert("Geolocation not supported");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        userLocationRef.current = { lat, lng };

        userMarkerRef.current?.remove();

        userMarkerRef.current = new maplibregl.Marker({ color: "blue" })
          .setLngLat([lng, lat])
          .setPopup(new maplibregl.Popup().setText("Your Location"))
          .addTo(mapInstance.current!);

        mapInstance.current?.flyTo({
          center: [lng, lat],
          zoom: 15,
        });
      },
      () => alert("Location permission denied")
    );
  };


  const fetchSuggestions = async (text: string) => {
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

  const selectLocation = (place: any) => {
    const lat = Number(place.lat);
    const lon = Number(place.lon);

    searchedLocationRef.current = { lat, lng: lon };
    setSuggestions([]);
    setQuery(place.display_name);

    searchMarkerRef.current?.remove();

    searchMarkerRef.current = new maplibregl.Marker({
      element: createSvgMarker(),
      anchor: "bottom",
    })
      .setLngLat([lon, lat])
      .setPopup(new maplibregl.Popup().setText("Searched Location"))
      .addTo(mapInstance.current!);

    mapInstance.current?.flyTo({
      center: [lon, lat],
      zoom: 15,
    });
  };

  
  const findRestrooms = async () => {
    const source =
      userLocationRef.current || searchedLocationRef.current;

    if (!source) {
      alert("Search or use your location first");
      return;
    }

    restroomMarkersRef.current.forEach((m) => m.remove());
    restroomMarkersRef.current = [];

    const { lat, lng } = source;

    const query = `
      [out:json];
      (
        node["amenity"="toilets"](around:2500,${lat},${lng});
        node["shop"="mall"](around:2500,${lat},${lng});
        node["amenity"~"hospital|clinic"](around:2500,${lat},${lng});
        node["amenity"~"restaurant|cafe|fast_food"](around:2500,${lat},${lng});
        node["railway"="station"]["station"="subway"](around:2500,${lat},${lng});
      );
      out center;
    `;

    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: query,
    });

    const data = await res.json();

    data.elements.forEach((place: any) => {
      const latitude = place.lat ?? place.center?.lat;
      const longitude = place.lon ?? place.center?.lon;
      if (!latitude || !longitude) return;

      const isPublic = place.tags?.amenity === "toilets";
      const name = place.tags?.name;

      const popup = new maplibregl.Popup().setHTML(`
        <strong>${name || (isPublic ? "Public Restroom" : "Location")}</strong><br/>
        ${isPublic ? "Public Restroom" : "Restroom Likely"}<br/>
        Parihar India
        <br/><br/>
        <button id="dir-btn" style="
          padding:6px 10px;
          border-radius:6px;
          border:none;
          background:black;
          color:white;
          cursor:pointer;
        ">Get Directions</button>
      `);

      popup.on("open", () => {
        const btn = document.getElementById("dir-btn");
        if (btn) {
          btn.onclick = async () => {
            const start =
              userLocationRef.current || searchedLocationRef.current;
            if (!start) return;

            const routeInfo = await getRoute(
              start.lng,
              start.lat,
              longitude,
              latitude
            );

            if (routeInfo) {
              popup.setHTML(`
                <strong>${name || (isPublic ? "Public Restroom" : "Location")}</strong><br/>
                ${isPublic ? "Public Restroom" : "Restroom Likely"}<br/>
                Parihar India
                <br/><br/>
                <strong>Distance:</strong> ${routeInfo.distance} km<br/>
                <strong>ETA:</strong> ${routeInfo.duration} mins
              `);
            }
          };
        }
      });

      const marker = new maplibregl.Marker({
        element: createSvgMarker(),
        anchor: "bottom",
      })
        .setLngLat([longitude, latitude])
        .setPopup(popup)
        .addTo(mapInstance.current!);

      restroomMarkersRef.current.push(marker);
    });
  };

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
     
      <div style={{
        position: "absolute",
        top: 20,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 10
      }}>
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
          <div style={{
            background: "white",
            borderRadius: 12,
            marginTop: 6,
            maxHeight: 200,
            overflowY: "auto",
            boxShadow: "0 4px 10px rgba(0,0,0,0.15)"
          }}>
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
        onClick={getUserLocation}
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
        Use My Location
      </button>

      <button
        onClick={findRestrooms}
        style={{
          position: "absolute",
          top: 130,
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

      <div ref={mapRef} style={{ width: "100vw", height: "100vh" }} />
    </div>
  );
}
