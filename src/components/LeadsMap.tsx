"use client";

import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import { useEffect, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Business } from "@/lib/types";

// Contador de montajes para dar una key fresca al contenedor y evitar el
// error "Map container is being reused" de react-leaflet.
let mountSeq = 0;

// Arregla los íconos por defecto de Leaflet en bundlers.
const icon = L.icon({
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

function FitBounds({ points }: { points: Business[] }) {
  const map = useMap();
  useEffect(() => {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lon]));
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [points, map]);
  return null;
}

export default function LeadsMap({
  points,
  onSelect,
}: {
  points: Business[];
  onSelect?: (b: Business) => void;
}) {
  const center: [number, number] = points.length
    ? [points[0].lat, points[0].lon]
    : [23.6345, -102.5528]; // centro de México

  // Sólo monta en cliente y con una key estable por instancia.
  const [mapKey, setMapKey] = useState<number | null>(null);
  useEffect(() => {
    setMapKey(++mountSeq);
    return () => {
      // fuerza recreación limpia en el próximo montaje
      setMapKey(null);
    };
  }, []);

  if (mapKey === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        Cargando mapa…
      </div>
    );
  }

  return (
    <MapContainer
      key={mapKey}
      center={center}
      zoom={points.length ? 12 : 5}
      className="h-full w-full rounded-xl"
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; OpenStreetMap'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <FitBounds points={points} />
      {points.map((p) => (
        <Marker
          key={p.id}
          position={[p.lat, p.lon]}
          icon={icon}
          eventHandlers={{ click: () => onSelect?.(p) }}
        >
          <Popup>
            <strong>{p.name}</strong>
            <br />
            {p.address && <span>{p.address}</span>}
            {p.phone && (
              <>
                <br />
                Tel: {p.phone}
              </>
            )}
            {p.website && (
              <>
                <br />
                <a href={p.website} target="_blank" rel="noreferrer">
                  {p.website}
                </a>
              </>
            )}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}
