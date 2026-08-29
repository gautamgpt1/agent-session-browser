import type { RequestHandler } from "express";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function localOnlySecurity(port: number, isDev: boolean): RequestHandler {
  return (req, res, next) => {
    const authority = req.get("host") || "";
    if (!isLoopbackAuthority(authority)) {
      res.status(403).json({ error: "Agent Session Browser only accepts loopback requests" });
      return;
    }

    const origin = req.get("origin");
    if (origin && !isSameOrigin(origin, authority)) {
      res.status(403).json({ error: "Cross-origin requests are not allowed" });
      return;
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(port, isDev));
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  };
}

export function isLoopbackAuthority(authority: string): boolean {
  try {
    const url = new URL(`http://${authority}`);
    return url.username === "" && url.password === "" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isSameOrigin(origin: string, authority: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === "http:" &&
      url.host.toLowerCase() === authority.toLowerCase() &&
      isLoopbackAuthority(url.host);
  } catch {
    return false;
  }
}

function contentSecurityPolicy(port: number, isDev: boolean): string {
  const connect = isDev
    ? `connect-src 'self' ws://127.0.0.1:${port + 10_000} ws://localhost:${port + 10_000}`
    : "connect-src 'self'";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    isDev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    isDev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    connect
  ].join("; ");
}
