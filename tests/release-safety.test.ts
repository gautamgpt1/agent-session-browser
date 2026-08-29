import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataRoot } from "../src/server/config.js";
import { isLoopbackAuthority, isSameOrigin } from "../src/server/security.js";

describe("release security and portability", () => {
  it("accepts loopback authorities and rejects remote or ambiguous hosts", () => {
    expect(isLoopbackAuthority("127.0.0.1:4173")).toBe(true);
    expect(isLoopbackAuthority("localhost:4173")).toBe(true);
    expect(isLoopbackAuthority("[::1]:4173")).toBe(true);
    expect(isLoopbackAuthority("example.com:4173")).toBe(false);
    expect(isLoopbackAuthority("localhost.example.com:4173")).toBe(false);
    expect(isLoopbackAuthority("user@localhost:4173")).toBe(false);
  });

  it("requires browser origins to match the request authority", () => {
    expect(isSameOrigin("http://127.0.0.1:4173", "127.0.0.1:4173")).toBe(true);
    expect(isSameOrigin("http://localhost:4173", "127.0.0.1:4173")).toBe(false);
    expect(isSameOrigin("https://example.com", "127.0.0.1:4173")).toBe(false);
    expect(isSameOrigin("null", "127.0.0.1:4173")).toBe(false);
  });

  it("uses conventional per-user data directories on each desktop platform", () => {
    expect(defaultDataRoot("win32", "C:\\Users\\test", { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }))
      .toBe(path.win32.join("C:\\Users\\test\\AppData\\Local", "Agent Session Browser"));
    expect(defaultDataRoot("darwin", "/Users/test", {})).toBe(path.posix.join("/Users/test", "Library", "Application Support", "Agent Session Browser"));
    expect(defaultDataRoot("linux", "/home/test", {})).toBe(path.posix.join("/home/test", ".local", "share", "agent-session-browser"));
    expect(defaultDataRoot("linux", "/home/test", { XDG_DATA_HOME: "/data" })).toBe(path.posix.join("/data", "agent-session-browser"));
  });
});
