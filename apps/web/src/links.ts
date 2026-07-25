const newTabProtocols = new Set(["http:", "https:"]);

/** True when a link points at another origin over http(s), so it should open in a new tab. */
export function isExternalHref(href: string | null | undefined, baseUrl?: string): boolean {
  if (!href) return false;
  const base = baseUrl ?? (typeof window === "undefined" ? undefined : window.location.href);
  if (!base) return false;
  try {
    const target = new URL(href, base);
    if (!newTabProtocols.has(target.protocol)) return false;
    return target.origin !== new URL(base).origin;
  } catch {
    return false;
  }
}

export type ExternalLinkProps = { target: "_blank"; rel: "noopener noreferrer" } | Record<string, never>;

/** Anchor props that open external links in a new tab without leaking the opener. */
export function externalLinkProps(href: string | null | undefined, baseUrl?: string): ExternalLinkProps {
  return isExternalHref(href, baseUrl) ? { target: "_blank", rel: "noopener noreferrer" } : {};
}
