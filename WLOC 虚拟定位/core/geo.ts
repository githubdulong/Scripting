// 球面几何：沿方位角推进、两点距离、路径弧长索引。
//
// 移动模拟全靠这几个函数：按速度推进一段距离，再换算成坐标。
// 统一用球面模型（半径 6371 km），米级误差对定位模拟无影响。

import type { Coordinate } from "../types";

const EARTH_RADIUS = 6371000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** 从一点按方位角（弧度，0 为正北、顺时针）前进若干米。 */
export function destination(from: Coordinate, bearing: number, metres: number): Coordinate {
  const lat1 = toRadians(from.latitude);
  const lon1 = toRadians(from.longitude);
  const angular = metres / EARTH_RADIUS;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  // 经度规整到 ±180，跨日期变更线时才不会跑飞。
  return {
    latitude: toDegrees(lat2),
    longitude: ((toDegrees(lon2) + 540) % 360) - 180,
  };
}

/** 两点间大圆距离（米）。 */
export function distanceBetween(a: Coordinate, b: Coordinate): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const h =
    Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** 由 a 指向 b 的方位角（弧度，0 为正北、顺时针）。 */
export function bearingBetween(a: Coordinate, b: Coordinate): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  return Math.atan2(
    Math.sin(deltaLon) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLon),
  );
}

/**
 * 路径各点的累计弧长，`result[i]` 是起点到第 i 个点的距离。
 *
 * 预先算好，之后按距离取点就只是一次二分查找。
 */
export function cumulativeDistances(path: Coordinate[]): number[] {
  const result = [0];
  for (let i = 1; i < path.length; i++) {
    result.push(result[i - 1] + distanceBetween(path[i - 1], path[i]));
  }
  return result;
}

export function totalLength(cumulative: number[]): number {
  return cumulative.length > 0 ? cumulative[cumulative.length - 1] : 0;
}

/**
 * 取路径上距起点 `metres` 处的坐标，落在两点之间时线性插值。
 *
 * 超出两端则夹到端点——调用方按自己的策略处理终点（折返或停止）。
 */
export function pointAtDistance(
  path: Coordinate[],
  cumulative: number[],
  metres: number,
): Coordinate {
  if (path.length === 0) throw new Error("路径为空");
  if (path.length === 1 || metres <= 0) return path[0];

  const total = totalLength(cumulative);
  if (metres >= total) return path[path.length - 1];

  // 二分找到 metres 落在哪一段
  let low = 0;
  let high = cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= metres) low = mid;
    else high = mid;
  }

  const segment = cumulative[high] - cumulative[low];
  if (segment <= 0) return path[low];

  const ratio = (metres - cumulative[low]) / segment;
  const bearing = bearingBetween(path[low], path[high]);
  return destination(path[low], bearing, segment * ratio);
}
