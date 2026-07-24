export function isAllowedCorsOrigin(origin: string | undefined, host: string | undefined, configuredOrigins: ReadonlySet<string>): boolean {
  if (!origin || configuredOrigins.has(origin)) return true;
  if (!host) return false;
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();
    const isLocalhostTunnel = hostname === "localhost" || hostname.endsWith(".localhost");
    return isLocalhostTunnel && (url.protocol === "http:" || url.protocol === "https:") && url.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
