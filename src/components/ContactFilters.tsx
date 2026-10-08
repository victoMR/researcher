"use client";

import { Fragment } from "react";
import {
  CONTACT_FILTER_META,
  activeKeys,
  type ContactFilterKey,
  type ContactFilterSel,
} from "@/lib/contact-filters";
import { FilterChip } from "@/components/ui";
import * as Icon from "@/components/icons";

const ICONS: Record<ContactFilterKey, React.ReactNode> = {
  email: <Icon.Mail className="h-3.5 w-3.5" />,
  phone: <Icon.Phone className="h-3.5 w-3.5" />,
  website: <Icon.Globe className="h-3.5 w-3.5" />,
  whatsapp: <Icon.WhatsApp className="h-3.5 w-3.5" />,
  score: <Icon.Star className="h-3.5 w-3.5" />,
  hideSaved: <Icon.Bookmark className="h-3.5 w-3.5" />,
};

// Chips de contacto que se combinan con Y (Buscar y Prospectos). Cada chip
// muestra cuántos quedarían al prenderlo. En móvil se desplazan en horizontal.
export default function ContactFilters({
  keys,
  value,
  onChange,
  counts,
  hints,
  className = "",
}: {
  keys: ContactFilterKey[];
  value: ContactFilterSel;
  onChange: (next: ContactFilterSel) => void;
  counts?: Partial<Record<ContactFilterKey, number>>;
  hints?: Partial<Record<ContactFilterKey, React.ReactNode>>; // junto al chip
  className?: string;
}) {
  const any = activeKeys(value, keys).length > 0;
  return (
    <div
      role="group"
      aria-label="Filtrar por datos de contacto"
      className={`-mx-4 flex items-center gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0 ${className}`}
    >
      {keys.map((k) => (
        <Fragment key={k}>
          <FilterChip
            active={!!value[k]}
            label={CONTACT_FILTER_META[k].label}
            title={CONTACT_FILTER_META[k].title}
            icon={ICONS[k]}
            count={counts?.[k]}
            onClick={() => onChange({ ...value, [k]: !value[k] })}
          />
          {hints?.[k] && <span className="shrink-0">{hints[k]}</span>}
        </Fragment>
      ))}
      {any && (
        <button
          type="button"
          onClick={() => onChange({})}
          className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium text-indigo-600 transition hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <Icon.X className="h-3.5 w-3.5" aria-hidden /> Limpiar filtros
        </button>
      )}
    </div>
  );
}
