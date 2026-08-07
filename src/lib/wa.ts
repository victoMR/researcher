// Arma un link de WhatsApp (wa.me) con el texto ya listo. MX por defecto.
export function waLink(phone: string, text: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) digits = "52" + digits; // MX sin lada país
  else if (digits.length === 13 && digits.startsWith("521")) digits = "52" + digits.slice(3);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
