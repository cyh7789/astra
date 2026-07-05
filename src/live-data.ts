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

// WMO weather code → 中文描述（demo 常見碼就夠，其餘落 "多雲時晴"）
const WMO: Record<number, string> = {
  0: "晴朗",
  1: "大致晴朗",
  2: "局部多雲",
  3: "陰天",
  45: "起霧",
  51: "毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  80: "陣雨",
  81: "強陣雨",
  95: "雷雨",
  96: "雷雨夾冰雹",
};

export async function fetchWeather(lat: number, lng: number): Promise<Record<string, unknown>> {
  const data = (await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
      `&current=temperature_2m,weather_code&daily=precipitation_probability_max&forecast_days=1&timezone=auto`,
  )) as {
    current: { temperature_2m: number; weather_code: number };
    daily: { precipitation_probability_max: number[] };
  };
  return {
    ok: true,
    source: "live",
    location: "當前位置",
    condition: WMO[data.current.weather_code] ?? "多雲時晴",
    temperature_c: Math.round(data.current.temperature_2m),
    rain_probability: data.daily.precipitation_probability_max[0] ?? 0,
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
  const filter = tag ? tag.filter : `["name"~"${query.replace(/["\\]/g, "")}"]`;
  const ql = `[out:json][timeout:5];(node${filter}(around:2000,${lat},${lng});way${filter}(around:2000,${lat},${lng}););out center 8;`;
  const data = (await getJson("https://overpass-api.de/api/interpreter", {
    method: "POST",
    body: `data=${encodeURIComponent(ql)}`,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "astra-demo/0.1", // Overpass 沒 UA 回 406
    },
  })) as {
    elements: Array<{
      tags?: Record<string, string>;
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
    }>;
  };
  const results = data.elements
    .filter((e) => e.tags?.name)
    .slice(0, 5)
    .map((e) => {
      const p = e.center ?? { lat: e.lat!, lon: e.lon! };
      const km = haversineKm(lat, lng, p.lat, p.lon);
      return { name: e.tags!.name, distance_km: Math.round(km * 10) / 10 };
    })
    .sort((a, b) => a.distance_km - b.distance_km);
  if (results.length === 0) throw new Error("no poi results"); // 讓呼叫端退 mock，不回空手
  return { ok: true, source: "live", results };
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
  )) as Array<{ lat: string; lon: string; display_name: string }>;
  const hit = geo[0];
  if (!hit) throw new Error(`geocode miss: ${destination}`);
  const route = (await getJson(
    `https://router.project-osrm.org/route/v1/driving/${lng},${lat};${hit.lon},${hit.lat}?overview=false`,
  )) as { routes: Array<{ duration: number; distance: number }> };
  const r = route.routes[0];
  if (!r) throw new Error("no route");
  return {
    eta_minutes: Math.max(1, Math.round(r.duration / 60)),
    distance_km: Math.round(r.distance / 100) / 10,
    maps_url: `https://www.google.com/maps/dir/?api=1&destination=${hit.lat},${hit.lon}&travelmode=driving`,
    resolved: hit.display_name.split(",").slice(0, 2).join(","),
  };
}

/** Web 搜尋：Gemini Google Search grounding（現有金鑰、免另註冊）。
 *  回摘要 + 真實來源；失敗丟出 → 工具層誠實回「不可用」，不做假搜尋結果。 */
export async function webSearch(query: string): Promise<Record<string, unknown>> {
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
