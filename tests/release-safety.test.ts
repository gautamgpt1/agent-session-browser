import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDataRoot } from "../src/server/config.js";
import { isLoopbackAuthority, isSameOrigin } from "../src/server/security.js";
import { availableTuiBodyRows, sanitizeTuiText, tuiFrameLayout, tuiPageStep, tuiWidthLayout, visibleTuiView, wrapTuiSegments, wrapTuiSourceText, wrapTuiText } from "../src/tui/layout.js";

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

  it("keeps short TUI frames within the real terminal height", () => {
    expect(tuiFrameLayout(10)).toEqual({ height: 10, bodyRows: 5, showShortcuts: true, showStatus: true });
    expect(tuiFrameLayout(6)).toEqual({ height: 6, bodyRows: 2, showShortcuts: false, showStatus: true });
    expect(tuiFrameLayout(3)).toEqual({ height: 3, bodyRows: 0, showShortcuts: false, showStatus: true });
  });

  it("uses one focused pane when the terminal is too narrow", () => {
    expect(tuiWidthLayout(120)).toEqual({ width: 119, twoPane: true });
    expect(tuiWidthLayout(72)).toEqual({ width: 71, twoPane: false });
    expect(tuiWidthLayout(40)).toEqual({ width: 39, twoPane: false });
  });

  it("wraps complete TUI footer text and charges those lines to the body", () => {
    const wrapped = wrapTuiText("\x1b[2m123456789\x1b[0m", 4);
    expect(wrapped.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual(["1234", "5678", "9"]);
    expect(availableTuiBodyRows(10, 7)).toBe(2);
    expect(availableTuiBodyRows(10, 9)).toBe(0);
  });

  it("neutralizes stored terminal controls before wrapping transcript text", () => {
    const source = "first\r\nsecond\rthird\tfourth\x1b[2J\x07";
    expect(sanitizeTuiText(source)).toBe("first\nsecond\nthird    fourth[2J");
    const wrapped = wrapTuiSourceText(source, 8);
    expect(wrapped).toEqual(["first", "second", "third   ", " fourth[", "2J"]);
    expect(wrapped.every((line) => line.length <= 8 && !/[\r\t\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(line))).toBe(true);
  });

  it("moves complete shortcut entries to the next footer line", () => {
    expect(wrapTuiSegments(["left pane", "ctrl+e export", "esc quit"], 20)).toEqual([
      "left pane",
      "ctrl+e export",
      "esc quit"
    ]);
  });

  it("supports explicit pane views while collapsing both panes at narrow widths", () => {
    expect(visibleTuiView("both", true, "sessions")).toBe("both");
    expect(visibleTuiView("both", false, "transcript")).toBe("transcript");
    expect(visibleTuiView("sessions", true, "transcript")).toBe("sessions");
    expect(visibleTuiView("transcript", true, "sessions")).toBe("transcript");
  });

  it("pages by the currently visible pane height", () => {
    expect(tuiPageStep(12, "sessions")).toBe(12);
    expect(tuiPageStep(12, "transcript")).toBe(8);
    expect(tuiPageStep(3, "transcript")).toBe(1);
  });
});
