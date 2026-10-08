"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Me } from "@/lib/types";
import * as Icon from "@/components/icons";
import ResearchRunView from "./ResearchRunView";
import { copyText, reportUrl } from "./util";

// Página compartible de una investigación (/investigacion/[id]). Requiere
// sesión como el resto de la app (lo resuelve el proxy).
export default function ResearchSharePage({ id }: { id: string }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        if (d?.email) setMe(d);
      })
      .catch(() => {});
  }, []);

  async function copyLink() {
    const url = reportUrl(id);
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      window.prompt("Copia el enlace:", url);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-black/5 bg-white/70 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <span className="grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-b from-indigo-500 to-indigo-600 text-white shadow-apple-sm">
              <Icon.Shield className="h-5 w-5" />
            </span>
            <span>
              <span className="block text-base font-semibold leading-tight tracking-tight text-slate-900">
                AI Lead Shield
              </span>
              <span className="block text-xs text-slate-400">Investigación con IA</span>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={copyLink}
              className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {copied ? (
                <>
                  <Icon.Check className="h-3.5 w-3.5 text-emerald-600" /> Enlace copiado
                </>
              ) : (
                <>
                  <Icon.LinkIcon className="h-3.5 w-3.5" /> Copiar enlace
                </>
              )}
            </button>
            <Link
              href="/"
              className="hidden items-center gap-1.5 rounded-full bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 sm:flex"
            >
              Ir a la app <Icon.ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <ResearchRunView
          key={id}
          id={id}
          me={me}
          standalone
          onOpen={(next) => router.push(`/investigacion/${encodeURIComponent(next)}`)}
        />
      </main>
    </div>
  );
}
