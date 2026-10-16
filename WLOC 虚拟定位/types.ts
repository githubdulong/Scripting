// WLOC 类型定义
import type { Color } from "scripting";

/** 地理坐标，等价于 MapKit 的 CLLocationCoordinate2D。 */
export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** 收藏的位置条目 */
export interface FavoriteLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** ISO 时间字符串 */
  createdAt: string;
}

/**
 * 当前正在模拟的位置。
 *
 * 坐标是应用内的地图系（中国大陆为 GCJ-02），下发给设备前才转成 WGS-84。
 */
export interface ActiveLocation {
  latitude: number;
  longitude: number;
  name?: string;
}

/** 地图样式标识（对应 MapKit 样式集合） */
export type MapLayerId = "standard" | "imagery" | "hybrid";

/**
 * 回环隧道由谁提供。
 *
 * - `builtIn`：用 Scripting 自己的 VPN（`VPN.localDevVPN`）。会把正在跑的
 *   Surge / ClashMi 一类顶下去——iOS 同时只允许一条 VPN 生效。
 * - `proxyApp`：由代理工具提供反射（把 `tun.loopback-address` 配成对端地址即可），
 *   脚本不碰 VPN 开关。代理本来就常驻，不存在「需要被唤起」这回事。
 */
export type TunnelSource = "builtIn" | "proxyApp";

/**
 * 功能菜单落在哪个角。
 *
 * 单手握持时拇指够得到的那个角才顺手，所以做成可选的。
 * 没有右上角——那是 MapKit 自带控件（定位、3D、指南针）的固定位置。
 */
export type MenuCorner = "topLeft" | "bottomLeft" | "bottomRight";

/** 灵动岛收起态显示什么文字 */
export type IslandTextMode =
  | "elapsed"     // 已持续多久，系统计时
  | "status"      // 模拟中 / 移动中 / 已暂停
  | "place"       // 地点名
  | "coordinate"  // 坐标
  | "speed"       // 速度
  | "progress"    // 路线进度百分比
  | "custom"      // 自定义文本
  | "none";

/** 灵动岛收起态的图标来源 */
export type IslandIconMode =
  | "mode"   // 跟随移动方式（步行/跑步/骑行/驾车）
  | "fixed"  // 固定用定位箭头
  | "emoji"  // 自定义 emoji
  | "none";

/** 锁屏卡片的大标题显示什么 */
/** 卡片与灵动岛的大标题（「位置模拟中」那一行）从哪来。 */
export type CardStatusMode =
  | "auto"    // 跟着当前状态走：位置模拟中 / 步行中 / 已暂停
  | "custom"; // 固定用自己填的一句

export type CardTitleMode =
  | "place"   // 地点名，查不到退回坐标
  | "coord"   // 始终坐标
  | "custom"; // 自定义文本

/** 应用持久化设置 */
export interface AppSettings {
  /** 锁屏卡片大标题 */
  cardTitle: CardTitleMode;
  /** 卡片上「恢复真实位置」按钮的颜色 */
  restoreTint: Color;
  /** cardTitle 为 custom 时用的文本 */
  cardCustomTitle: string;
  /** 灵动岛与锁屏卡片的主色（关键字色名，深浅模式自动跟随） */
  islandTint: Color;
  islandIcon: IslandIconMode;
  /** islandIcon 为 emoji 时用的字符 */
  islandEmoji: string;
  islandText: IslandTextMode;
  cardStatus: CardStatusMode;
  /** cardStatus 为 custom 时用的文案 */
  cardCustomStatus: string;
  /** islandText 为 custom 时用的文本 */
  islandCustomText: string;
  /** 功能菜单落在哪个角 */
  menuCorner: MenuCorner;
  /** 默认地图图层 */
  defaultLayer: MapLayerId;
  /** 位置扰动半径（米），0 表示关闭 */
  jitterRadius: number;
  /** 会话期间是否按心跳持续下发坐标 */
  keepAlive: boolean;
  /** 回环隧道来源 */
  tunnelSource: TunnelSource;
  /** 对端地址：设备配对服务所在的回环地址，需与隧道提供方的配置一致 */
  deviceHost: string;
  /** 自定义的全球搜索服务地址；留空用内置默认 */
  globalSearchEndpoint: string;
}

/** 地图链接解析结果 */
export interface ParsedCoord {
  latitude: number;
  longitude: number;
  name?: string;
  src?: string;
}

/**
 * 上次会话的恢复记录。
 *
 * 会话开始时写入、正常停止时删除；启动时还在就说明上次没收尾干净。
 */
export interface SessionRecovery {
  latitude: number;
  longitude: number;
  startedAt: string;
  updatedAt: string;
}

/** 定位会话的界面状态 */
export type SessionState = "idle" | "connecting" | "active";
