// WLOC 常量定义
import type { AppSettings, MapLayerId, MenuCorner, TunnelSource } from "./types";

/** 默认坐标：深圳 */
export const DEFAULT_COORDINATE = {
  latitude: 22.544577,
  longitude: 113.94114,
};

/** 默认地图缩放跨度 */
export const DEFAULT_SPAN = {
  latitudeDelta: 0.02,
  longitudeDelta: 0.02,
};

/** 位置扰动默认关闭——开着会让定点坐标一直小幅漂移。 */
export const DEFAULT_JITTER_RADIUS = 0;

/** 扰动半径可选档位（米） */
export const JITTER_OPTIONS = [0, 3, 5, 10];

/**
 * 对端默认地址，与 LocalDevVPN 的约定一致。
 *
 * 已有的 sideload 工具（StikDebug 等）都按这个地址寻址，换地址它们就连不上了，
 * 所以这不是可以随意挑的数字。要把地址让给别的工具时才改。
 */
export const DEFAULT_DEVICE_HOST = "10.7.0.1";

/** 默认应用设置 */
export const DEFAULT_SETTINGS: AppSettings = {
  menuCorner: "topLeft",
  defaultLayer: "imagery",
  jitterRadius: DEFAULT_JITTER_RADIUS,
  keepAlive: true,
  tunnelSource: "builtIn",
  deviceHost: DEFAULT_DEVICE_HOST,
  globalSearchEndpoint: "",
};

/**
 * 代理工具用的回环模块。
 *
 * 隧道来源选「代理工具提供」时，得让代理工具把对端地址反射回本机。
 * 照文档手写容易漏掉 IPv6 那一项，装现成模块省事。
 */
export const LOOPBACK_MODULE_LOON =
  "https://raw.githubusercontent.com/ios151/Scripting/main/dev-loopback/modules/dev-loopback.lpx";
export const LOOPBACK_MODULE_SURGE =
  "https://raw.githubusercontent.com/ios151/Scripting/main/dev-loopback/modules/dev-loopback.sgmodule";

/** 全球搜索的 Worker 源码与部署说明。 */
export const WORKER_SOURCE_URL = "https://github.com/ios151/wloc";

/**
 * 菜单位置可选项。
 *
 * 没有右上角：那是 MapKit 自带控件（定位、3D、指南针）的固定位置，
 * Scripting 的 `controls` 没给放置位置的参数，那三个挪不动。
 *
 * 摇杆会自动躲去另一个底角，所以底部两个角都能选。
 */
export const MENU_CORNER_OPTIONS: {
  id: MenuCorner;
  label: string;
  systemImage: string;
  detail: string;
}[] = [
  {
    id: "topLeft",
    label: "左上角",
    systemImage: "arrow.up.left",
    detail: "展开后向右、向下铺开。摇杆在左下角。",
  },
  {
    id: "bottomLeft",
    label: "左下角",
    systemImage: "arrow.down.left",
    detail: "左手拇指最好够。展开后向右、向上铺开，摇杆让到右下角。",
  },
  {
    id: "bottomRight",
    label: "右下角",
    systemImage: "arrow.down.right",
    detail: "右手拇指最好够。展开后向左、向上铺开，摇杆留在左下角。",
  },
];

/** 隧道来源可选项 */
export const TUNNEL_SOURCE_OPTIONS: { id: TunnelSource; label: string; detail: string }[] = [
  {
    id: "builtIn",
    label: "Scripting 自身",
    detail: "用 Scripting 的 VPN 建回环隧道。会顶掉正在运行的代理工具。",
  },
  {
    id: "proxyApp",
    label: "代理工具提供",
    detail: "由 Egern / ClashMi 一类把对端地址配成回环地址，脚本不碰 VPN 开关。",
  },
];

/** Storage 持久化键 */
export const STORAGE_KEYS = {
  favorites: "wloc_favorites",
  history: "wloc_history",
  settings: "wloc_settings",
  activeCache: "wloc_active_cache",
  recovery: "wloc_session_recovery",
} as const;

/** 地图图层可选项（id → 显示名） */
export const MAP_LAYER_OPTIONS: { id: MapLayerId; label: string }[] = [
  { id: "standard", label: "标准" },
  { id: "imagery", label: "卫星" },
  { id: "hybrid", label: "混合" },
];

/** 判断坐标是否处于中国大陆范围（用于 GCJ-02 偏移判断） */
export function isInsideChina(lng: number, lat: number): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}
