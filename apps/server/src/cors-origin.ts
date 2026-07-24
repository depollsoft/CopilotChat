export function isAllowedCorsOrigin(origin: string | undefined, host: string | undefined, configuredOrigins: ReadonlySet<string>): boolean {
  if (!origin || configuredOrigins.has(origin)) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
