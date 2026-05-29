import { Redis } from '@upstash/redis';

// Upstash automatically detects UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN from environment
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export const config = { runtime: 'edge' };

export default async function handler(req, res) {
  const { searchParams, pathname } = new URL(req.url);
  const method = req.method;

  const query = {
    id: searchParams.get('id'),
    stream: searchParams.get('stream'),
    refresh: searchParams.get('refresh'),
  };

  const PUBLIC_URL = process.env.NEXT_PUBLIC_BASE_URL || `https://${searchParams.host || req.headers.get('host')}`;
  const cleanPathname = pathname.toLowerCase() || "";

  const clientIP =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    "1.1.1.1";

  const PORTAL = "http://dhoomtv.xyz:8080/portal.php";
  const LOGO = "https://cdn.jsdelivr.net/gh/Bckas/logo/logo.png";
  const PREFIX = "[KSP] ";
  const MAX_RATE_LIMIT = 300;

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let user = query.id;
  if (!user || user.trim() === "" || user === "ksp_star") {
    return new Response("Unauthorized Access: Missing or Invalid User ID (?id=username required)", {
      status: 401,
      headers: corsHeaders,
    });
  }

  let streamId = query.stream;
  let isStreamRequest = cleanPathname.includes("live") || !!query.stream;
  const USER_M3U_KEY = `m3u_ultimate_v11_${user}`;

  // Optimized Category Filtering using Set (High Performance)
  const ALLOWED_CATEGORIES = new Set([
    "india hindi movies", "indian news", "amazon movies 24/7", "bhojpuri",
    "bollywood movies/actors", "bollywood movies 24/7", "bollywood singers 24/7",
    "cricket", "hindi web series 24x7", "india documentary", "india entertainment",
    "indian active", "indian sd", "ipl (2026)", "netflix movies 24/7", "punjabi",
    "punjabi movies 24/7", "punjabi singers 24/7", "sports | india",
    "india english movies", "kids", "sports | sports", "india music",
  ]);

  const normalize = (s) =>
    (s || "").toLowerCase().replace(/^\[ksp\]\s*/i, "").replace(/\s+/g, " ").trim();

  const log = (action, msg, level = "INFO") =>
    console.log(`[${level}] [${user}] [IP: ${clientIP}] [${action}] ${msg}`);

  try {
    // --- RATE LIMITER ---
    const rateKey = `rate_${user}_${Math.floor(Date.now() / 60000)}`;
    try {
      let currentRate = parseInt((await redis.get(rateKey)) || "0");
      if (currentRate >= MAX_RATE_LIMIT) {
        log("RATE_LIMIT_HIT", `Blocked due to flood limit: ${currentRate}`);
        return new Response("Too Many Requests/Anti-Flood Triggered", { status: 429, headers: corsHeaders });
      }
      await redis.set(rateKey, (currentRate + 1).toString(), { ex: 60 });
    } catch (e) {
      log("REDIS_RATE_LIMIT_ERR", e.message, "ERROR");
    }

    // --- HARDWARE & DYNAMIC USER AGENT GENERATOR ---
    async function getHardware(username) {
      const hwKey = `hw_v4_${username}`;
      try {
        const hw = await redis.get(hwKey);
        if (hw) return hw;
      } catch (e) {
        log("REDIS_HW_GET_ERR", e.message, "ERROR");
      }

      const enc = new TextEncoder();
      const hashBuf = await crypto.subtle.digest("SHA-256", enc.encode(username));
      const hash = Array.from(new Uint8Array(hashBuf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("").toUpperCase();

      const microVersion = (parseInt(hash.substr(0, 2), 16) % 20) + 5; 
      const extHardware = {
        mac: `00:1A:79:${hash.substr(0, 2)}:${hash.substr(2, 2)}:${hash.substr(4, 2)}`,
        sn: `142514D${hash.substr(10, 8)}`,
        device_id: hash.substr(0, 32),
        ua: `MacC_STB_Emulator/Mozilla/5.0 (QtEmbedded; MAG254; Linux 2.6.23; r${microVersion}-254)`,
        xua: `Model: MAG254; SW: 2.18-r${microVersion}-254`
      };

      try {
        await redis.set(hwKey, JSON.stringify(extHardware));
      } catch (e) {
        log("REDIS_HW_SET_ERR", e.message, "ERROR");
      }
      return extHardware;
    }

    const rawHw = await getHardware(user);
    const hw = typeof rawHw === 'string' ? JSON.parse(rawHw) : rawHw;

    const baseHeaders = {
      "User-Agent": hw.ua || "MacC_STB_Emulator/Mozilla/5.0 (QtEmbedded; MAG254; Linux 2.6.23)",
      "X-User-Agent": hw.xua || "Model: MAG254; SW: 2.18-r14-254",
      "X-MAC": hw.mac,
      "X-SN": hw.sn,
      "X-Forwarded-For": clientIP,
      "X-Real-IP": clientIP,
      Referer: "http://dhoomtv.xyz:8080/",
      Accept: "*/*",
    };

    async function fetchDirect(target, headers, timeout = 9000) {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(target, { 
          headers: { ...headers, "Connection": "keep-alive" }, 
          signal: controller.signal 
        });
        
        // AGAR PORTAL 401 UNAUTHORIZED DETA HAI, TO APNA APNI TARAF SE BHI ERROR THROW KARENGE TAAKI NAYA TOKEN BAN SAKE
        if (response.status === 401) throw new Error("HTTP_401_UNAUTHORIZED");
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        
        const text = (await response.text()).trim();
        if (text.startsWith("{") || text.startsWith("[")) {
          try { return JSON.parse(text); } catch { return null; }
        }
        return text;
      } catch (e) {
        log("PORTAL_FETCH_ERR", e.message, "ERROR");
        if (e.message === "HTTP_401_UNAUTHORIZED") return "AUTH_RESET";
        return null;
      } finally {
        clearTimeout(tid);
      }
    }

    // --- STRICT TOKEN MANAGER (FIXED TTL) ---
    async function getToken(force = false) {
      const key = `token_v3_${user}`;
      if (!force) {
        try {
          const token = await redis.get(key);
          if (token) return token;
        } catch (e) { log("REDIS_TOKEN_GET_ERR", e.message, "ERROR"); }
      }

      log("PORTAL_HANDSHAKE", "Fetching fresh token from Portal...");
      const handshake = await fetchDirect(`${PORTAL}?type=stb&action=handshake&JsHttpRequest=1-xml`, baseHeaders);
      let t = handshake?.js?.token;

      if (t) {
        try { 
          // FIXED: Expiry ko 3600s se ghata kar 1200s (20 mins) kar diya hai taaki token hamesha active/fresh rahe
          await redis.set(key, t, { ex: 1200 }); 
        } catch (e) { log("REDIS_TOKEN_SET_ERR", e.message, "ERROR"); }
        
        fetchDirect(`${PORTAL}?type=stb&action=get_profile&JsHttpRequest=1-xml`, {
          ...baseHeaders,
          Authorization: `Bearer ${t}`,
        }).catch(() => {});
      }
      return t;
    }

    if (query.refresh) {
      try {
        await redis.del(`token_v3_${user}`);
        await redis.del(USER_M3U_KEY);
        log("CACHE_REFRESH", "Flushed tokens and playlist cache manually.");
      } catch (e) { log("REDIS_DEL_ERR", e.message, "ERROR"); }
    }

    let token = await getToken();
    if (!token) {
      token = await getToken(true);
      if (!token) {
        return new Response("Portal Auth Failed", { status: 401, headers: corsHeaders });
      }
    }

    // --- STREAM REQUEST ---
    if (isStreamRequest && streamId) {
      const api = `${PORTAL}?type=itv&action=create_link&cmd=http://localhost/ch/${streamId}&JsHttpRequest=1-xml`;
      let data = await fetchDirect(api, { ...baseHeaders, Authorization: `Bearer ${token}` });
      
      // AUTO RELOAD LOGIC: Agar portal ne token reject kiya (AUTH_RESET), to usi waqt turant naya token generate hoga
      if (data === "AUTH_RESET" || !data?.js?.cmd) {
        log("TOKEN_EXPIRED_DETECTED", "Old token rejected by portal. Regenerating immediately...", "WARN");
        token = await getToken(true);
        data = await fetchDirect(api, { ...baseHeaders, Authorization: `Bearer ${token}` });
      }

      let raw = data?.js?.cmd || data?.js || "";
      let streamUrl = raw.match(/https?:\/\/[^\s"'\\]+/)?.[0];

      if (!streamUrl) return new Response("Stream Generation Failed", { status: 403, headers: corsHeaders });

      log("STREAM_REDIRECT_SUCCESS", `Redirected stream ID: ${streamId}`);
      return Response.redirect(streamUrl, 302);
    }

    // --- LOCKED M3U CACHE LOGIC WITH FALLBACK ---
    let cachedM3U = null;
    try {
      cachedM3U = await redis.get(USER_M3U_KEY);
    } catch (e) { log("REDIS_M3U_GET_ERR", e.message, "ERROR"); }

    if (cachedM3U && cachedM3U.length > 500) {
      log("M3U_CACHE_HIT", "Serving playlist directly from locked Upstash cache");
      return new Response(cachedM3U, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/mpegurl; charset=utf-8" }
      });
    }

    log("M3U_CACHE_MISS", "Generating fresh playlist from portal...");
    
    let genreData = await fetchDirect(`${PORTAL}?type=itv&action=get_genres&JsHttpRequest=1-xml`, {
      ...baseHeaders,
      Authorization: `Bearer ${token}`,
    });

    let chData = await fetchDirect(`${PORTAL}?type=itv&action=get_all_channels&JsHttpRequest=1-xml`, {
      ...baseHeaders,
      Authorization: `Bearer ${token}`,
    });

    if (genreData === "AUTH_RESET" || chData === "AUTH_RESET") {
      token = await getToken(true);
      const [rGen, rCh] = await Promise.all([
        fetchDirect(`${PORTAL}?type=itv&action=get_genres&JsHttpRequest=1-xml`, { ...baseHeaders, Authorization: `Bearer ${token}` }),
        fetchDirect(`${PORTAL}?type=itv&action=get_all_channels&JsHttpRequest=1-xml`, { ...baseHeaders, Authorization: `Bearer ${token}` }),
      ]);
      genreData = rGen;
      chData = rCh;
    }

    let channels = chData?.js?.data || chData?.js || [];

    // FALLBACK SAFETY
    if (!channels || channels.length === 0) {
      if (cachedM3U) {
        log("PORTAL_DOWN_FALLBACK", "Portal empty/down! Serving expired stale cache to save user uptime.", "WARN");
        return new Response(cachedM3U, {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/mpegurl; charset=utf-8" }
        });
      }
      return new Response("Portal Empty or Down", { status: 503, headers: corsHeaders });
    }

    let genres = {};
    if (genreData?.js && Array.isArray(genreData.js)) {
      genreData.js.forEach((g) => { genres[g.id] = `${PREFIX}${g.title || g.name}`; });
    }

    let m3uLines = ['#EXTM3U x-tvg-url="http://dhoomtv.xyz:8080/xmltv.php"'];
    channels.forEach((c) => {
      if (!c.id || !c.name) return;
      let groupTitle = genres[c.tv_genre_id || c.genre_id] || `${PREFIX}General`;
      let cleanGroup = normalize(groupTitle);
      
      if (!ALLOWED_CATEGORIES.has(cleanGroup)) return;

      let line = `#EXTINF:-1 tvg-id="${c.id}" tvg-name="${c.name}" tvg-logo="${LOGO}" group-title="${groupTitle}",${c.name}\n${PUBLIC_URL}/api/live?id=${user}&stream=${c.id}`;
      m3uLines.push(line);
    });

    let m3u = m3uLines.join("\n") + "\n";

    if (m3uLines.length > 1) {
      try {
        const randomExpiry = 82800 + Math.floor(Math.random() * 7200); 
        await redis.set(USER_M3U_KEY, m3u, { ex: randomExpiry });
        log("M3U_CACHE_SET_SUCCESS", `Cached ${m3uLines.length - 1} channels with TTL: ${randomExpiry}s`);
      } catch (redisErr) { log("REDIS_M3U_SET_ERR", redisErr.message, "ERROR"); }
    }

    return new Response(m3u, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/mpegurl; charset=utf-8" }
    });

  } catch (e) {
    log("FATAL_COMMERCIAL_ERROR", e.message, "ERROR");
    return new Response("System Error", { status: 500, headers: corsHeaders });
  }
}