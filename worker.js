export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname; // e.g. "/abc123" or "/api/shorten"

    // ── CORS helper ──────────────────────────────────────────────
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── API: POST /api/shorten ────────────────────────────────────
    if (path === "/api/shorten" && request.method === "POST") {
      const { url: longUrl } = await request.json();

      // Basic validation
      try { new URL(longUrl); } catch {
        return Response.json({ error: "Invalid URL" }, { status: 400, headers: cors });
      }

      // Generate a 6-char code, retry if collision (rare)
      let code;
      for (let i = 0; i < 5; i++) {
        code = randomCode();
        const existing = await env.LINKS.get(code);
        if (!existing) break;
      }

      // Store with optional 1-year expiry
      await env.LINKS.put(code, longUrl, { expirationTtl: 60 * 60 * 24 * 365 });

      return Response.json(
        { short: `https://urlsify.com/${code}`, code },
        { headers: cors }
      );
    }

    // ── Redirect: GET /abc123 ─────────────────────────────────────
    if (path.length > 1 && path !== "/") {
      const code = path.slice(1); // strip leading /
      const longUrl = await env.LINKS.get(code);

      if (longUrl) {
        return Response.redirect(longUrl, 302);
      } else {
        return new Response("Link not found", { status: 404 });
      }
    }

    // ── Fallback: serve nothing (your main site is separate) ──────
    return new Response("urlsify worker", { status: 200 });
  }
};

function randomCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}