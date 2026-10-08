// Arranque de una investigación con el agente interno (misma lógica para
// POST /api/research y la herramienta MCP investigar_con_agente): valida,
// aplica el tope diario por vendedor, crea el run y lo corre en segundo plano.
import { after } from "next/server";
import { hasDb } from "../db";
import { trackCall, usedToday } from "../api-usage";
import { createRun, hasRunningRun, ResearchActionError } from "../research-repo";
import { AGENT_MISSING_KEY, agentDailyRuns, agentReady, agentUsageKey } from "./config";
import { runResearch } from "./runner";

export const NO_DB_MESSAGE = "Se necesita la base de datos para guardar investigaciones.";
export const MAX_PROMPT_CHARS = 2000;

/**
 * Lanza una investigación y devuelve su id de inmediato; el agente sigue con
 * after() (vive lo que dure la función: maxDuration de la ruta que llama).
 * Errores esperados -> ResearchActionError con mensaje y status HTTP.
 */
export async function startResearch(o: {
  prompt: string;
  userEmail: string;
  startedAt: number; // ms de inicio de la petición (cuenta para maxDuration)
}): Promise<{ id: string }> {
  const prompt = o.prompt.trim();
  if (!prompt) throw new ResearchActionError("Escribe qué quieres investigar (nicho y zona).", 400);
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new ResearchActionError("La petición es demasiado larga (máx. 2,000 caracteres).", 400);
  }
  if (!hasDb()) throw new ResearchActionError(NO_DB_MESSAGE, 503);
  if (!agentReady()) throw new ResearchActionError(AGENT_MISSING_KEY, 503);

  // Tope diario por vendedor (api_usage, api = agent:<correo>).
  const me = o.userEmail;
  const cap = agentDailyRuns();
  const used = await usedToday(agentUsageKey(me));
  if (used !== null && used >= cap) {
    throw new ResearchActionError(`Llegaste al tope de ${cap} investigaciones por día. Intenta de nuevo mañana.`, 429);
  }
  if (await hasRunningRun(me)) {
    throw new ResearchActionError("Ya tienes una investigación en curso; espera a que termine.", 409);
  }

  const id = await createRun(prompt, me);
  await trackCall(agentUsageKey(me));
  const task = () => runResearch({ runId: id, prompt, userEmail: me, startedAt: o.startedAt });
  try {
    after(task);
  } catch (e) {
    // Fuera del ciclo de la petición (no debería pasar): se corre sin after().
    console.error("research after()", e);
    void task();
  }
  return { id };
}
