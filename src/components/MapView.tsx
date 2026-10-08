"use client";

import dynamic from "next/dynamic";

// Mapa de Leaflet cargado solo en el cliente (Leaflet necesita window).
const MapView = dynamic(() => import("@/components/LeadsMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-400">
      Cargando mapa…
    </div>
  ),
});

export default MapView;
