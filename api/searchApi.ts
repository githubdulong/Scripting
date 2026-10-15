// 地点搜索：国内走 MapKit，境外走中转 Worker 调 OpenStreetMap。
//
// 中国大陆的 iPhone，系统 MapKit 的数据源是高德，搜不到境外 POI；
// 「全球」模式因此改走 Worker → Nominatim，与 wloc（iOS）用的是同一个接口。

import { fromDeviceCoordinate } from "../utils/coords";
import type { Coordinate } from "../types";

export interface SearchResult {
  name: string;
  address: string;
  coordinate: Coordinate;
}

/** 与 wloc（iOS）的 GlobalPlaceSearch 一致，撞限额时可在设置里换成自建的。 */
export const DEFAULT_GLOBAL_ENDPOINT = "https://wloc-pages.pages.dev/api/search";

/**
 * 国内搜索。不传 region，让 MapKit 按设备位置自行决定范围。
 *
 * 返回的坐标是地图系（大陆为 GCJ-02），与应用内的口径一致，不必换算。
 */
export async function searchPlaces(query: string): Promise<SearchResult[]> {
  if (!query.trim()) return [];

  const items = await MapSearch.locate({
    query,
    resultTypes: ["pointOfInterest", "address"],
  });

  return items.map((item) => ({
    name: item.name ?? "",
    address: item.formattedAddress ?? "",
    coordinate: {
      latitude: item.coordinate.latitude,
      longitude: item.coordinate.longitude,
    },
  }));
}

interface GlobalResponse {
  results?: { name?: string; detail?: string; lat?: number; lon?: number }[];
}

function containsChinese(text: string): boolean {
  return /[一-鿿]/.test(text);
}

/**
 * 中文关键词先翻成英文再搜。
 *
 * OpenStreetMap 的简体中文名收录很少，直接拿「埃菲尔铁塔」去搜几乎全空。
 * 用设备上已装的语言包翻译，不弹下载提示；语言没装或系统太旧会抛错，
 * 那就退回原文搜一次，总比直接失败好。
 */
export async function translateForSearch(query: string): Promise<{ text: string; translated: boolean }> {
  if (!containsChinese(query)) return { text: query, translated: false };

  try {
    const text = await Translation.shared.translateInstalled({
      text: query,
      source: "zh-Hans",
      target: "en",
    });
    const trimmed = text.trim();
    if (!trimmed) return { text: query, translated: false };
    return { text: trimmed, translated: trimmed !== query };
  } catch {
    return { text: query, translated: false };
  }
}

/**
 * 境外搜索。
 *
 * Nominatim 给的是 WGS-84，而应用内统一按地图系存放，所以要先转一道——
 * 境外换算恒等，境内才会真正偏移，两边坐标因此都对得上。
 */
export async function searchGlobalPlaces(
  query: string,
  endpoint = DEFAULT_GLOBAL_ENDPOINT,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  if (!endpoint.startsWith("http")) throw new Error("全球搜索服务地址无效");

  const response = await fetch(`${endpoint}?q=${encodeURIComponent(trimmed)}`, {
    method: "GET",
    timeout: 12,
  } as any);
  if (!response.ok) throw new Error(`全球搜索失败：HTTP ${response.status}`);

  const body = (await response.json()) as GlobalResponse;
  const results: SearchResult[] = [];

  for (const item of body.results ?? []) {
    if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) continue;
    const mapped = fromDeviceCoordinate(item.lat as number, item.lon as number);
    results.push({
      name: (item.name ?? "").trim() || trimmed,
      address: (item.detail ?? "").trim(),
      coordinate: mapped,
    });
  }

  return results;
}
