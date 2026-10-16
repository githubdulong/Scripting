// 地点搜索：国内走 MapKit，境外走中转 Worker 调 OpenStreetMap。
//
// 中国大陆的 iPhone，系统 MapKit 的数据源是高德，没有境外 POI 数据。
// 「全球」模式因此改走 Worker → Nominatim，与 wloc（iOS）用的是同一个接口。
//
// **不要试图用系统接口替掉这个 Worker。** 2026-10-16 在大陆 iPhone 实测：
//
//   MapSearch.locate("Eiffel Tower")                  → 巴黎铁塔 @ 30.584, 103.728（四川的山寨）
//   MapSearch.locate("Eiffel Tower", region=巴黎)      → MKErrorDomain 4（placemarkNotFound）
//   MapSearch.locate("Times Square", region=纽约)      → MKErrorDomain 4
//   Location.geocodeAddress("Eiffel Tower, Paris")    → 上海市崇明区埃菲尔铁塔 @ 31.730, 121.247
//   MapSearch.locate("王府井")（对照）                  → 王府井步行街 @ 39.913, 116.412 ✓
//
// 给境外 region 直接报错；不给 region 则拿国内同名建筑顶替——返回的是一个
// 格式正确、坐标完全错误的结果。对定位模拟来说这比返回空更危险：
// 用户以为定位到了巴黎，实际在成都。

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
 * 由搜索地址推出反查地址。
 *
 * 两个端点在同一个 Worker 上，只差最后一段。设置项里存的一直是搜索地址
 * （历史原因，那时还没有反查），所以这里换一下而不是再加一个设置——
 * 多一个要填的地址，等于多一个填错的机会。
 */
function reverseEndpointFrom(searchEndpoint: string): string {
  const trimmed = searchEndpoint.trim().replace(/\/+$/, "");
  return /\/search$/.test(trimmed) ? trimmed.replace(/\/search$/, "/reverse") : `${trimmed}/reverse`;
}

/**
 * 境外坐标反查地名。
 *
 * 系统的 `Location.reverseGeocode` 在大陆设备上走高德数据，境外基本没有覆盖——
 * 定位到首尔，卡片上只能显示一串坐标。搜索那边早就有 Worker → Nominatim 这条路，
 * 反查一直缺，这里补上。
 *
 * **只在系统反查失败后调用。** 境内系统的结果更准也更快（门牌号级别），
 * 没必要为了统一而全都绕出去。
 *
 * @param latitude  设备坐标系（WGS-84）
 * @returns 地名；查不到返回空串，调用方退回显示坐标
 */
export async function reverseGlobalPlace(
  latitude: number,
  longitude: number,
  endpoint = DEFAULT_GLOBAL_ENDPOINT,
): Promise<string> {
  if (!endpoint.startsWith("http")) return "";
  const url =
    `${reverseEndpointFrom(endpoint)}?lat=${encodeURIComponent(latitude)}` +
    `&lon=${encodeURIComponent(longitude)}`;

  const response = await fetch(url, { method: "GET", timeout: 10 } as any);
  if (!response.ok) return "";

  const body = (await response.json()) as { name?: string; detail?: string };
  // name 是「路名 / POI」那一级；detail 是整串地址，太长不适合放卡片，
  // 取第一段当兜底就够了。
  return (body.name ?? "").trim() || (body.detail ?? "").split(",")[0].trim();
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
