// 持久化存储层：基于 Scripting 的 Storage API（全局命名空间），
// 封装收藏位置、应用设置、当前生效坐标缓存三类数据。

import type { AppSettings, FavoriteLocation, ActiveLocation, SessionRecovery } from "../types";
import { DEFAULT_DEVICE_HOST, DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants";
import type { TunnelEndpoint } from "../core/session";

/**
 * 从设置里取出要连的那个端点。
 *
 * 全仓库原先有 7 处各自写 `{ host: settings.deviceHost, source: settings.tunnelSource }`,
 * 没有一处做清洗——用户在输入框里多打一个空格、或者手滑清空，拿到的就是
 * `" 10.7.0.1 "` 或者空串，然后一路传到 `connectTCP` 去连一个根本不存在的主机，
 * 报出来的是「无响应」，看不出是地址本身错了。
 *
 * 清洗和回退都收在这里，调用方只管要端点。
 */
export function endpointFromSettings(settings: AppSettings): TunnelEndpoint {
  const host = settings.deviceHost.trim();
  return { host: host || DEFAULT_DEVICE_HOST, source: settings.tunnelSource };
}

// ── 收藏位置 ───────────────────────────────────────────────────────

// 读取全部收藏位置
export function loadFavorites(): FavoriteLocation[] {
  return Storage.get<FavoriteLocation[]>(STORAGE_KEYS.favorites) ?? [];
}


// 写入收藏列表。只有本文件的增删清操作会调它，不对外导出。
function saveFavorites(list: FavoriteLocation[]): void {
  Storage.set(STORAGE_KEYS.favorites, list);
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

// ── 卡片恢复按钮 ↔ 主脚本 ─────────────────────────────────────────────
//
// 恢复按钮的 intent 跑在单独的环境里，碰不到主脚本手上的会话。而会话的心跳
// 每 4 秒把假坐标重发一遍——intent 自己连上去发停止，几秒后就被盖回去。
// 所以主脚本开着会话时，intent 只递话，由主脚本用现成的连接收尾。
//
// 传话本身交给 `ScriptSession`（主脚本 register、intent request），这里只负责
// 把那个 session ID 存下来给 intent 读。
//
// 以前是拿 Storage 当信箱：主脚本每秒轮询有没有请求、顺手写一次心跳，intent
// 投完请求每 300 毫秒查一次回执，还要 TTL 和撤回防止陈年请求误伤新会话。
// 八个函数、两个轮询、五个常量，全部由 register/request 这一对取代。

/** 主脚本注册成功后写下 session ID，供 intent 取用。 */
export function saveSessionID(id: string): void {
  Storage.set(STORAGE_KEYS.sessionID, id);
}

export function clearSessionID(): void {
  Storage.remove(STORAGE_KEYS.sessionID);
}

/**
 * 读主脚本的 session ID。
 *
 * 可能是**陈旧**的：主脚本退出时 session 会被系统关掉，而这里的 ID 还留着。
 * 不必特意清理——拿它去 request 会直接失败，调用方据此回落到自己连设备，
 * 这正是想要的行为。
 */
export function loadSessionID(): string | null {
  return Storage.get<string>(STORAGE_KEYS.sessionID);
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
