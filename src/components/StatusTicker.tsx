"use client";

import { useEffect, useState } from "react";

/** Mensajes que rotan durante la carga para que se sienta que "sí está trabajando". */
export default function StatusTicker({ messages }: { messages: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((v) => (v + 1) % messages.length), 1300);
    return () => clearInterval(t);
  }, [messages.length]);

  return (
    <div className="flex items-center gap-2 text-sm font-medium text-indigo-600">
      <span className="flex gap-1">
        <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500" />
      </span>
      <span key={i} className="animate-[fadeIn_0.4s_ease]">
        {messages[i]}
      </span>
    </div>
  );
}
