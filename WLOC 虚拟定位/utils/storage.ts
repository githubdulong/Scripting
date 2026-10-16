// 持久化存储层：基于 Scripting 的 Storage API（全局命名空间），
// 封装收藏位置、应用设置、当前生效坐标缓存三类数据。

import type { AppSettings, FavoriteLocation, ActiveLocation, SessionRecovery } from "../types";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants";

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
// 所以主脚本开着会话时，intent 只递话，由主脚本用现成的连接收尾，再回执。

/** 恢复请求的处理结果；message 是失败时给人看的原因 */
export interface RestoreAck {
  id: string;
  ok: boolean;
  message?: string;
}

/** 主脚本会话进行中时周期性写入，intent 据此判断主脚本还在不在。 */
export function markSessionBeat(): void {
  Storage.set(STORAGE_KEYS.sessionBeat, Date.now());
}

export function clearSessionBeat(): void {
  Storage.remove(STORAGE_KEYS.sessionBeat);
}

/** 距主脚本上次报平安过了多久（毫秒）；从没报过返回 Infinity。 */
export function sessionBeatAge(): number {
  const at = Storage.get<number>(STORAGE_KEYS.sessionBeat);
  return at == null ? Infinity : Date.now() - at;
}

/** 请求多久不处理就作废。intent 等回执的上限是 10 秒，这里留足余量。 */
const RESTORE_REQUEST_TTL_MS = 15_000;

/** intent 发起恢复请求，返回请求编号，用来认领回执。 */
export function requestRestore(): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  Storage.set(STORAGE_KEYS.restoreRequest, id);
  return id;
}

/**
 * intent 等不到回执时撤回自己那条请求。
 *
 * 不撤的话它会一直躺在 storage 里：intent 超时后自己连设备停掉了，用户隔一会儿
 * 重新开始模拟，主脚本的轮询取到这条陈年请求，当场把新会话停了。
 * 带上 id 是防止误删——那时候可能已经是别人的请求了。
 */
export function withdrawRestoreRequest(id: string): void {
  if (Storage.get<string>(STORAGE_KEYS.restoreRequest) === id) {
    Storage.remove(STORAGE_KEYS.restoreRequest);
  }
}

/**
 * 主脚本取走待处理的恢复请求，取完即删；没有返回 null。
 *
 * 过期的直接丢掉：id 前缀就是发起时间，超过 TTL 说明 intent 早已放弃、
 * 多半自己把位置恢复了，这时候再停一次只会打断用户新开的会话。
 */
export function takeRestoreRequest(): string | null {
  const id = Storage.get<string>(STORAGE_KEYS.restoreRequest);
  if (id == null) return null;
  Storage.remove(STORAGE_KEYS.restoreRequest);
  const issuedAt = Number(id.split("-")[0]);
  if (Number.isFinite(issuedAt) && Date.now() - issuedAt > RESTORE_REQUEST_TTL_MS) return null;
  return id;
}

export function ackRestore(ack: RestoreAck): void {
  Storage.set(STORAGE_KEYS.restoreAck, ack);
}

/** 读编号为 id 的回执；还没回或是别的请求的回执都返回 null。 */
export function loadRestoreAck(id: string): RestoreAck | null {
  const ack = Storage.get<RestoreAck>(STORAGE_KEYS.restoreAck);
  return ack?.id === id ? ack : null;
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
