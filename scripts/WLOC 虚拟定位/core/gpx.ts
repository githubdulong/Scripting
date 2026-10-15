// GPX 轨迹解析。
//
// 只取坐标序列——时间戳、海拔、名称对定位模拟没用，速度由用户选的档位决定，
// 不跟轨迹里记录的原速。
//
// 不引入 XML 解析器：GPX 的坐标全在属性里，正则足够，且对畸形文件更宽容。

import type { Coordinate } from "../types";

/** `<trkpt lat="…" lon="…">`、`<rtept …>`、`<wpt …>` 三种点，属性顺序任意。 */
const POINT_PATTERN = /<(?:trkpt|rtept|wpt)\b([^>]*)>/gi;
const LAT_PATTERN = /\blat\s*=\s*["']([-+0-9.eE]+)["']/i;
const LON_PATTERN = /\blon\s*=\s*["']([-+0-9.eE]+)["']/i;

export interface GpxTrack {
  name?: string;
  coordinates: Coordinate[];
}

function parseName(text: string): string | undefined {
  const match = /<name>([\s\S]*?)<\/name>/i.exec(text);
  const name = match?.[1]?.trim();
  return name || undefined;
}

/**
 * 解析 GPX，返回轨迹点。
 *
 * 坐标按 GPX 规范是 WGS-84，而应用内统一用地图系存放，
 * 所以调用方拿到后要先过一遍 `fromDeviceCoordinate`。
 */
export function parseGPX(text: string): GpxTrack {
  const coordinates: Coordinate[] = [];

  POINT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = POINT_PATTERN.exec(text)) !== null) {
    const attributes = match[1];
    const latitude = Number(LAT_PATTERN.exec(attributes)?.[1]);
    const longitude = Number(LON_PATTERN.exec(attributes)?.[1]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) continue;

    // 跳过与上一点完全重合的点，否则弧长索引里会出现零长分段。
    const last = coordinates[coordinates.length - 1];
    if (last && last.latitude === latitude && last.longitude === longitude) continue;

    coordinates.push({ latitude, longitude });
  }

  if (coordinates.length < 2) {
    throw new Error(`GPX 里只解析到 ${coordinates.length} 个有效坐标，至少需要两个`);
  }

  return { name: parseName(text), coordinates };
}
