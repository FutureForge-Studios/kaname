import { describe, expect, it } from "vitest";
import { nextActiveAfterClose, type Tab } from "./tabs";

const tabs: Tab[] = ["a", "b", "c"].map((id) => ({ id, kind: "fleet", connectionId: id }));

describe("nextActiveAfterClose", () => {
  it("keeps the active tab when another one closes", () => {
    expect(nextActiveAfterClose(tabs, "a", "b")).toBe("b");
  });
  it("activates the right neighbour, else the left", () => {
    expect(nextActiveAfterClose(tabs, "b", "b")).toBe("c");
    expect(nextActiveAfterClose(tabs, "c", "c")).toBe("b");
  });
  it("returns null when the last tab closes", () => {
    expect(nextActiveAfterClose([tabs[0]!], "a", "a")).toBeNull();
  });
});
