import { describe, expect, it } from "vitest";

import { externalLinkProps, isExternalHref } from "./links.js";

const base = "https://chat.example.com/c/123";

describe("isExternalHref", () => {
  it("treats other origins as external", () => {
    expect(isExternalHref("https://github.com/depollsoft/CopilotChat", base)).toBe(true);
    expect(isExternalHref("http://example.com", base)).toBe(true);
    expect(isExternalHref("//example.com/docs", base)).toBe(true);
    expect(isExternalHref("https://chat.example.com:8443/c/123", base)).toBe(true);
  });

  it("keeps same-origin and in-page links in the current tab", () => {
    expect(isExternalHref("https://chat.example.com/settings", base)).toBe(false);
    expect(isExternalHref("/api/auth/github/login", base)).toBe(false);
    expect(isExternalHref("./attachment.png", base)).toBe(false);
    expect(isExternalHref("#section", base)).toBe(false);
  });

  it("ignores non-http protocols and unusable hrefs", () => {
    expect(isExternalHref("mailto:hi@example.com", base)).toBe(false);
    expect(isExternalHref("tel:+15551234567", base)).toBe(false);
    expect(isExternalHref("", base)).toBe(false);
    expect(isExternalHref(undefined, base)).toBe(false);
    expect(isExternalHref("https://example.com", "not a url")).toBe(false);
  });
});

describe("externalLinkProps", () => {
  it("opens external links in a new tab without leaking the opener", () => {
    expect(externalLinkProps("https://example.com", base)).toEqual({ target: "_blank", rel: "noopener noreferrer" });
  });

  it("returns no overrides for internal links", () => {
    expect(externalLinkProps("/settings", base)).toEqual({});
  });
});
