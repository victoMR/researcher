"use client";

import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import { useEffect, useMemo, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { hasCoords, isGoogleOnly, sourceOf } from "@/lib/types";
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
  points: all,
  onSelect,
}: {
  points: Business[];
  onSelect?: (b: Business) => void;
}) {
  // Términos de Google: su contenido no se pinta sobre un mapa que no es de
  // Google (este usa OpenStreetMap). Tampoco los que ya no tienen coordenadas.
  const { points, googleOmitted, noCoords } = useMemo(() => {
    const points: Business[] = [];
    let googleOmitted = 0;
    let noCoords = 0;
    for (const p of all) {
      if (isGoogleOnly(p)) googleOmitted++;
      else if (!hasCoords(p)) noCoords++;
      else points.push(p);
    }
    return { points, googleOmitted, noCoords };
  }, [all]);

  const center: [number, number] = points.length
    ? [points[0].lat, points[0].lon]
    : [23.6345, -102.5528]; // centro de México

  // Sólo monta en cliente y con una key fresca por montaje. La key se asigna
  // en el siguiente frame (no síncrono dentro del efecto) para no provocar
  // renders en cascada; en StrictMode el primer montaje se cancela solo.
  const [mapKey, setMapKey] = useState<number | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMapKey(++mountSeq));
    return () => {
      cancelAnimationFrame(frame);
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
    <div className="relative h-full w-full">
      <MapContainer
        key={mapKey}
        center={center}
        zoom={points.length ? 12 : 5}
        className="h-full w-full rounded-xl"
        scrollWheelZoom
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
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
              <br />
              <small style={{ color: "#94a3b8" }}>
                {sourceOf(p) === "denue" || p.denueId
                  ? "Datos: DENUE (INEGI)"
                  : "© OpenStreetMap contributors"}
              </small>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
      {(googleOmitted > 0 || noCoords > 0) && (
        <div className="pointer-events-none absolute left-3 top-3 z-[1000] max-w-[80%] rounded-xl bg-white/95 px-3 py-2 text-xs text-slate-600 shadow-apple-sm">
          {googleOmitted > 0 && (
            <p>
              {googleOmitted} de Google no se muestran en este mapa (sus términos no lo
              permiten). Ábrelos en Google Maps desde su tarjeta.
            </p>
          )}
          {noCoords > 0 && <p>{noCoords} sin ubicación guardada.</p>}
        </div>
      )}
    </div>
  );
}
