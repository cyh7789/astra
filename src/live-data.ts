/** 查詢類工具的真實資料層 — 全部免金鑰公開 API，失敗一律丟出讓呼叫端退 mock（demo 不能死在別人服務上）。
 *  - 天氣：Open-Meteo
 *  - POI：OSM Overpass
 *  - 路線：OSM Nominatim（地理編碼）+ OSRM demo server（路徑），附 Google Maps 直開連結
 */

const FETCH_TIMEOUT_MS = 6_000;

async function getJson(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// WMO weather code → 中文描述。未識別的碼不硬猜成「多雲時晴」（devin：合歡山下雪顯示晴天更假），
// 落「天氣代碼 X」讓使用者知道是未歸類狀態。
const WMO: Record<number, string> = {
  0: "晴朗",
  1: "大致晴朗",
  2: "局部多雲",
  3: "陰天",
  45: "起霧",
  48: "霧淞",
  51: "毛毛雨",
  53: "毛毛雨",
  55: "強毛毛雨",
  56: "凍毛毛雨",
  57: "強凍毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "凍雨",
  67: "強凍雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "陣雨",
  81: "強陣雨",
  82: "劇烈陣雨",
  85: "陣雪",
  86: "強陣雪",
  95: "雷雨",
  96: "雷雨夾冰雹",
  99: "強雷雨冰雹",
};

export async function fetchWeather(lat: number, lng: number): Promise<Record<string, unknown>> {
  const data = (await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,weather_code&daily=precipitation_probability_max&forecast_days=1&timezone=auto`,
  )) as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: { precipitation_probability_max?: number[] };
  };
  // 結構/數值驗證：schema 變動或缺欄位時 throw 讓呼叫端退 mock，不餵 NaN 進結果（devin P0/P1）
  const temp = data?.current?.temperature_2m;
  if (typeof temp !== "number" || !Number.isFinite(temp)) throw new Error("weather: bad temperature");
  const code = data.current!.weather_code;
  const pp = data?.daily?.precipitation_probability_max;
  return {
    ok: true,
    source: "live",
    location: "當前位置",
    condition: typeof code === "number" ? (WMO[code] ?? `天氣代碼 ${code}`) : "未知",
    temperature_c: Math.round(temp),
    rain_probability: Array.isArray(pp) && typeof pp[0] === "number" ? pp[0] : 0,
  };
}

/** 常見口語搜尋詞 → Overpass 標籤（demo 場景會用到的就夠；未知詞退 name 模糊比對） */
const POI_TAGS: Array<{ re: RegExp; filter: string }> = [
  { re: /早餐|breakfast/i, filter: '["cuisine"~"breakfast"]' },
  { re: /加油|gas|fuel/i, filter: '["amenity"="fuel"]' },
  { re: /咖啡|coffee|cafe/i, filter: '["amenity"="cafe"]' },
  { re: /超商|便利|convenience/i, filter: '["shop"="convenience"]' },
  { re: /藥局|pharmacy/i, filter: '["amenity"="pharmacy"]' },
  { re: /停車|parking/i, filter: '["amenity"="parking"]' },
  { re: /餐廳|restaurant|吃/i, filter: '["amenity"="restaurant"]' },
];

export async function searchPoi(
  query: string,
  lat: number,
  lng: number,
): Promise<Record<string, unknown>> {
  const tag = POI_TAGS.find((t) => t.re.test(query));
  // 白名單字元集 — query 來自模型轉述的使用者語句，QL 特殊字元（];>( 等）可構造注入。
  // 再跳脫 regex 元字元（. 在 ~ regex 是任意字元，會誤命中）（devin P2）。
  const safe = query.replace(/[^一-鿿\w\s.-]/g, "").trim().replace(/[.\\]/g, "\\$&");
  if (!tag && !safe) throw new Error("query unusable after sanitize");
  const filter = tag ? tag.filter : `["name"~"${safe}"]`;

  // 郊區/山區 OSM 密度低，2km 常空手 → 退 mock 就穿幫「怎麼都在建國路」；空手時放大到 8km 再試（devin P1）
  const query1 = await overpassAround(filter, lat, lng, 2000);
  const elements = query1.length > 0 ? query1 : await overpassAround(filter, lat, lng, 8000);

  const results = elements
    .map((e) => {
      const p = e.center ?? { lat: e.lat, lon: e.lon };
      if (!e.tags?.name || typeof p.lat !== "number" || typeof p.lon !== "number") return null;
      const km = haversineKm(lat, lng, p.lat, p.lon);
      return Number.isFinite(km) ? { name: e.tags.name, distance_km: Math.round(km * 10) / 10 } : null;
    })
    .filter((x): x is { name: string; distance_km: number } => x !== null)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, 5);
  if (results.length === 0) throw new Error("no poi results"); // 讓呼叫端退 mock，不回空手
  return { ok: true, source: "live", results };
}

interface OverpassElement {
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
}

async function overpassAround(
  filter: string,
  lat: number,
  lng: number,
  radius: number,
): Promise<OverpassElement[]> {
  const ql = `[out:json][timeout:5];(node${filter}(around:${radius},${lat},${lng});way${filter}(around:${radius},${lat},${lng}););out center 8;`;
  const data = (await getJson("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: `data=${encodeURIComponent(ql)}`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "astra-demo/0.1", // Overpass 沒 UA 回 406
    },
  })) as { elements?: OverpassElement[] };
  return Array.isArray(data?.elements) ? data.elements : [];
}

export interface LiveRoute {
  eta_minutes: number;
  distance_km: number;
  maps_url: string;
  resolved: string;
}

/** 目的地地理編碼 + 路線。查不到（世界觀地點如「公司」）丟錯讓呼叫端退 mock。 */
export async function fetchRoute(destination: string, lat: number, lng: number): Promise<LiveRoute> {
  const geo = (await getJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=zh-TW` +
      // viewbox 偏向使用者附近的同名地點（例如多個「家樂福」）
      `&viewbox=${lng - 0.5},${lat + 0.5},${lng + 0.5},${lat - 0.5}` +
      `&q=${encodeURIComponent(destination)}`,
    { headers: { "User-Agent": "astra-demo/0.1" } },
  )) as Array<{ lat?: string; lon?: string; display_name?: string }>;
  const hit = Array.isArray(geo) ? geo[0] : undefined;
  if (!hit?.lat || !hit?.lon) throw new Error(`geocode miss: ${destination}`);
  const route = (await getJson(
    `https://router.project-osrm.org/route/v1/driving/${lng},${lat};${hit.lon},${hit.lat}?overview=false`,
  )) as { routes?: Array<{ duration?: number; distance?: number }> };
  // OSRM 過載回 {code:"TooManyQueries"} 無 routes、跨海回 NoRoute — optional chain + 數值驗證退 mock
  const r = route?.routes?.[0];
  if (!r || typeof r.duration !== "number" || typeof r.distance !== "number") {
    throw new Error("no route");
  }
  return {
    eta_minutes: Math.max(1, Math.round(r.duration / 60)),
    distance_km: Math.round(r.distance / 100) / 10,
    maps_url: `https://www.google.com/maps/dir/?api=1&destination=${hit.lat},${hit.lon}&travelmode=driving`,
    resolved: (hit.display_name ?? `${hit.lat},${hit.lon}`).split(",").slice(0, 2).join(","),
  };
}

/** Web 搜尋：Gemini Google Search grounding（現有金鑰、免另註冊）。
 *  回摘要 + 真實來源；失敗丟出 → 工具層誠實回「不可用」，不做假搜尋結果。 */
export async function webSearch(query: string): Promise<Record<string, unknown>> {
  // 明確區分「沒設金鑰」與「額度爆」— 否則 400 錯誤在 demo 時會被誤判成額度問題（devin P2）
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY missing");
  const model = process.env.GEMINI_SEARCH_MODEL ?? "gemini-3.5-flash";
  const data = (await getJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  `Search the web and answer concisely in the user's language (2-3 sentences max): ${query}`,
              },
            ],
          },
        ],
        tools: [{ google_search: {} }],
      }),
    },
    15_000, // 搜尋 + 生成比一般查詢慢
  )) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: { title?: string; uri?: string } }>;
      };
    }>;
  };
  const c = data.candidates?.[0];
  const answer = (c?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!answer) throw new Error("empty search answer");
  const sources = (c?.groundingMetadata?.groundingChunks ?? [])
    .map((ch) => ch.web?.title)
    .filter(Boolean)
    .slice(0, 3);
  return { ok: true, source: "live", answer, sources };
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(a));
}
