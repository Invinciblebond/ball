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
      const body = await request.json();
      const longUrl = body.url;
      const customSlug = body.slug?.trim().toLowerCase();

      try { new URL(longUrl); } catch {
        return Response.json({ error: "Invalid URL" }, { status: 400, headers: cors });
      }

      // ── custom slug path ──
      if (customSlug) {
        // validate: only letters, numbers, hyphens, underscores, 3-30 chars
        if (!/^[a-z0-9_-]{3,30}$/.test(customSlug)) {
          return Response.json(
            { error: "Custom slug must be 3–30 characters and only contain letters, numbers, hyphens, or underscores." },
            { status: 400, headers: cors }
          );
        }

        // block reserved paths
        const reserved = ["api", "admin", "stats", "shorten", "health"];
        if (reserved.includes(customSlug)) {
          return Response.json(
            { error: "That slug is reserved. Please choose another." },
            { status: 400, headers: cors }
          );
        }

        // check if already taken
        const existing = await env.LINKS.get(customSlug);
        if (existing) {
          return Response.json(
            { error: "That custom link is already taken. Try another." },
            { status: 409, headers: cors }
          );
        }

        await env.LINKS.put(customSlug, longUrl, { expirationTtl: 60 * 60 * 24 * 365 });
        await env.LINKS.put(`clicks:${customSlug}`, "0", { expirationTtl: 60 * 60 * 24 * 365 });

        return Response.json(
          { short: `https://urlsify.com/${customSlug}`, code: customSlug },
          { headers: cors }
        );
      }

      // ── random slug path ──
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

      const countriesRaw = await env.LINKS.get(`countries:${code}`);
      const countries = countriesRaw ? JSON.parse(countriesRaw) : {};

      const browsersRaw = await env.LINKS.get(`browsers:${code}`);
      const browsers = browsersRaw ? JSON.parse(browsersRaw) : {};

      const devicesRaw = await env.LINKS.get(`devices:${code}`);
      const devices = devicesRaw ? JSON.parse(devicesRaw) : {};

      const referrersRaw = await env.LINKS.get(`referrers:${code}`);
      const referrers = referrersRaw ? JSON.parse(referrersRaw) : {};

      return Response.json({
        code,
        short: `https://urlsify.com/${code}`,
        destination: longUrl,
        clicks: parseInt(clicks),
        countries: sortedTop(countries, 5),
        browsers: sortedTop(browsers, 5),
        devices: sortedTop(devices, 3),
        referrers: sortedTop(referrers, 5),
      }, { headers: cors });
    }

    // ── Redirect: GET /abc123 ─────────────────────────────────────
    if (path.length > 1 && path !== "/") {
      // Let static files pass through to assets
      if (/\.(ico|png|jpg|jpeg|svg|webp|css|js|json|txt|xml|webmanifest)$/.test(path)) {
        return fetch(request);
      }

      const code = path.slice(1);
      const longUrl = await env.LINKS.get(code);

      if (longUrl) {
        const current = await env.LINKS.get(`clicks:${code}`) ?? "0";
        await env.LINKS.put(`clicks:${code}`, String(parseInt(current) + 1), {
          expirationTtl: 60 * 60 * 24 * 365
        });

        const country = request.cf?.country ?? "Unknown";
        await incrementJson(env, `countries:${code}`, country);

        const ua = request.headers.get("user-agent") ?? "";
        const browser = parseBrowser(ua);
        const device = parseDevice(ua);
        await incrementJson(env, `browsers:${code}`, browser);
        await incrementJson(env, `devices:${code}`, device);

        const refHeader = request.headers.get("referer") ?? "";
        const referrer = parseReferrer(refHeader);
        await incrementJson(env, `referrers:${code}`, referrer);

        return Response.redirect(longUrl, 302);
      } else {
        return new Response("Link not found", { status: 404 });
      }
    }

    // ── Fallback ──────────────────────────────────────────────────
    return fetch(request);
  }
};

// ── Helpers ───────────────────────────────────────────────────────

async function incrementJson(env, kvKey, field) {
  const raw = await env.LINKS.get(kvKey);
  const obj = raw ? JSON.parse(raw) : {};
  obj[field] = (obj[field] ?? 0) + 1;
  await env.LINKS.put(kvKey, JSON.stringify(obj), {
    expirationTtl: 60 * 60 * 24 * 365
  });
}

function sortedTop(obj, n) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, count]) => ({ name, count }));
}

function parseBrowser(ua) {
  if (/Edg\//i.test(ua))        return "Edge";
  if (/OPR\//i.test(ua))        return "Opera";
  if (/Chrome\//i.test(ua))     return "Chrome";
  if (/Firefox\//i.test(ua))    return "Firefox";
  if (/Safari\//i.test(ua))     return "Safari";
  if (/MSIE|Trident/i.test(ua)) return "Internet Explorer";
  return "Other";
}

function parseDevice(ua) {
  if (/tablet|ipad/i.test(ua))                 return "Tablet";
  if (/mobile|iphone|android|phone/i.test(ua)) return "Mobile";
  return "Desktop";
}

function parseReferrer(ref) {
  if (!ref) return "Direct";
  try {
    const host = new URL(ref).hostname.replace(/^www\./, "");
    if (host.includes("google"))                        return "Google";
    if (host.includes("twitter") || host.includes("t.co")) return "Twitter / X";
    if (host.includes("facebook"))                      return "Facebook";
    if (host.includes("instagram"))                     return "Instagram";
    if (host.includes("linkedin"))                      return "LinkedIn";
    if (host.includes("reddit"))                        return "Reddit";
    if (host.includes("whatsapp"))                      return "WhatsApp";
    return host;
  } catch {
    return "Direct";
  }
}

function randomCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}