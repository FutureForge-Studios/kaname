import { describe, expect, it } from "vitest";
import { displayHost, joinPanelUrl, normalizeBaseUrl } from "./url";

describe("normalizeBaseUrl", () => {
  it("adds https and strips trailing slashes and /api/v1", () => {
    expect(normalizeBaseUrl("panel.example.com")).toBe("https://panel.example.com");
    expect(normalizeBaseUrl("https://panel.example.com/")).toBe("https://panel.example.com");
    expect(normalizeBaseUrl("https://panel.example.com/api/v1/")).toBe("https://panel.example.com");
    expect(normalizeBaseUrl(" http://10.0.0.5:3000 ")).toBe("http://10.0.0.5:3000");
  });

  it("keeps a sub-path deployment", () => {
    expect(normalizeBaseUrl("https://example.com/kaname/")).toBe("https://example.com/kaname");
  });

  it("rejects non-http schemes and garbage", () => {
    expect(normalizeBaseUrl("ftp://example.com")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("https://")).toBeNull();
  });
});

describe("joinPanelUrl", () => {
  it("joins panel-relative hrefs onto the base URL with exactly one slash", () => {
    expect(joinPanelUrl("https://panel.example.com", "/settings/security")).toBe(
      "https://panel.example.com/settings/security",
    );
    expect(joinPanelUrl("https://panel.example.com/", "settings")).toBe("https://panel.example.com/settings");
    expect(joinPanelUrl("https://example.com/kaname", "/servers/1?tab=x")).toBe(
      "https://example.com/kaname/servers/1?tab=x",
    );
  });

  it("passes absolute http(s) links through", () => {
    expect(joinPanelUrl("https://p.example", "https://docs.example.com/x")).toBe("https://docs.example.com/x");
  });

  it("refuses other schemes and protocol-relative links", () => {
    expect(joinPanelUrl("https://p.example", "javascript:alert(1)")).toBeNull();
    expect(joinPanelUrl("https://p.example", "//evil.example/x")).toBeNull();
    expect(joinPanelUrl("https://p.example", "file:///etc/passwd")).toBeNull();
  });
});

describe("displayHost", () => {
  it("drops the scheme", () => {
    expect(displayHost("https://panel.example.com:8443")).toBe("panel.example.com:8443");
  });
});
