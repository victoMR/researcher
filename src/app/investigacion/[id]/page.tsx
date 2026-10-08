import type { Metadata } from "next";
import ResearchSharePage from "@/components/research/ResearchSharePage";

export const metadata: Metadata = {
  title: "Investigación con IA — AI Lead Shield",
};

// Reporte compartible de una investigación. En Next 16 `params` es una promesa.
// La sesión la exige el proxy; los datos se leen en el cliente desde la API.
export default async function InvestigacionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ResearchSharePage id={id} />;
}
