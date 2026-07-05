import { useEffect, useState } from "react";

/** 瀏覽器 GPS：拿得到 → 查詢類工具打真 API；拿不到 → 全走 mock（雙軌，demo 不會死）。 */
export type GeoStatus = "pending" | "granted" | "denied" | "unsupported";

export function useGeo(): { status: GeoStatus; loc: { lat: number; lng: number } | null } {
  const [status, setStatus] = useState<GeoStatus>("pending");
  const [loc, setLoc] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!navigator.geolocation) {
      setStatus("unsupported");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLoc({ lat: p.coords.latitude, lng: p.coords.longitude });
        setStatus("granted");
      },
      () => setStatus("denied"),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }, []);

  return { status, loc };
}
