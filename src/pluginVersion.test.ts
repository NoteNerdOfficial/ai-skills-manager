import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ requestUrl: vi.fn() }));

import { compareVersions, versionStatus } from "./pluginVersion";

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.1.14", "0.2.0")).toBeLessThan(0);
    expect(compareVersions("v1.0", "1.0.0")).toBe(0);
  });
});

describe("versionStatus", () => {
  it("flags only a newer release", () => {
    expect(versionStatus("0.1.14", "0.1.15")).toEqual({ state: "outdated", installed: "0.1.14", latest: "0.1.15" });
    expect(versionStatus("0.1.15", "0.1.14").state).toBe("current");
    expect(versionStatus("0.1.14", null).state).toBe("unknown");
  });
});
