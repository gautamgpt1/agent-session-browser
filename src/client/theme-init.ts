try {
  const stored = localStorage.getItem("agent-session-browser-theme");
  const theme = stored === "light" || stored === "dark"
    ? stored
    : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
} catch {
  // Storage can be unavailable in hardened browser contexts.
}
