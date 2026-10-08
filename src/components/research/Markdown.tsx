import { Fragment, type ReactNode } from "react";

// Mini-render de Markdown hecho a mano: párrafos, **negritas**, listas "- " y
// "1.", y títulos "#". Solo produce elementos React (nunca HTML crudo ni
// enlaces): el texto lo escribe un modelo que leyó webs no confiables.

type Block =
  | { t: "p"; lines: string[] }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "h"; text: string };

function parse(md: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const h = /^#{1,6}\s+(.+)$/.exec(line);
    if (h) {
      flush();
      blocks.push({ t: "h", text: h[1] });
      continue;
    }
    const ul = /^[-*•]\s+(.+)$/.exec(line);
    if (ul) {
      if (!cur || cur.t !== "ul") {
        flush();
        cur = { t: "ul", items: [] };
      }
      cur.items.push(ul[1]);
      continue;
    }
    const ol = /^\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (ol) {
      if (!cur || cur.t !== "ol") {
        flush();
        cur = { t: "ol", items: [] };
      }
      cur.items.push(ol[1]);
      continue;
    }
    // Línea con sangría tras un elemento de lista: continúa ese elemento.
    if (cur && (cur.t === "ul" || cur.t === "ol") && /^\s+/.test(raw)) {
      cur.items[cur.items.length - 1] += ` ${line}`;
      continue;
    }
    if (!cur || cur.t !== "p") {
      flush();
      cur = { t: "p", lines: [] };
    }
    cur.lines.push(line);
  }
  flush();
  return blocks;
}

// **negritas** dentro de una línea; lo demás queda como texto tal cual.
export function Inline({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>);
    out.push(
      <strong key={i++} className="font-semibold text-slate-900">
        {m[1]}
      </strong>
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

export default function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const blocks = parse(text || "");
  return (
    <div className={`space-y-3 text-[15px] leading-relaxed text-slate-700 ${className}`}>
      {blocks.map((b, i) => {
        if (b.t === "h")
          return (
            <p key={i} className="font-semibold text-slate-900">
              <Inline text={b.text} />
            </p>
          );
        if (b.t === "ul")
          return (
            <ul key={i} className="list-disc space-y-1 pl-5 marker:text-slate-300">
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline text={it} />
                </li>
              ))}
            </ul>
          );
        if (b.t === "ol")
          return (
            <ol key={i} className="list-decimal space-y-1 pl-5 marker:text-slate-400">
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline text={it} />
                </li>
              ))}
            </ol>
          );
        return (
          <p key={i}>
            {b.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline text={l} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
