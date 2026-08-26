import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AgentConnection, HealthState } from "@kaname/contract";
import { AgentConnectionIndicator, HealthBadge } from "./Status.js";

/* ------------------------------------------------------------------ *
 * The two status axes (PLAN.md 2.6, and the reason the kit has two
 * components instead of one):
 *   - every state of each axis reads differently from every other
 *   - the axes never collapse into each other
 * A server that is `connected` + `critical` is the case the product is
 * designed against losing, so it is asserted directly.
 * ------------------------------------------------------------------ */

const CONNECTIONS: readonly AgentConnection[] = [
  "connected",
  "degraded",
  "disconnected",
  "never_enrolled",
  "revoked",
];

const HEALTHS: readonly HealthState[] = ["healthy", "warning", "critical", "unknown"];

/** The dot is the first child; its classes carry tone, pulse and hollow. */
function dotOf(root: HTMLElement): HTMLElement {
  const dot = root.querySelector<HTMLElement>("span[aria-hidden='true']");
  if (!dot) throw new Error("indicator rendered no dot");
  return dot;
}

/** The label sits in a truncating span; the pill above it owns tone and title. */
function badgeOf(label: string): HTMLElement {
  const badge = screen.getByText(label).parentElement;
  if (!badge) throw new Error(`no badge around ${label}`);
  return badge;
}

function indicator(connection: AgentConnection): HTMLElement {
  const { container } = render(
    <AgentConnectionIndicator connection={connection} data-testid="indicator" />,
  );
  const root = container.querySelector<HTMLElement>("[data-testid='indicator']");
  if (!root) throw new Error("indicator did not render");
  return root;
}

describe("AgentConnectionIndicator", () => {
  it("gives every connection state its own label and dot treatment", () => {
    const signatures = CONNECTIONS.map((connection) => {
      const root = indicator(connection);
      return `${root.textContent ?? ""}|${dotOf(root).className}`;
    });

    expect(new Set(signatures).size).toBe(CONNECTIONS.length);
  });

  it("colours reachable green, late amber and unreachable red", () => {
    expect(dotOf(indicator("connected")).className).toContain("bg-[var(--kn-ok)]");
    expect(dotOf(indicator("degraded")).className).toContain("bg-[var(--kn-warn)]");
    expect(dotOf(indicator("disconnected")).className).toContain("border-[var(--kn-danger)]");
  });

  it("pulses only while something is still in motion", () => {
    expect(dotOf(indicator("degraded")).className).toContain("animate-[kn-pulse-ring");
    expect(dotOf(indicator("connected")).className).not.toContain("animate-[kn-pulse-ring");
  });

  it("draws absence hollow rather than filled", () => {
    for (const connection of ["disconnected", "never_enrolled", "revoked"] as const) {
      expect(dotOf(indicator(connection)).className).toContain("bg-transparent");
    }
    expect(dotOf(indicator("connected")).className).not.toContain("bg-transparent");
  });

  it("explains the state in the tooltip", () => {
    expect(indicator("never_enrolled").title).toContain("Run the enrollment command");
    expect(indicator("revoked").title).toContain("Re-enroll");
  });

  it("does not claim a last-seen time for a host that was never seen", () => {
    const seen = new Date("2026-08-26T10:00:00Z");
    render(<AgentConnectionIndicator connection="connected" since={seen} data-testid="a" />);
    render(<AgentConnectionIndicator connection="never_enrolled" since={seen} data-testid="b" />);

    expect(screen.getByTestId("a").title).toContain("Last seen");
    expect(screen.getByTestId("b").title).not.toContain("Last seen");
  });

  it("keeps an accessible name when the label is hidden", () => {
    const { container } = render(
      <AgentConnectionIndicator connection="disconnected" showLabel={false} />,
    );
    expect(container.textContent).toContain("Agent Disconnected");
    expect(screen.queryByText("Disconnected")).toBeNull();
  });
});

describe("HealthBadge", () => {
  it("gives every health state its own label and tone", () => {
    const signatures = HEALTHS.map((health) => {
      const { container } = render(<HealthBadge health={health} />);
      const badge = container.firstElementChild as HTMLElement;
      return `${badge.textContent ?? ""}|${badge.className}`;
    });

    expect(new Set(signatures).size).toBe(HEALTHS.length);
  });

  it("carries the semantic tone of each verdict", () => {
    const toneOf = (health: HealthState) => {
      const { container } = render(<HealthBadge health={health} />);
      return (container.firstElementChild as HTMLElement).className;
    };

    expect(toneOf("healthy")).toContain("text-[var(--kn-ok)]");
    expect(toneOf("warning")).toContain("text-[var(--kn-warn)]");
    expect(toneOf("critical")).toContain("text-[var(--kn-danger)]");
    expect(toneOf("unknown")).toContain("text-[var(--kn-text-2)]");
  });

  it("prefers the concrete reasons over the generic description", () => {
    render(<HealthBadge health="critical" reasons={["/ at 94%", "nginx.service failed"]} />);
    const badge = badgeOf("Critical");

    expect(badge.title).toContain("/ at 94% · nginx.service failed");
    expect(badge.title).not.toContain("At least one threshold has been breached");
  });
});

describe("the two axes stay independent", () => {
  it("shows both when a reachable host is unhealthy", () => {
    render(
      <>
        <AgentConnectionIndicator connection="connected" data-testid="conn" />
        <HealthBadge health="critical" />
      </>,
    );

    const connection = screen.getByTestId("conn");
    const health = badgeOf("Critical");

    // Reachable and broken at the same time: neither reading may win.
    expect(connection.textContent).toContain("Connected");
    expect(dotOf(connection).className).toContain("bg-[var(--kn-ok)]");
    expect(health.className).toContain("text-[var(--kn-danger)]");
    expect(connection.contains(health)).toBe(false);
  });

  it("shows both when an unreachable host has no verdict", () => {
    render(
      <>
        <AgentConnectionIndicator connection="disconnected" data-testid="conn" />
        <HealthBadge health="unknown" />
      </>,
    );

    expect(screen.getByTestId("conn").textContent).toContain("Disconnected");
    expect(badgeOf("Unknown").className).toContain("text-[var(--kn-text-2)]");
  });

  it("never renders health as a connection state, or the reverse", () => {
    const connectionLabels = CONNECTIONS.map((c) => indicator(c).textContent ?? "");
    for (const label of connectionLabels) {
      for (const health of ["Healthy", "Warning", "Critical"]) {
        expect(label).not.toContain(health);
      }
    }
  });
});
