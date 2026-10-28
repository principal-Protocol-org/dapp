import { afterEach, describe, expect, it, vi } from "vitest";
import { readSession, writeSession } from "../session";

describe("wallet session", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("defaults to connected when nothing is stored", () => {
    expect(readSession()).toEqual({ connected: true });
  });

  it("round-trips under the pp-wallet key", () => {
    writeSession({ connected: false });
    expect(localStorage.getItem("pp-wallet")).toBe(JSON.stringify({ connected: false }));
    expect(readSession()).toEqual({ connected: false });
  });

  it("ignores malformed stored values", () => {
    localStorage.setItem("pp-wallet", "{not json");
    expect(readSession()).toEqual({ connected: true });
    localStorage.setItem("pp-wallet", JSON.stringify({ connected: "no" }));
    expect(readSession()).toEqual({ connected: true });
  });

  it("does not throw when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSession()).toEqual({ connected: true });
    expect(() => writeSession({ connected: true })).not.toThrow();
  });
});
