import type { LeadStatus } from "@/lib/types";

// Piezas de UI compartidas entre Buscar y Prospectos.

export const STATUS_META: Record<LeadStatus, { label: string; cls: string; dot: string }> = {
  nuevo: { label: "Nuevo", cls: "bg-slate-100 text-slate-600", dot: "bg-slate-400" },
  contactado: {
    label: "Contactado",
    cls: "bg-indigo-100 text-indigo-700",
    dot: "bg-indigo-500",
  },
  respondio: {
    label: "Respondió",
    cls: "bg-emerald-100 text-emerald-700",
    dot: "bg-emerald-500",
  },
  descartado: { label: "Descartado", cls: "bg-rose-100 text-rose-700", dot: "bg-rose-400" },
};

export function SkeletonCard() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-slate-100 to-transparent" />
      <div className="mb-3 h-4 w-2/3 rounded bg-slate-100" />
      <div className="mb-2 h-3 w-full rounded bg-slate-100" />
      <div className="mb-4 h-3 w-1/2 rounded bg-slate-100" />
      <div className="flex gap-2">
        <div className="h-7 w-20 rounded-lg bg-slate-100" />
        <div className="h-7 w-20 rounded-lg bg-slate-100" />
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  sub,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 bg-white py-16 text-center">
      <span className="mb-3 text-slate-300">{icon}</span>
      <h3 className="font-semibold text-slate-700">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-slate-400">{sub}</p>
      {children && <div className="mt-4 flex flex-wrap justify-center gap-2">{children}</div>}
    </div>
  );
}

export function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm transition hover:shadow-apple animate-[fadeIn_0.3s_ease]">
      {children}
    </div>
  );
}

// Chip de filtro que se prende/apaga (aria-pressed), con conteo opcional.
export function FilterChip({
  active,
  label,
  count,
  icon,
  title,
  onClick,
}: {
  active: boolean;
  label: React.ReactNode;
  count?: number;
  icon?: React.ReactNode;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 ${
        active
          ? "bg-indigo-600 text-white shadow-apple-sm"
          : "border border-black/10 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {icon && (
        <span aria-hidden className={`flex ${active ? "text-white" : "text-slate-400"}`}>
          {icon}
        </span>
      )}
      {label}
      {count != null && (
        <span className={`tabular-nums ${active ? "text-white/80" : "text-slate-400"}`}>{count}</span>
      )}
    </button>
  );
}

// Interruptor segmentado (Lista/Mapa, Míos/Todos...).
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; title?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-full bg-black/[0.04] p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition ${
            value === o.value
              ? "bg-white text-slate-900 shadow-apple-sm"
              : "text-slate-500 hover:text-slate-800"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
