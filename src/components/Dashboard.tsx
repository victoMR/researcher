"use client";

import { useEffect, useState } from "react";
import * as Icon from "@/components/icons";

interface Stats {
  total: number;
  withEmail: number;
  withPhone: number;
  avgScore: number;
  byStatus: { key: string; count: number }[];
  byCategory: { key: string; count: number }[];
  byCity: { key: string; count: number }[];
  byScore: { score: number; count: number }[];
}

const STATUS_LABEL: Record<string, string> = {
  nuevo: "Nuevo",
  contactado: "Contactado",
  respondio: "Respondió",
  descartado: "Descartado",
};
// Paleta de estado reservada (siempre acompañada de etiqueta, nunca solo color).
const STATUS_FILL: Record<string, string> = {
  nuevo: "bg-slate-400",
  contactado: "bg-indigo-500",
  respondio: "bg-emerald-500",
  descartado: "bg-rose-400",
};
const STATUS_ORDER = ["nuevo", "contactado", "respondio", "descartado"];

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/stats");
        const data = await res.json();
        if (res.ok) setStats(data);
        else setError(data.error || "No se pudieron cargar las métricas.");
      } catch {
        setError("Error de red al cargar métricas.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading)
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-white" />
        ))}
      </div>
    );

  if (error)
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        {error}
      </p>
    );

  if (!stats || stats.total === 0)
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white py-16 text-center">
        <span className="mb-3 text-slate-300">
          <Icon.BarChart className="h-8 w-8" />
        </span>
        <h3 className="font-semibold text-slate-700">Sin datos todavía</h3>
        <p className="mt-1 text-sm text-slate-400">
          Guarda prospectos para ver tus métricas aquí.
        </p>
      </div>
    );

  const pct = (n: number) =>
    stats.total ? Math.round((n / stats.total) * 100) : 0;

  // Ordena estatus en el orden natural del pipeline.
  const statusRows = STATUS_ORDER.map((k) => ({
    key: k,
    label: STATUS_LABEL[k] ?? k,
    count: stats.byStatus.find((s) => s.key === k)?.count ?? 0,
    fill: STATUS_FILL[k] ?? "bg-indigo-500",
  }));

  return (
    <div className="space-y-4">
      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          icon={<Icon.Users className="h-4 w-4" />}
          label="Prospectos guardados"
          value={stats.total}
        />
        <Kpi
          icon={<Icon.Mail className="h-4 w-4" />}
          label="Con correo"
          value={stats.withEmail}
          sub={`${pct(stats.withEmail)}% del total`}
        />
        <Kpi
          icon={<Icon.Phone className="h-4 w-4" />}
          label="Con teléfono / WhatsApp"
          value={stats.withPhone}
          sub={`${pct(stats.withPhone)}% del total`}
        />
        <Kpi
          icon={<Icon.Star className="h-4 w-4" />}
          label="Score promedio"
          value={stats.avgScore}
          sub="de 10"
        />
      </div>

      {/* Pipeline por estatus */}
      <ChartCard title="Pipeline por estatus">
        <BarList
          rows={statusRows.map((r) => ({
            label: r.label,
            count: r.count,
            fill: r.fill,
          }))}
          max={Math.max(1, ...statusRows.map((r) => r.count))}
        />
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Por giro */}
        <ChartCard title="Por giro">
          <BarList
            rows={stats.byCategory.map((c) => ({
              label: c.key,
              count: c.count,
            }))}
            max={Math.max(1, ...stats.byCategory.map((c) => c.count))}
          />
        </ChartCard>

        {/* Por ciudad */}
        <ChartCard title="Por ciudad (top 8)">
          <BarList
            rows={stats.byCity.map((c) => ({ label: c.key, count: c.count }))}
            max={Math.max(1, ...stats.byCity.map((c) => c.count))}
          />
        </ChartCard>
      </div>

      {/* Distribución de score */}
      {stats.byScore.length > 0 && (
        <ChartCard title="Distribución de calificación (1–10)">
          <BarList
            rows={stats.byScore.map((s) => ({
              label: `${s.score}`,
              count: s.count,
            }))}
            max={Math.max(1, ...stats.byScore.map((s) => s.count))}
            narrowLabel
          />
        </ChartCard>
      )}
    </div>
  );
}

function Kpi({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm">
      <div className="flex items-center gap-1.5 text-slate-400">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="mt-2 text-3xl font-bold tracking-tight text-slate-900">
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-400">{sub}</div>}
    </div>
  );
}

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm">
      <h3 className="mb-3 text-sm font-semibold text-slate-700">{title}</h3>
      {children}
    </div>
  );
}

function BarList({
  rows,
  max,
  narrowLabel,
}: {
  rows: { label: string; count: number; fill?: string }[];
  max: number;
  narrowLabel?: boolean;
}) {
  if (!rows.length)
    return <p className="text-xs text-slate-400">Sin datos.</p>;
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3">
          <span
            className={`shrink-0 truncate text-xs text-slate-600 ${
              narrowLabel ? "w-6 text-center" : "w-28"
            }`}
            title={r.label}
          >
            {r.label}
          </span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
            <div
              className={`h-full rounded-full ${r.fill ?? "bg-indigo-500"}`}
              style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-xs font-semibold text-slate-700">
            {r.count}
          </span>
        </div>
      ))}
    </div>
  );
}
