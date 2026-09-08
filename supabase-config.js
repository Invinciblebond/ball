/* ──────────────────────────────────────────────────────────────
   Urlsify — Supabase configuration
   The publishable key below is safe to expose — it only identifies
   the project. Row Level Security is what actually enforces access.
   Rotate it at: Project Settings → API → Project API keys
   ────────────────────────────────────────────────────────────── */
window.URLSIFY_CONFIG = {
  SUPABASE_URL: 'https://ytvyhkhzewnultjfpcyf.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_9Fg9_ngt8RZPi20RHmrG5A_Ct9fVGuR',
  API_BASE: 'https://urlsify.com',          // public shortener worker (stats)
  DASH_BASE: 'https://urlsify.com/api/dash', // account-only dashboard worker
  SITE_URL: 'https://urlsify.com'
};

/* Loads supabase-js from CDN and returns a client. Cached per page. */
window.getSupabase = (function () {
  let clientPromise = null;
  return function () {
    if (clientPromise) return clientPromise;
    clientPromise = new Promise((resolve, reject) => {
      if (window.supabase && window.supabase.createClient) return resolve(mk());
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
      s.async = true;
      s.onload = () => resolve(mk());
      s.onerror = () => reject(new Error('supabase-js failed to load'));
      document.head.appendChild(s);
    });
    return clientPromise;

    function mk() {
      const c = window.URLSIFY_CONFIG;
      return window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'urlsify-auth'
        }
      });
    }
  };
})();
