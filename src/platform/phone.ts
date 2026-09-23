export function toE164(raw: string): string | null {
  const compact = raw.replace(/[\s()-]/g, "");
  if (/^\+91\d{10}$/.test(compact)) return compact;
  if (/^91\d{10}$/.test(compact)) return `+${compact}`;
  if (/^\d{10}$/.test(compact)) return `+91${compact}`;
  return null;
}
