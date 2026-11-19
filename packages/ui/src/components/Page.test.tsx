import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./Button.js";
import { SectionHeader } from "./Editorial.js";
import { PageHeader, ResourceHeader, SectionCard } from "./Page.js";

/* ------------------------------------------------------------------ *
 * KD-044: the old props stay accepted so no page breaks, but numbers,
 * eyebrow chips and trailing arrows no longer render, and ResourceHeader
 * can carry a status line (it replaces DetailHeader).
 * ------------------------------------------------------------------ */

describe("KD-044 page chrome", () => {
  it("ignores the section index", () => {
    const { container } = render(
      <>
        <SectionHeader index={1} title="Domains" />
        <SectionCard index={2} title="Volumes" />
      </>,
    );
    expect(container.textContent).not.toMatch(/0[12]/);
    expect(screen.getByRole("heading", { name: "Domains" })).toBeTruthy();
  });

  it("does not render the PageHeader eyebrow", () => {
    render(<PageHeader eyebrow="Studio" title="Servers" />);
    expect(screen.queryByText("Studio")).toBeNull();
  });

  it("renders the ResourceHeader status line", () => {
    render(<ResourceHeader name="web-1" status={<p>Agent online</p>} />);
    expect(screen.getByText("Agent online")).toBeTruthy();
  });

  it("renders no trailing arrow and is not a pill", () => {
    render(
      <Button arrow variant="primary">
        Continue
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Continue" });
    expect(button.querySelector("svg")).toBeNull();
    expect(button.className).not.toContain("kn-r-pill");
    expect(button.className).not.toContain("rounded-full");
  });
});
