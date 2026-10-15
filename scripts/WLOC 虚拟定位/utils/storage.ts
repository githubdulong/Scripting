// 持久化存储层：基于 Scripting 的 Storage API（全局命名空间），
// 封装收藏位置、应用设置、当前生效坐标缓存三类数据。

import type { AppSettings, FavoriteLocation, ActiveLocation, SessionRecovery } from "../types";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants";

// ── 收藏位置 ───────────────────────────────────────────────────────

// 读取全部收藏位置
export function loadFavorites(): FavoriteLocation[] {
  return Storage.get<FavoriteLocation[]>(STORAGE_KEYS.favorites) ?? [];
}

// 写入收藏列表（整体替换）
export function saveFavorites(favorites: FavoriteLocation[]): boolean {
  return Storage.set(STORAGE_KEYS.favorites, favorites);
}

// 追加一条收藏，返回新列表
export function addFavorite(name: string, latitude: number, longitude: number): FavoriteLocation[] {
  const list = loadFavorites();
  list.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    latitude,
    longitude,
    createdAt: new Date().toISOString(),
  });
  saveFavorites(list);
  return list;
}

// 按 id 删除一条收藏，返回新列表
export function removeFavorite(id: string): FavoriteLocation[] {
  const list = loadFavorites().filter((f) => f.id !== id);
  saveFavorites(list);
  return list;
}

// 清空全部收藏
export function clearFavorites(): void {
  saveFavorites([]);
}

// ── 历史记录 ───────────────────────────────────────────────────────

/** 最多留这么多条，再多了翻起来也没意义。 */
const HISTORY_LIMIT = 30;

export function loadHistory(): FavoriteLocation[] {
  return Storage.get<FavoriteLocation[]>(STORAGE_KEYS.history) ?? [];
}

/**
 * 记一条历史，返回新列表。
 *
 * 同一地点反复选中只留最新一条——否则历史很快被同一个点刷满。
 */
export function addHistory(name: string, latitude: number, longitude: number): FavoriteLocation[] {
  const list = loadHistory().filter(
    (item) => Math.abs(item.latitude - latitude) > 1e-6 || Math.abs(item.longitude - longitude) > 1e-6,
  );
  list.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    latitude,
    longitude,
    createdAt: new Date().toISOString(),
  });
  const trimmed = list.slice(0, HISTORY_LIMIT);
  Storage.set(STORAGE_KEYS.history, trimmed);
  return trimmed;
}

export function clearHistory(): void {
  Storage.set(STORAGE_KEYS.history, []);
}

// ── 应用设置 ───────────────────────────────────────────────────────

// 读取应用设置，缺失字段以默认值补全
export function loadSettings(): AppSettings {
  const saved = Storage.get<Partial<AppSettings> & { menuSide?: string }>(STORAGE_KEYS.settings);
  const merged = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };

  // 菜单位置早先只有左右两档（menuSide），后来扩成三个角。
  // 不迁移的话，选过右侧的人会被静默退回默认值。
  if (!saved?.menuCorner && saved?.menuSide) {
    merged.menuCorner = saved.menuSide === "right" ? "bottomRight" : "topLeft";
  }

  return merged;
}

// 写入应用设置（整体替换）
export function saveSettings(settings: AppSettings): boolean {
  return Storage.set(STORAGE_KEYS.settings, settings);
}

// ── 会话恢复记录 ───────────────────────────────────────────────────
//
// 会话开始时写、正常停止时删。下次启动还在，就说明上次没能正常收尾
// （脚本被杀、隧道掉线等），设备那头可能还保持着最后的模拟位置。

export function loadRecovery(): SessionRecovery | null {
  return Storage.get<SessionRecovery>(STORAGE_KEYS.recovery);
}

export function saveRecovery(record: SessionRecovery): void {
  Storage.set(STORAGE_KEYS.recovery, record);
}

export function clearRecovery(): void {
  Storage.remove(STORAGE_KEYS.recovery);
}

// ── 当前生效坐标缓存 ─────────────────────────────────────────────────

// 读取上次模拟的位置，启动时用来把地图镜头摆回去
export function loadActiveCache(): ActiveLocation | null {
  return Storage.get<ActiveLocation>(STORAGE_KEYS.activeCache);
}

// 写入生效坐标缓存
export function saveActiveCache(loc: ActiveLocation | null): void {
  if (loc == null) Storage.remove(STORAGE_KEYS.activeCache);
  else Storage.set(STORAGE_KEYS.activeCache, loc);
}
