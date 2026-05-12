export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

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

      try { new URL(longUrl); } catch {
        return Response.json({ error: "Invalid URL" }, { status: 400, headers: cors });
      }

      let code;
      for (let i = 0; i < 5; i++) {
        code = randomCode();
        const existing = await env.LINKS.get(code);
        if (!existing) break;
      }

      await env.LINKS.put(code, longUrl, { expirationTtl: 60 * 60 * 24 * 365 });
      await env.LINKS.put(`clicks:${code}`, "0", { expirationTtl: 60 * 60 * 24 * 365 });

      return Response.json(
        { short: `https://urlsify.com/${code}`, code },
        { headers: cors }
      );
    }

    // ── API: GET /api/stats/:code ─────────────────────────────────
    if (path.startsWith("/api/stats/") && request.method === "GET") {
      const code = path.slice("/api/stats/".length);
      const longUrl = await env.LINKS.get(code);

      if (!longUrl) {
        return Response.json({ error: "Link not found" }, { status: 404, headers: cors });
      }

      const clicks = await env.LINKS.get(`clicks:${code}`) ?? "0";

      return Response.json(
        { code, short: `https://urlsify.com/${code}`, destination: longUrl, clicks: parseInt(clicks) },
        { headers: cors }
      );
    }

    // ── Redirect: GET /abc123 ─────────────────────────────────────
    if (path.length > 1 && path !== "/") {
      const code = path.slice(1);
      const longUrl = await env.LINKS.get(code);

      if (longUrl) {
        const current = await env.LINKS.get(`clicks:${code}`) ?? "0";
        await env.LINKS.put(`clicks:${code}`, String(parseInt(current) + 1), {
          expirationTtl: 60 * 60 * 24 * 365
        });

        return Response.redirect(longUrl, 302);
      } else {
        return new Response("Link not found", { status: 404 });
      }
    }

    // ── Fallback: pass through to origin ──────────────────────────
    return fetch(request);
  }
};

function randomCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}