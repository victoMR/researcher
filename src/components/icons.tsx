import type { SVGProps } from "react";

// Íconos SVG (estilo línea), sin emojis. Tamaño vía className (default h-4 w-4).
type P = SVGProps<SVGSVGElement>;
function Svg({ children, ...p }: P) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p.className ?? "h-4 w-4"}
      {...p}
    >
      {children}
    </svg>
  );
}

export const Target = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </Svg>
);
export const Globe = (p: P) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10Z" />
  </Svg>
);
export const MapPin = (p: P) => (
  <Svg {...p}>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </Svg>
);
export const Loader = (p: P) => (
  <Svg {...p} className={`${p.className ?? "h-4 w-4"} animate-spin`}>
    <path d="M21 12a9 9 0 1 1-6.2-8.5" />
  </Svg>
);
export const Flame = (p: P) => (
  <Svg {...p}>
    <path d="M12 2c.9 3.5 3.5 5 3.5 8.5a3.5 3.5 0 0 1-7 0c0-1 .3-1.8.8-2.5C10.5 9.5 12 7 12 2Z" />
    <path d="M12 22a5 5 0 0 0 5-5c0-3-2-4.5-2.5-6" opacity="0.4" />
  </Svg>
);
export const List = (p: P) => (
  <Svg {...p}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Svg>
);
export const MapIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 5 3 7v12l6-2 6 2 6-2V5l-6 2-6-2Z" />
    <path d="M9 5v12M15 7v12" />
  </Svg>
);
export const Download = (p: P) => (
  <Svg {...p}>
    <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
  </Svg>
);
export const Mail = (p: P) => (
  <Svg {...p}>
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m2 7 10 6 10-6" />
  </Svg>
);
export const Phone = (p: P) => (
  <Svg {...p}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2Z" />
  </Svg>
);
export const Star = (p: P) => (
  <svg
    viewBox="0 0 24 24"
    fill="currentColor"
    className={p.className ?? "h-4 w-4"}
    {...p}
  >
    <path d="m12 2 3 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.9 21l1.2-6.8-5-4.9 6.9-1L12 2Z" />
  </svg>
);
export const Search = (p: P) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </Svg>
);
export const Bookmark = (p: P) => (
  <Svg {...p}>
    <path d="M19 21 12 17 5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2Z" />
  </Svg>
);
export const ExternalLink = (p: P) => (
  <Svg {...p}>
    <path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Svg>
);
export const Refresh = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3" />
    <path d="M21 3v5h-5M3 21v-5h5" />
  </Svg>
);
export const Check = (p: P) => (
  <Svg {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);
export const Plus = (p: P) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const Car = (p: P) => (
  <Svg {...p}>
    <path d="M5 13 6.5 8.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13" />
    <path d="M5 13h14a1 1 0 0 1 1 1v3H4v-3a1 1 0 0 1 1-1Z" />
    <circle cx="7.5" cy="17" r="1.2" />
    <circle cx="16.5" cy="17" r="1.2" />
  </Svg>
);
export const Building = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="2" width="16" height="20" rx="1" />
    <path d="M9 6h.01M9 10h.01M9 14h.01M15 6h.01M15 10h.01M15 14h.01M9 22v-4h6v4" />
  </Svg>
);
export const Wrench = (p: P) => (
  <Svg {...p}>
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.1-.4-.4-2.1 2.5-2.5Z" />
  </Svg>
);
export const X = (p: P) => (
  <Svg {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
);
export const WhatsApp = (p: P) => (
  <Svg {...p}>
    <path d="M3 21l1.65-4.8a9 9 0 1 1 3.4 2.9L3 21" />
    <path d="M9 10a.5.5 0 0 0 .5.5 4 4 0 0 0 4 4 .5.5 0 0 0 .5-.5v-1l-2-1-1 1a5 5 0 0 1-1-1l1-1-1-2H9a4 4 0 0 0 0 2Z" />
  </Svg>
);
export const BarChart = (p: P) => (
  <Svg {...p}>
    <path d="M3 3v18h18" />
    <path d="M7 15v3M12 9v9M17 5v13" />
  </Svg>
);
export const Users = (p: P) => (
  <Svg {...p}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
  </Svg>
);
export const Send = (p: P) => (
  <Svg {...p}>
    <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" />
  </Svg>
);
export const Shield = (p: P) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6l7-3Z" />
    <path d="M9 11.5l2 2 4-4" />
  </Svg>
);
export const Lock = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </Svg>
);
export const LogOut = (p: P) => (
  <Svg {...p}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </Svg>
);
