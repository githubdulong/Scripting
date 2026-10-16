// WLOC 虚拟定位 —— Scripting 应用上的本机定位模拟脚本
// Copyright (C) 2026 ios151
//
// 本程序是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证
// （第 3 版或任何后续版本）条款重新分发和/或修改它。
//
// 分发本程序是希望它能派上用场，但不提供任何担保；甚至不包含适销性或
// 特定用途适用性的默示担保。详见 GNU 通用公共许可证。
//
// 你应当已随本程序收到一份 GNU 通用公共许可证副本（见 LICENSE）；
// 如果没有，请见 <https://www.gnu.org/licenses/>。

// WLOC 虚拟定位 — 入口
//
// 在地图上选点，经苹果官方开发者接口（本机隧道 → RemotePairing → RSD → DVT）
// 把坐标下发给本机，与 Xcode 的 Simulate Location 同一套机制。
//
// 坐标显示和操作按钮在 App 层渲染（与 Map 平级），避免 Map 的 SwiftUI 渲染隔离。

import {
  Script,
  Navigation,
  useEffect,
  useObservable,
  useRef,
  useState,
  ZStack,
  Rectangle,
  VStack,
  HStack,
  Text,
  Spacer,
  Image,
  Button,
  AppEvents,
  LiveActivity,
  type ScenePhase,
  type VirtualNode,
  type Color,
  type KeywordPoint,
} from "scripting";
// Animation 与 withAnimation 是全局声明，不从 "scripting" 导出，直接用即可。
import type { ActiveLocation, AppSettings, Coordinate, FavoriteLocation, MapLayerId, SessionState } from "./types";
import {
  loadFavorites,
  addFavorite,
  removeFavorite,
  clearFavorites,
  loadHistory,
  addHistory,
  clearHistory,
  loadSettings,
  saveSettings,
  saveActiveCache,
  loadRecovery,
  saveRecovery,
  clearRecovery,
  markSessionBeat,
  clearSessionBeat,
  takeRestoreRequest,
  ackRestore,
} from "./utils/storage";
import { MapPage } from "./pages/MapPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { PairingPage } from "./pages/PairingPage";
import { SearchPage } from "./pages/SearchPage";
import { AboutPage } from "./pages/AboutPage";
import { MovementPanel, type MovementSelection } from "./pages/MovementPanel";
import { JoystickPad } from "./pages/JoystickPad";
import { CellularGuide, type GuideStage } from "./pages/CellularGuide";
import { applyJitter, fromDeviceCoordinate, parseAndConvert, toDeviceCoordinate } from "./utils/coords";
import { loadPairing, type PairingRecord } from "./core/pairing";
import { debugLog, describeError } from "./core/debug";
import { restoreRealLocation, startLocationSession, type LocationSessionHandle } from "./core/session";
import { defaultSpeed, joystickStep, modeInfo, PathWalker, type WalkState } from "./core/movement";
import { parseGPX } from "./core/gpx";
import { distanceBetween } from "./core/geo";
import { delay, withTimeout } from "./core/stream";
import { DEFAULT_GLOBAL_ENDPOINT } from "./api/searchApi";
import { SimulationLiveActivity, type SimulationState } from "./live_activity";

type SheetKind = "settings" | "favorites" | "search" | "movement" | null;

/** 收起式菜单里的一个入口。 */
interface MenuEntry {
  icon: string;
  tint: Color;
  action: () => void;
}

/** 移动模拟的推进间隔。与 wloc（iOS）一致，太密会让 DTX 队列排不过来。 */
const MOVEMENT_TICK_MS = 500;
/*
  断线重连的节奏。
  关掉飞行模式后网络要几秒才稳，2 秒一次、试 5 次≈10 秒，足够跨过切换期；
  再连不上就如实报错，别无限转圈。
*/
const RECONNECT_DELAY_MS = 2000;
const RECONNECT_TRIES = 5;

/** 会话中报平安、查卡片恢复请求的节拍。app_intents.tsx 按它定「主脚本还在」的判据。 */
const RESTORE_POLL_MS = 1000;

interface PlannedRoute {
  name?: string;
  coordinates: Coordinate[];
  distance: number;
  travelTime: number;
}

function App() {
  const dismiss = Navigation.useDismiss();
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [favorites, setFavorites] = useState<FavoriteLocation[]>(() => loadFavorites());
  const [history, setHistory] = useState<FavoriteLocation[]>(() => loadHistory());
  const [pairing, setPairing] = useState<PairingRecord | null>(() => loadPairing());
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [showCredit, setShowCredit] = useState(true);

  const session = useObservable<LocationSessionHandle | null>(null);

  // 移动模拟：推进器与定时器放 observable 里，避免重渲染时被重建。
  const [movementKind, setMovementKind] = useState<"none" | "route" | "joystick">("none");
  const [paused, setPaused] = useState(false);
  const [selection, setSelection] = useState<MovementSelection>(() => ({
    mode: "walking",
    speed: defaultSpeed("walking"),
    lapPlan: "oneWay",
  }));
  /** 规划出的全部方案，选中的那条才是要走的。 */
  const [routes, setRoutes] = useState<PlannedRoute[]>([]);
  const [routeIndex, setRouteIndex] = useState(0);
  /** 路线起点；null 表示用当前真实位置。 */
  const [routeStart, setRouteStart] = useState<Coordinate | null>(null);
  const [drawnPath, setDrawnPath] = useState<Coordinate[]>([]);
  /**
   * 手绘模式：开着的时候，点地图就是落一个点。
   *
   * 用 Observable 而不是 useState，是因为地图的选点回调里有一条（POI 选中）
   * 挂在 `[]` 依赖的 useEffect 上，拿到的是首帧的闭包——读 state 会永远是初始值。
   */
  const drawing = useObservable(false);
  /** 同上：落点要基于最新的点列，不能用闭包里那份快照。 */
  const drawnRef = useRef<Coordinate[]>([]);
  /** 正在自动重连，挡住重连过程中再次触发的掉线回调。 */
  const reconnecting = useRef(false);
  /** 反查过的地名。空串表示查过但没有结果，避免对同一个点反复请求。 */
  const placeCache = useRef(new Map<string, string>());
  const walker = useObservable<PathWalker | null>(null);
  const movementTimer = useObservable<ReturnType<typeof setInterval> | null>(null);
  const joystickVector = useObservable({ dx: 0, dy: 0 });
  /** 摇杆卡片被拖到哪儿了。浮层总会挡住一部分地图，挡哪儿由用户决定。 */
  const joystickOffset = useObservable({ x: 0, y: 0 });
  const joystickPosition = useObservable<Coordinate | null>(null);
  /** 锁屏/灵动岛卡片。脚本被划掉后它仍在，是「忘了恢复」的最后一道提醒。 */
  const liveActivity = useObservable(() => SimulationLiveActivity());
  const [placeName, setPlaceName] = useState("");

  // 当前选点（来自搜索/链接解析/收藏），供 MapPage 监听并跳转
  const pendingCoord = useObservable<Coordinate | null>(null);
  /*
    蜂窝数据引导的状态。
    guideStart/guideError 用 ref：它们只在回调里读写，进渲染只会多出无谓的重绘。
  */
  const guideStage = useObservable<GuideStage | null>(null);
  const guideAttempts = useObservable(0);
  const guideStart = useRef<Coordinate | null>(null);
  const guideError = useRef<unknown>(null);
  /** 引导连上之后，这条会话掉线该怎么办。和直连那条路保持一致。 */
  const guideDropRetry = useRef<Coordinate | null>(null);
  const guideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 正在跑一次建会话。轮询和「继续」可能撞上，用它互斥。 */
  const guideBusy = useRef(false);
  /** 轮次号。过期那一轮迟到的结果一律丢弃，不许它改状态。 */
  const guideRun = useRef(0);

  /** 把镜头移到这个点（摇杆卡片上的准星）。保留当前缩放，不动选中点。 */
  const recenterCoord = useObservable<Coordinate | null>(null);

  // 坐标状态（App 层管理）
  const coordLat = useObservable(0);
  const coordLng = useObservable(0);
  const coordReady = useObservable(false);
  const activeLoc = useObservable<ActiveLocation | null>(null);

  const layer = useObservable<MapLayerId>(settings.defaultLayer);

  const sheetKind = useObservable<SheetKind>(null);
  const showSheet = useObservable(false);
  /** 顶部功能入口是否展开。收起时只留关闭与齿轮两个按钮。 */
  const menuOpen = useObservable(false);

  const toastMsg = useObservable("");
  const showToast = useObservable(false);

  const errorMsg = useObservable("");
  const showError = useObservable(false);

  function fireToast(msg: string) {
    toastMsg.setValue(msg);
    showToast.setValue(true);
  }

  function showErrorAlert(msg: string) {
    errorMsg.setValue(msg);
    showError.setValue(true);
  }

  // 一次性把 VPN / 本机隧道 / 定位的授权都申请掉，省得中途被弹窗打断。
  useEffect(() => {
    void Script.requestAccess(["vpn", "localDevVPN", "location"]).catch(() => undefined);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setShowCredit(false), 3000);
    return () => clearTimeout(timer);
  }, []);

  /*
     启动时清掉遗留的实时活动卡片。

     卡片的生命周期独立于脚本：脚本被划掉、会话异常中断时它都会留在灵动岛上，
     内容还停在当时那一刻。没有未收尾记录就说明上次是正常结束的，那张卡片
     纯属残留——留着会一直显示「正在模拟位置」，比没有卡片更误导。
     有未收尾记录时反而要留着，它正是提醒你去恢复的那个东西。
   */
  useEffect(() => {
    if (loadRecovery()) return;
    void LiveActivity.endAllActivities({ dismissTimeInterval: 0 })
      .then((ok) => debugLog("liveactivity", `清理遗留卡片：${ok}`))
      .catch(() => undefined);
  }, []);

  // 上次会话没正常收尾时主动问一句——设备那头可能还保持着模拟位置。
  useEffect(() => {
    const record = loadRecovery();
    if (!record) return;

    void (async () => {
      const index = await Dialog.actionSheet({
        title: "上次的模拟没有正常结束",
        message:
          `最后模拟到 ${record.latitude.toFixed(5)}, ${record.longitude.toFixed(5)}。\n` +
          "设备可能仍保持着这个位置，是否现在连上去恢复真实位置？",
        actions: [{ label: "暂不处理" }, { label: "恢复真实位置" }],
        cancelButton: false,
      });
      if (index === 1) await handleRestoreRealLocation();
      else clearRecovery();
    })();
  }, []);

  /** 不建立会话，只连上去补发一次停止指令。 */
  async function handleRestoreRealLocation() {
    const record = loadPairing();
    if (!record) {
      showErrorAlert("请先在「配对」里导入配对记录，才能连上设备恢复");
      return;
    }

    setSessionState("connecting");
    setStatusMsg("连接设备以恢复…");
    try {
      await restoreRealLocation({
        record,
        endpoint: { host: settings.deviceHost, source: settings.tunnelSource },
        onStatus: setStatusMsg,
      });
      clearRecovery();
      activeLoc.setValue(null);
      saveActiveCache(null);
      void endLiveActivity();
      fireToast("已恢复真实位置");
    } catch (e) {
      debugLog("ui", "恢复失败", describeError(e));
      showErrorAlert(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSessionState("idle");
      setStatusMsg("");
    }
  }

  function openSheet(kind: SheetKind) {
    sheetKind.setValue(kind);
    showSheet.setValue(true);
  }

  function closeSheet() {
    showSheet.setValue(false);
    setTimeout(() => sheetKind.setValue(null), 200);
  }

  function handleCloseApp() {
    dismiss();
  }

  /** 展开/收起带回弹，手感比直接切换明显。 */
  function toggleMenu() {
    void withAnimation(Animation.bouncy({ duration: 0.38, extraBounce: 0.18 }), () => {
      menuOpen.setValue(!menuOpen.value);
    });
  }

  /** 点完入口就把菜单收起来，省得它一直挡着地图。 */
  function withMenuClosed(action: () => void) {
    void withAnimation(Animation.smooth({ duration: 0.22 }), () => menuOpen.setValue(false));
    action();
  }

  function cycleLayer() {
    const layers: MapLayerId[] = ["standard", "imagery", "hybrid"];
    const idx = layers.indexOf(layer.value);
    layer.setValue(layers[(idx + 1) % layers.length]);
  }

  function layerIcon(id: MapLayerId): string {
    switch (id) {
      case "imagery":
        return "globe.europe.africa.fill";
      case "hybrid":
        return "map.fill";
      case "standard":
      default:
        return "map";
    }
  }

  function handlePick(coord: Coordinate, name?: string) {
    coordLat.setValue(coord.latitude);
    coordLng.setValue(coord.longitude);
    coordReady.setValue(true);
    pendingCoord.setValue(coord);
    const label = name?.trim() || "";
    setPlaceName(label);
    setHistory(addHistory(label || "地图选点", coord.latitude, coord.longitude));
    closeSheet();
    fireToast("已定位到该坐标");
  }

  /**
   * 反查地名。
   *
   * 点空地选点时 MapKit 不给名称，锁屏卡片上就只剩两行一模一样的坐标。
   * 这里补一次反向地理编码，拼成「街道 · 区」这种能认出来的说法。
   * 查不到就算了，卡片退回显示坐标，不影响模拟。
   */
  async function resolvePlaceName(lat: number, lng: number): Promise<void> {
    // 查过的点直接用缓存。反查有频率限制，来回点同几个位置时不该重复请求。
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const cached = placeCache.current.get(key);
    if (cached !== undefined) {
      if (cached) setPlaceName(cached);
      return;
    }

    // 反查要用设备坐标系（WGS-84），地图上拿到的是地图系，先换过去。
    const wgs = toDeviceCoordinate(lat, lng);

    /*
      反查要联网，常见失败是 kCLErrorDomain 2（网络不可用）。
      开着「Scripting 自身」的隧道时尤其容易——iOS 同时只允许一条 VPN，
      本机回环占着那个名额，系统的地理编码未必出得去。
      只重试一次：多试反而会被频率限制拒得更久。
    */
    const lookup = async () =>
      await Location.reverseGeocode({ latitude: wgs.latitude, longitude: wgs.longitude });

    try {
      const marks = await lookup().catch(async () => {
        await delay(1500);
        return await lookup();
      });

      const mark = marks?.[0];
      if (!mark) {
        placeCache.current.set(key, "");
        return;
      }

      // name 往往已经是「××路123号」这类完整说法，优先用它；
      // 没有就拿街道 + 子区域拼，两者都没有才退回区县。
      const label =
        mark.name?.trim() ||
        [mark.thoroughfare, mark.subLocality].filter(Boolean).join(" ") ||
        mark.locality ||
        "";
      if (!label) return;

      placeCache.current.set(key, label);
      // 期间用户可能又点了别处，坐标对不上就丢弃这次结果。
      if (coordLat.value !== lat || coordLng.value !== lng) return;
      debugLog("geocode", `${lat.toFixed(5)}, ${lng.toFixed(5)} → ${label}`);
      setPlaceName(label);
      setHistory(addHistory(label, lat, lng));
    } catch (error) {
      // 查不到不影响模拟，卡片退回显示坐标即可。记一笔免得对同一个点反复请求。
      placeCache.current.set(key, "");
      debugLog("geocode", `${key} 查不到地名（隧道开着时偶发，多数地点正常）`, describeError(error));
    }
  }

  function handleCoordChange(lat: number, lng: number, name?: string) {
    coordLat.setValue(lat);
    coordLng.setValue(lng);
    coordReady.setValue(true);
    if (name !== undefined) {
      // 点中 POI 时 MapKit 直接给名称，比反查的结果准，优先用。
      setPlaceName(name);
      setHistory(addHistory(name || "地图选点", lat, lng));
    } else {
      // 点的是空地：先清掉上一个点的名字，再去反查，免得卡片上挂着旧地名。
      setPlaceName("");
      void resolvePlaceName(lat, lng);
    }
    // 手绘模式下点地图就是落点，不用为了加一个点去开合一次面板。
    if (drawing.value) appendDrawnPoint(lat, lng);
  }

  async function handleAddFavorite(coord: Coordinate) {
    /*
      默认名直接用当前地名。

      搜到「杭州大剧院」再点收藏，默认却填着「我的收藏」，等于每次都要手动改一遍。
      地名已经在卡片上显示着了，拿来当默认值才是顺手的那个选择；
      反查不出地名时（空地、隧道开着）再退回通用名。
    */
    const suggested = placeName.trim() || "我的收藏";
    const name = await Dialog.prompt({
      title: "收藏此位置",
      message: `经度 ${coord.longitude.toFixed(6)}  纬度 ${coord.latitude.toFixed(6)}`,
      defaultValue: suggested,
      placeholder: "备注名称（如：公司、家）",
      selectAll: true,
      confirmLabel: "保存",
      cancelLabel: "取消",
    });
    if (name == null) return;

    const trimmed = name.trim();
    if (trimmed) {
      setFavorites(addFavorite(trimmed, coord.latitude, coord.longitude));
      fireToast(`已收藏：${trimmed}`);
    }
  }

  async function handleLinkParse() {
    const rawUrl = await Dialog.prompt({
      title: "解析地图链接或坐标",
      message: "支持 苹果/Google/高德/百度 地图链接或经纬度文本。",
      placeholder: "在此粘贴地图链接或经纬度",
      selectAll: true,
      confirmLabel: "解析并定位",
      cancelLabel: "取消",
    });
    if (rawUrl == null) return;

    const trimmed = rawUrl.trim();
    if (!trimmed) return;

    try {
      const result = await parseAndConvert(trimmed);
      handlePick({ latitude: result.latitude, longitude: result.longitude }, result.name);
      fireToast(result.name ? `已定位到：${result.name}` : "已成功定位");
    } catch (e) {
      await Dialog.alert({
        title: "解析失败",
        message: e instanceof Error ? e.message : String(e),
        buttonLabel: "好",
      });
    }
  }

  async function handlePickFromMap() {
    try {
      const picked = await Location.pickFromMap();
      if (picked) handlePick({ latitude: picked.latitude, longitude: picked.longitude });
    } catch (e) {
      showErrorAlert(`选点失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleCurrentLocation() {
    try {
      // GPS 是 WGS-84，摆到地图上要先转成地图系，否则在国内会偏数百米。
      const gps = await Location.requestCurrent({ forceRequest: true });
      if (gps) {
        const mapped = fromDeviceCoordinate(gps.latitude, gps.longitude);
        handlePick({ latitude: mapped.latitude, longitude: mapped.longitude });
        fireToast("已定位到当前位置");
      }
    } catch (e) {
      showErrorAlert(`定位失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 设置页改一项存一项，不在这里关表单，也不弹提示——否则每敲一个字都要弹。 */
  function handleSettingsChange(next: AppSettings) {
    setSettings(next);
    saveSettings(next);
    layer.setValue(next.defaultLayer);
    debugLog("settings", "已保存", JSON.stringify(next));

    // 灵动岛样式改了要立刻推一次更新：卡片的内容只在 start/update 时重算，
    // 不主动推的话改完要等下一次坐标变动才生效，看起来就像「设置没用」。
    //
    // 不要求有进行中的会话——卡片可能是上一次留下的，那时 activeLoc 已经是 null，
    // 但岛上还挂着旧内容（之前就是这样：设置里改成了新值，岛上还是旧的）。
    const loc = activeLoc.value ?? { latitude: coordLat.value, longitude: coordLng.value };
    void updateLiveActivity({ latitude: loc.latitude, longitude: loc.longitude }, next);
  }

  function handleDeleteFav(id: string) {
    setFavorites(removeFavorite(id));
    fireToast("已删除");
  }

  function handleClearAllFav() {
    clearFavorites();
    setFavorites([]);
    fireToast("已清空收藏");
  }

  function isCurrentCoordFavorited(): boolean {
    if (!coordReady.value) return false;
    return favorites.some(
      (f) =>
        Math.abs(f.latitude - coordLat.value) < 1e-6 && Math.abs(f.longitude - coordLng.value) < 1e-6,
    );
  }

  function handleRemoveCurrentFavorite() {
    const fav = favorites.find(
      (f) =>
        Math.abs(f.latitude - coordLat.value) < 1e-6 && Math.abs(f.longitude - coordLng.value) < 1e-6,
    );
    if (fav) handleDeleteFav(fav.id);
  }

  async function openPairingPage() {
    await Navigation.present({ element: <PairingPage /> });
    setPairing(loadPairing());
  }

  /** 地图系坐标 → 真正下发给设备的坐标：先换算坐标系，再按设置加扰动。 */
  function deviceCoordinate(lat: number, lng: number): Coordinate {
    const converted = toDeviceCoordinate(lat, lng);
    return applyJitter(converted.latitude, converted.longitude, settings.jitterRadius);
  }

  function markActive(lat: number, lng: number) {
    const loc: ActiveLocation = { latitude: lat, longitude: lng };
    activeLoc.setValue(loc);
    saveActiveCache(loc);
  }

  /**
   * 申请后台保活。
   *
   * `keepAlive()` 返回的是 **boolean**：系统拒绝时 resolve(false) 而不是 reject。
   * 之前只接了 reject 分支，被拒也当成成功，于是锁屏掉线时界面上毫无线索。
   * 文档：Scripting Documentation / background_keeper。
   */
  async function acquireKeepAlive(): Promise<void> {
    try {
      const started = await BackgroundKeeper.keepAlive();
      debugLog("keepalive", `keepAlive() 返回 ${started}`);
      if (!started) {
        fireToast("系统拒绝了后台保活，锁屏后会掉线");
        return;
      }
      // 以应用自己报的状态为准，不是以我们调过为准。
      const active = await BackgroundKeeper.isActive;
      debugLog("keepalive", `isActive=${active}`);
      if (!active) fireToast("后台保活未生效，锁屏后可能掉线");
    } catch (error) {
      debugLog("keepalive", "申请后台保活出错", describeError(error));
      fireToast("后台保活未生效，锁屏后可能掉线");
    }
  }

  /**
   * 会话期间跟着前后台切换维持保活。
   *
   * 文档建议的用法就是进后台时 keepAlive、回前台时 stopKeepAlive——
   * 保活队列是引用计数的，重复调用安全。只在会话进行中才续，
   * 空闲时让它停掉，免得白耗电。
   */
  useEffect(() => {
    const listener = (phase: ScenePhase) => {
      // inactive 是前后台切换的过渡态，下面也不据此做任何事。记它纯属刷屏——
      // 一次切换就能刷出 active → inactive → background 三条。
      if (phase !== "inactive") debugLog("keepalive", `scenePhase=${phase}`);
      if (session.value === null) return;
      if (phase === "background") void acquireKeepAlive();
      else if (phase === "active") void BackgroundKeeper.stopKeepAlive().catch(() => undefined);
    };
    AppEvents.scenePhase.addListener(listener);
    return () => AppEvents.scenePhase.removeListener(listener);
  }, []);

  /*
    接住锁屏 / 灵动岛上「恢复真实位置」的请求。

    那个按钮的 intent 跑在单独的环境里，拿不到这里的会话；会话心跳又每 4 秒
    重发一次假坐标，intent 自己连上去发停止，几秒后就被盖回去——真机上表现为
    「卡片没了，定位还在」。所以会话进行中这里每秒报一次平安、看一眼有没有请求，
    有就走和「停止」按钮同一条路收尾，再把结果回执给 intent（见 app_intents.tsx）。

    经 ref 调用 handleStopSession：这个定时器只在挂载时建一次，直接引用会一直
    拿着第一次渲染时的那份函数。
  */
  const stopSessionRef = useRef(handleStopSession);
  stopSessionRef.current = handleStopSession;
  useEffect(() => {
    let busy = false;
    let beating = false;
    const timer = setInterval(() => {
      if (busy) return;
      if (session.value === null) {
        if (beating) {
          clearSessionBeat();
          beating = false;
        }
        return;
      }
      markSessionBeat();
      beating = true;
      const id = takeRestoreRequest();
      if (!id) return;
      busy = true;
      debugLog("liveactivity", "收到卡片上的恢复请求");
      void stopSessionRef.current(true)
        .then((failure) => ackRestore({ id, ok: failure === null, message: failure ?? undefined }))
        .finally(() => {
          busy = false;
        });
    }, RESTORE_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * 会话异常中断的统一收尾。
   *
   * 锁屏、切后台、系统回收隧道都会打断 RSD 连接（典型是
   * `RSDTCPAdapter.Failure 错误 0`）。定点模拟可以原地重连——整条链路从配对
   * 到下发不到一秒，比弹个框让用户自己重来强得多。
   *
   * @param retry 能重连就传重连动作；不能（比如移动中）传 null
   */
  async function handleSessionDropped(message: string, retryPoint: Coordinate | null) {
    debugLog("ui", "会话中断", message);
    session.setValue(null);
    // 恢复记录故意不删：连接是异常断的，停止指令未必送达，
    // 下次启动仍要提示用户恢复。
    void BackgroundKeeper.stopKeepAlive().catch(() => undefined);

    if (retryPoint && !reconnecting.current) {
      reconnecting.current = true;
      setSessionState("connecting");
      setStatusMsg("连接中断，正在重连…");
      fireToast("连接中断，正在重连…");
      try {
        /*
          等一会儿再试，而且多试几次。

          掉线最常见的起因是网络刚切换——关掉飞行模式、WiFi 转蜂窝——这时候
          代理工具的 TUN 正在重建，立刻重连必然失败。上一版就是立即重连一次，
          失败后又把用户甩回蜂窝引导，连上再断、断了再弹，绕不出去。
        */
        for (let attempt = 1; attempt <= RECONNECT_TRIES; attempt++) {
          await delay(RECONNECT_DELAY_MS);
          try {
            await connectSession(retryPoint, retryPoint);
            debugLog("ui", `断线重连成功（第 ${attempt} 次）`);
            fireToast("已重新连上");
            return;
          } catch (error) {
            debugLog("ui", `断线重连第 ${attempt} 次失败`, describeError(error));
          }
        }
      } finally {
        reconnecting.current = false;
      }
    }

    setSessionState("idle");
    setStatusMsg("");
    activeLoc.setValue(null);
    saveActiveCache(null);
    void endLiveActivity();
    showErrorAlert(message);
  }

  async function handleStartSession() {
    if (!pairing) {
      showErrorAlert("还没有配对。去「配对」页点「配对这台设备」，或导入已有的配对记录");
      return;
    }
    if (!coordReady.value) {
      showErrorAlert("请先在地图上选择目标位置");
      return;
    }

    const lat = coordLat.value;
    const lng = coordLng.value;
    const target = deviceCoordinate(lat, lng);

    setSessionState("connecting");
    setStatusMsg("准备中…");
    debugLog(
      "ui",
      `开始模拟：地图系 ${lat.toFixed(6)}, ${lng.toFixed(6)} → 设备 ${target.latitude.toFixed(6)}, ${target.longitude.toFixed(6)}（扰动 ${settings.jitterRadius}m）`,
    );

    /*
      走和「移动」面板同一条路。

      这里原先自己抄了一遍 startLocationSession 的调用和善后，于是后来给
      ensureSession 加的蜂窝引导、失败分诊这些，主按钮一概享受不到——用户点
      「开始位置模拟」连不上，弹的还是那段生硬的错误文字。两处行为必须一致，
      就只能有一份实现。
    */
    try {
      await connectSession({ latitude: lat, longitude: lng }, { latitude: lat, longitude: lng });
      fireToast("位置模拟已启动");
    } catch (e) {
      setSessionState("idle");
      setStatusMsg("");
      debugLog("ui", "启动失败", describeError(e));
      // 连不上先问一句，别直接甩错误——详见 ensureSession 里同样这段
      guideStart.current = { latitude: lat, longitude: lng };
      guideDropRetry.current = { latitude: lat, longitude: lng };
      guideError.current = e;
      guideAttempts.setValue(0);
      guideStage.setValue("help");
    }
  }

  // ── 移动模拟 ──────────────────────────────────────────────────────

  /** 把地图系坐标推给设备，并同步界面上的「正在模拟」标记。 */
  async function pushCoordinate(handle: LocationSessionHandle, point: Coordinate): Promise<void> {
    const target = deviceCoordinate(point.latitude, point.longitude);
    await handle.update(target.latitude, target.longitude);
    markActive(point.latitude, point.longitude);
    void updateLiveActivity(point);
  }

  // ── 锁屏 / 灵动岛卡片 ──────────────────────────────────────────────

  /** 会话起始时间，卡片上的计时器由系统按它自己走。 */
  const sessionStartedAt = useRef(Date.now());

  /**
   * @param override 设置页刚改完、state 还没刷新时传进来的新设置。
   *                 不传就用当前 settings。
   */
  function liveActivityState(point: Coordinate, override?: AppSettings): SimulationState {
    const conf = override ?? settings;
    const info = modeInfo(selection.mode);
    const moving = movementKind !== "none";
    // 摇杆是手推的，没有「总长」可言；沿路线/手绘才有进度。
    const walk = movementKind === "route" ? walker.value?.state : undefined;
    return {
      title: cardStatus(conf),
      place: cardTitle(conf),
      latitude: point.latitude,
      longitude: point.longitude,
      mode: moving ? (movementKind === "joystick" ? `摇杆 · ${info.label}` : info.label) : "",
      modeIcon: moving ? info.systemImage : "",
      speedKmh: moving ? selection.speed.metresPerSecond * 3.6 : 0,
      travelled: walk?.travelled ?? 0,
      total: walk?.total ?? 0,
      leg: (walk?.leg ?? 0) + 1,
      paused: walk?.paused ?? false,
      startedAt: sessionStartedAt.current,
      tint: conf.islandTint,
      compactIcon: islandIcon(moving ? info.systemImage : "", conf),
      compactIconIsEmoji: conf.islandIcon === "emoji",
      compactText: islandText(point, walk, conf),
      compactTimer: conf.islandText === "elapsed",
      restoreTint: conf.restoreTint,
    };
  }

  /**
   * 锁屏卡片的大标题。
   *
   * 留空时卡片那边只显示坐标，不会出现两行一模一样的坐标。
   * 地名要反向地理编码，开着本机隧道时经常查不到（见 resolvePlaceName），
   * 所以「地点名」实际上常常退回坐标——想固定显示别的就选自定义。
   */
  /**
   * 卡片与灵动岛的大标题。
   *
   * 返回空串表示「交给卡片自己按状态生成」——自定义模式下用户没填内容时
   * 也走这条，总比顶着一行空白强。
   */
  function cardStatus(conf: AppSettings): string {
    return conf.cardStatus === "custom" ? conf.cardCustomStatus.trim() : "";
  }

  function cardTitle(conf: AppSettings): string {
    switch (conf.cardTitle) {
      case "place":
        return placeName;
      case "coord":
        return "";
      case "custom":
        return conf.cardCustomTitle.trim();
    }
  }

  /** 收起态图标：按设置决定用方式图标、固定箭头、Emoji 还是不显示。 */
  function islandIcon(modeIcon: string, conf: AppSettings): string {
    switch (conf.islandIcon) {
      case "mode":
        return modeIcon || "location.fill";
      case "fixed":
        return "location.fill";
      case "emoji":
        return conf.islandEmoji.trim() || "📍";
      case "none":
        return "";
    }
  }

  /**
   * 收起态文字。
   *
   * 灵动岛那一条只有很窄一点宽度，所以这里都是短句，长了系统会截断。
   * 选了某项但当前场景没有对应数据（比如定点模拟选「速度」）时返回空串，
   * 卡片那边会直接不画，不会留一截空白。
   */
  function islandText(point: Coordinate, walk: WalkState | undefined, conf: AppSettings): string {
    const ratio = walk && walk.total > 0 ? walk.travelled / walk.total : null;
    /*
      收起态右侧只有六十来点宽，「39.918, 116.437」这种长度必然被砍成
      「39.918,…」——省略号顶着电池图标，什么也没说明。所以这里就按那个宽度
      来配：两位小数（约 1 km 精度，收起态本来也只是瞥一眼）、去掉空格。
      要精确坐标的话，卡片展开态和地图上都有完整的。
    */
    const shortCoord = `${point.latitude.toFixed(2)},${point.longitude.toFixed(2)}`;
    switch (conf.islandText) {
      case "elapsed":
        // 计时由卡片那边用系统计时器画（compactTimer），这里不出文字
        return "";
      case "status":
        return movementKind === "none" ? "模拟中" : walk?.paused ? "已暂停" : "移动中";
      case "place":
        // 地名放得下就用地名，放不下系统会按 minScaleFactor 缩，仍比坐标好认
        return placeName || shortCoord;
      case "coordinate":
        return shortCoord;
      case "speed":
        return movementKind === "none"
          ? ""
          : `${(selection.speed.metresPerSecond * 3.6).toFixed(1)}`;
      case "progress":
        return ratio === null ? "" : `${Math.round(ratio * 100)}%`;
      case "custom":
        return conf.islandCustomText.trim();
      case "none":
        return "";
    }
  }

  /**
   * 起锁屏 / 灵动岛卡片。
   *
   * 起不来最常见的原因是系统里把实时活动关掉了（设置 → Scripting → 实时活动），
   * 这种情况 start() 直接抛错，只记日志的话用户永远不知道为什么没卡片，
   * 所以先问一次 areActivitiesEnabled 再明确提示。
   */
  async function startLiveActivity(point: Coordinate) {
    try {
      const allowed = await LiveActivity.areActivitiesEnabled();
      debugLog("liveactivity", `areActivitiesEnabled=${allowed}`);
      if (!allowed) {
        fireToast("系统里关闭了实时活动，锁屏和灵动岛不会显示");
        return;
      }
      /*
        开新卡之前先把旧卡全清掉。

        实时活动的生命周期独立于脚本：退出 Scripting、脚本被系统回收，
        卡片都还留在锁屏和通知中心里。再进来开一次模拟就多一张，
        几轮下来能堆好几条「定点模拟」，而且每张都带着各自那个时间点的坐标。

        手上这个 `liveActivity` 句柄只认得本进程起的那张，收不掉上一轮留下的，
        所以必须用静态的 endAllActivities。
      */
      await LiveActivity.endAllActivities({ dismissTimeInterval: 0 }).catch(() => undefined);
      /*
        每次都从工厂拿一个新实例。

        `LiveActivity.register` 返回的是工厂函数，而一个实例内部有 `_started`
        标志、`start()` 一生只许调一次（再调就是
        "this method must only be called once"）。整个会话复用同一个实例的话，
        第二次开模拟就永远起不来卡片——而且只记日志不报错，表现是「突然没灵动岛了」。
      */
      liveActivity.setValue(SimulationLiveActivity());
      await liveActivity.value.start(liveActivityState(point));
      debugLog("liveactivity", "卡片已启动");
    } catch (error) {
      debugLog("liveactivity", "实时活动启动失败", describeError(error));
      fireToast("锁屏卡片启动失败，不影响定位模拟");
    }
  }

  async function updateLiveActivity(point: Coordinate, override?: AppSettings) {
    try {
      await liveActivity.value.update(liveActivityState(point, override));
    } catch {
      // 卡片已被用户划掉时更新会失败，忽略即可。
    }
  }

  async function endLiveActivity() {
    try {
      // end 要求带一份最终状态，用当前位置凑一份即可——dismissTimeInterval 为 0，
      // 卡片立刻消失，这份内容不会被看到。
      const last = activeLoc.value;
      await liveActivity.value.end(
        liveActivityState({
          latitude: last?.latitude ?? 0,
          longitude: last?.longitude ?? 0,
        }),
        { dismissTimeInterval: 0 },
      );
    } catch {
      // 没开起来过就没什么好收的。
    }
  }

  function clearMovementTimer() {
    const timer = movementTimer.value;
    if (timer !== null) {
      clearInterval(timer);
      movementTimer.setValue(null);
    }
  }

  function stopMovement() {
    clearMovementTimer();
    walker.setValue(null);
    joystickVector.setValue({ dx: 0, dy: 0 });
    joystickPosition.setValue(null);
    setMovementKind("none");
    setPaused(false);
  }

  /**
   * 暂停 / 继续。
   *
   * 定时器照常走，只是推进器不再前进——心跳仍在下发当前坐标，
   * 设备不会因为久不收坐标而把会话收掉。
   */
  function togglePaused() {
    const current = walker.value;
    if (!current) return;
    const next = !current.isPaused;
    current.setPaused(next);
    setPaused(next);
    fireToast(next ? "已暂停" : "继续移动");
  }

  /** 原地调头，当前位置不变。 */
  function reverseMovement() {
    const current = walker.value;
    if (!current) return;
    current.reverse();
    fireToast("已反向");
  }

  /**
   * 确保有一个活动会话，起点为给定坐标。
   *
   * 已经在模拟就直接复用——移动只是不断改坐标，没必要断开重连。
   */
  /**
   * 建立会话的那一段，拆出来是为了能被蜂窝引导的重试循环反复调用。
   *
   * 成功返回句柄，失败把错误原样抛出去——是报错还是转交引导，由调用方决定。
   */
  async function connectSession(
    start: Coordinate,
    /**
     * 掉线后要重连到哪个点；null 表示不重连。
     *
     * 定点模拟传自己的坐标——位置是个固定值，重连一次就回来了。
     * 沿路线/摇杆移动传 null：重连要从头建会话，而路径进度、往返计数都在
     * PathWalker 里，续不上，只能停掉如实报错，让用户自己决定重来。
     *
     * 这里收坐标而不是回调，是因为上一版传的回调正是 handleStartSession，
     * 而它失败会弹蜂窝引导——于是「断线→重连→失败→弹引导→连上→再断线」
     * 转成了死循环。重连该自己闷头试，不该把用户拽回引导。
     */
    reconnectTo: Coordinate | null = null,
  ): Promise<LocationSessionHandle> {
    const target = deviceCoordinate(start.latitude, start.longitude);
    const handle = await startLocationSession({
      record: pairing!,
      endpoint: { host: settings.deviceHost, source: settings.tunnelSource },
      latitude: target.latitude,
      longitude: target.longitude,
      keepAlive: settings.keepAlive,
      onStatus: (message) => {
        debugLog("status", message);
        setStatusMsg(message);
      },
      onFailure: (message) => {
        if (!reconnectTo) stopMovement();
        void handleSessionDropped(message, reconnectTo);
      },
    });

    session.setValue(handle);
    setSessionState("active");
    markActive(start.latitude, start.longitude);
    const now = new Date().toISOString();
    saveRecovery({
      latitude: start.latitude,
      longitude: start.longitude,
      startedAt: now,
      updatedAt: now,
    });
    void acquireKeepAlive();
    sessionStartedAt.current = Date.now();
    void startLiveActivity(start);
    /*
      收尾状态在这里设，不交给调用方。

      之前只有「开始位置模拟」那条路自己设了，引导重试成功的那条没设——
      于是界面一直停在 startLocationSession 报的最后一句「下发坐标…」上，
      底下却已经显示「模拟中」了，自相矛盾。
    */
    setStatusMsg(`模拟中 · ${start.latitude.toFixed(5)}, ${start.longitude.toFixed(5)}`);
    return handle;
  }

  async function ensureSession(start: Coordinate): Promise<LocationSessionHandle | null> {
    const existing = session.value;
    if (existing) {
      await pushCoordinate(existing, start);
      return existing;
    }

    if (!pairing) {
      showErrorAlert("还没有配对。去「配对」页点「配对这台设备」，或导入已有的配对记录");
      return null;
    }

    setSessionState("connecting");
    setStatusMsg("准备中…");
    try {
      return await connectSession(start);
    } catch (e) {
      setSessionState("idle");
      setStatusMsg("");
      debugLog("ui", "启动失败", describeError(e));
      /*
        连不上先问一句，别直接甩错误。

        最常见的原因是在用蜂窝数据——mDNS 在蜂窝接口上找不到配对服务，而这个
        要用户临时开一下飞行模式才能绕过去，光报个 Connection refused 没人知道
        该干什么。读不到网络类型（Scripting 没有这个 API），所以让用户自己说。
      */
      guideStart.current = start;
      // 移动场景不自动重连，理由见 connectSession 的 onDropRetry
      guideDropRetry.current = null;
      guideError.current = e;
      guideAttempts.setValue(0);
      guideStage.setValue("help");
      return null;
    }
  }

  /*
    蜂窝数据引导。

    用户确认在用移动数据之后，这里每 4 秒重试一次建会话——他在控制中心切飞行
    模式、再切回应用的这段时间里，脚本自己在试，连上就自动进入「可以关掉了」。
    不这么做的话，用户每切一次都得回来手动点一次重试。
  */
  /*
    轮询间隔。

    这个流程对时机敏感——隧道重连上的那个窗口不长，错过就得等下一轮。
    每轮自带 10 秒超时、又有 busy 闸挡着重入，所以间隔可以压短，
    真正的节流是「上一轮没结束就不开新的」而不是这个数字。
  */
  /*
    两轮之间的喘息。

    不是「每隔这么久试一次」——真正决定节奏的是上一轮多快结束：失败立刻接下一轮，
    这个值只用来避免失败得太快时把 CPU 打满。隧道重连上的窗口很短，
    固定节拍很容易整个错过。
  */
  const GUIDE_RETRY_MS = 500;

  function stopGuideLoop() {
    // 轮次号往前推一格：已经发出去的那一轮即便迟到成功，也不会再改状态
    guideRun.current += 1;
    guideBusy.current = false;
    const timer = guideTimer.current;
    if (timer !== null) {
      clearTimeout(timer);
      guideTimer.current = null;
    }
  }

  /**
   * 在引导里跑一次建会话。轮询和「立刻重试」共用这一个。
   *
   * 成功就进第三阶段；失败什么都不做——用户还在切飞行模式，失败本来就是
   * 流程的一部分，弹个错只会打断他。
   */
  const GUIDE_ATTEMPT_TIMEOUT_MS = 10000;

  function attemptInGuide() {
    const start = guideStart.current;
    // 上一次还没跑完就跳过，免得几条建会话的流程叠在一起
    if (!start || guideBusy.current) return;
    guideBusy.current = true;
    const run = ++guideRun.current;
    guideAttempts.setValue(guideAttempts.value + 1);
    /*
      每一轮都要能自己结束。

      JS 没法取消已经发出的 Promise，而底下任何一步挂死都会让这一轮永远不落地，
      `guideBusy` 跟着一直为真——后面每次重试都被静默跳过，用户看到的就是
      「已试 2 次」之后再无动静。包一层超时，到点就放弃这一轮、放开闸门，
      让下一轮能重新发起。原生那版靠 Task.cancel 做同样的事。
    */
    void withTimeout(connectSession(start, guideDropRetry.current), GUIDE_ATTEMPT_TIMEOUT_MS, "本轮超时")
      .then(() => {
        // 过期那一轮迟到的成功不算数，否则会把已经收起的引导又翻出来
        if (run !== guideRun.current) return;
        stopGuideLoop();
        guideStage.setValue("airplaneOff");
      })
      .catch((error) => {
        /*
          飞行模式开着的那几秒必然是 ENETUNREACH——隧道跟着断了。
          这是流程的一部分，不是故障，记一行短的就够；其他错误才值得记全。
        */
        const code = (error as { code?: string } | null)?.code ?? "";
        if (code === "ENETUNREACH") {
          debugLog("guide", `第 ${guideAttempts.value} 次：网络不可达（飞行模式开着时正常）`);
        } else {
          debugLog("guide", `第 ${guideAttempts.value} 次重试仍失败`, describeError(error));
        }
      })
      .finally(() => {
        if (run !== guideRun.current) return;
        guideBusy.current = false;
        /*
          这一轮刚落地就排下一轮。

          原先用 setInterval 按固定节拍打，一轮要是只花 200 ms 失败，也得干等到
          下一个节拍；而隧道重连上的窗口很短，很容易整段错过。现在是「结束即续」，
          快慢完全跟着上一轮走。
        */
        if (guideStage.value === "airplaneOn") {
          guideTimer.current = setTimeout(attemptInGuide, GUIDE_RETRY_MS);
        }
      });
  }

  function beginGuideLoop() {
    if (!guideStart.current) return;
    stopGuideLoop();
    guideAttempts.setValue(0);
    guideStage.setValue("airplaneOn");
    /*
      先立刻试一次，再开始轮询。

      setInterval 的第一次触发要等满一个间隔——用户点完「我正在使用移动数据」
      得先干等几秒才看到次数动，期间完全不知道它有没有在工作。
    */
    // 立刻开跑；后面每一轮由 attemptInGuide 自己接上
    attemptInGuide();
  }

  function dismissGuide(showError: boolean) {
    stopGuideLoop();
    guideStage.setValue(null);
    const error = guideError.current;
    guideStart.current = null;
    guideError.current = null;

    /*
      会话已经连上时，收起引导不能动状态。

      第三阶段的「完成」走的也是这里，而它原先无条件把 sessionState 打回 idle、
      清掉状态文案——界面于是从「更新坐标 / 恢复真实位置」变回「开始位置模拟」，
      看着像根本没连上，用户只好再开关一轮飞行模式，怎么都走不出去。
      连上了就只收起引导，其余一概不碰。
    */
    if (session.value) return;

    setSessionState("idle");
    setStatusMsg("");
    if (showError && error) {
      showErrorAlert(error instanceof Error ? error.message : String(error));
    }
  }

  async function retryFromGuide() {
    const start = guideStart.current;
    if (!start) return;
    stopGuideLoop();
    guideStage.setValue(null);
    setSessionState("connecting");
    setStatusMsg("准备中…");
    try {
      await connectSession(start, guideDropRetry.current);
      guideStart.current = null;
      guideError.current = null;
    } catch (e) {
      debugLog("ui", "引导内重试失败", describeError(e));
      guideError.current = e;
      guideStage.setValue("help");
      setSessionState("idle");
      setStatusMsg("");
    }
  }

  /** 以给定坐标序列为路径开始移动（路线、GPX 共用）。 */
  async function startWalking(path: Coordinate[], choice: MovementSelection, label: string) {
    if (path.length < 2) {
      showErrorAlert("路径至少需要两个点");
      return;
    }

    let instance: PathWalker;
    try {
      instance = new PathWalker(path, choice.speed.metresPerSecond, choice.lapPlan);
    } catch (e) {
      showErrorAlert(e instanceof Error ? e.message : String(e));
      return;
    }

    const handle = await ensureSession(path[0]);
    if (!handle) return;

    stopMovement();
    walker.setValue(instance);
    setMovementKind("route");
    setSelection(choice);

    const kmh = (choice.speed.metresPerSecond * 3.6).toFixed(1);
    setStatusMsg(`${label} · ${modeInfo(choice.mode).label} ${kmh} km/h`);

    const timer = setInterval(() => {
      const current = walker.value;
      const active = session.value;
      if (!current || !active) return;

      const state = current.advance(MOVEMENT_TICK_MS / 1000);
      void pushCoordinate(active, state.coordinate).catch((error) => {
        debugLog("ui", "移动中下发坐标失败", describeError(error));
      });

      const travelledKm = (state.travelled / 1000).toFixed(2);
      const totalKm = (state.total / 1000).toFixed(2);
      const legText = state.leg > 0 ? ` · 第 ${state.leg + 1} 趟` : "";
      const pauseText = state.paused ? " · 已暂停" : "";
      setStatusMsg(`${label} · ${travelledKm}/${totalKm} km${legText}${pauseText}`);

      if (state.finished) {
        clearMovementTimer();
        walker.setValue(null);
        setMovementKind("none");
        setStatusMsg("已到达终点");
        fireToast("已到达终点");
      }
    }, MOVEMENT_TICK_MS);
    movementTimer.setValue(timer);
  }

  async function handlePlanRoute(choice: MovementSelection): Promise<void> {
    if (!coordReady.value) throw new Error("请先在地图上选择终点");

    const began = Date.now();
    const lap = (tag: string) => debugLog("route", `${tag}（累计 ${Date.now() - began}ms）`);

    let start = routeStart;
    if (start) {
      lap("起点已手动指定");
    } else if (activeLoc.value) {
      /*
        正在模拟时，「当前位置」就是我们自己下发的那个坐标，直接拿来用。

        不能去问 Location：模拟中它返回什么由系统说了算，实测会给一个几小时前的
        缓存——曾经出现过起点落在一千多公里外的陈旧位置上，然后用步行方式
        去规划，MapKit 自然算不出来。而且这还白等一次定位。
      */
      start = { latitude: activeLoc.value.latitude, longitude: activeLoc.value.longitude };
      lap("起点取自当前模拟位置");
    } else {
      /*
        没在模拟，才去问真实定位。

        这里坚持 `forceRequest`：缓存返回得快，但可能是上一个城市的，
        拿它当起点规划出来的路线完全是错的。宁可等，也有超时兜底。
      */
      setStatusMsg("定位起点…");
      lap("开始取当前位置");
      const gps = await withTimeout(
        Location.requestCurrent({ forceRequest: true }),
        12000,
        "取当前位置超时，请在「移动」面板里手动把选中的点设为起点",
      );
      lap(`取到当前位置 ${gps ? "成功" : "为空"}`);
      if (!gps) throw new Error("取不到当前位置，请手动指定起点");
      // GPS 是 WGS-84，而终点取自地图（地图系），规划前要统一到地图系。
      start = fromDeviceCoordinate(gps.latitude, gps.longitude);
    }

    const transport = modeInfo(choice.mode).transportType;
    const straight = distanceBetween(start, { latitude: coordLat.value, longitude: coordLng.value });
    debugLog(
      "route",
      `规划 ${transport}：${start.latitude.toFixed(5)}, ${start.longitude.toFixed(5)}` +
        ` → ${coordLat.value.toFixed(5)}, ${coordLng.value.toFixed(5)}，直线 ${(straight / 1000).toFixed(2)} km`,
    );

    // 步行方式在长距离上 MapKit 经常算很久甚至算不出来，先提醒一句。
    if (transport === "walking" && straight > 50_000) {
      debugLog("route", "注意：步行方式 + 超过 50 km，MapKit 很可能拒绝或极慢");
    }

    setStatusMsg("规划路线…");
    lap("调用 MapDirections.calculate");
    // 没有超时参数，自己包一层——不然算不出来会一直挂着，界面上看不出任何动静。
    const result = await withTimeout(
      MapDirections.calculate({
        source: { latitude: start.latitude, longitude: start.longitude },
        destination: { latitude: coordLat.value, longitude: coordLng.value },
        transportType: transport,
        requestsAlternateRoutes: true,
      }),
      30000,
      `路线规划超时（${modeInfo(choice.mode).label} · 直线 ${(straight / 1000).toFixed(0)} km）。` +
        "距离太远或该方式没有可用路线时会这样——换个交通方式，或者把起点终点拉近一点。",
    );
    lap(`calculate 返回 ${result.routes.length} 条`);

    const usable = result.routes
      .filter((item) => item.coordinates.length >= 2)
      .map((item) => ({
        name: item.name,
        coordinates: item.coordinates.map((c) => ({ latitude: c.latitude, longitude: c.longitude })),
        distance: item.distance,
        travelTime: item.expectedTravelTime,
      }));
    debugLog(
      "route",
      `可用 ${usable.length} 条：` +
        usable.map((r) => `${(r.distance / 1000).toFixed(2)}km/${Math.round(r.travelTime / 60)}min`).join("、"),
    );
    if (usable.length === 0) throw new Error("没有找到可用路线");

    // 路线换成别的来源了，手绘那几个编号点必须跟着清掉——
    // 不然地图上会同时出现「上一次手绘的 ①②③④」和「这次规划的折线」，
    // 看起来像是编号标错了位置。
    applyDrawnPath([]);
    setRoutes(usable);
    setRouteIndex(0);
    setSelection(choice);
    setStatusMsg("");
    lap("完成");
  }

  function handleSelectRoute(index: number) {
    if (index >= 0 && index < routes.length) setRouteIndex(index);
  }

  function handleStartRoute(choice: MovementSelection) {
    const chosen = routes[routeIndex];
    if (!chosen) return;
    void startWalking(chosen.coordinates, choice, "沿路线移动");
  }

  // ── 起点与手绘路径 ────────────────────────────────────────────────

  function handleUseSelectionAsStart() {
    if (!coordReady.value) return;
    setRouteStart({ latitude: coordLat.value, longitude: coordLng.value });
    fireToast("已把选中的点设为起点");
  }

  function handleResetStart() {
    setRouteStart(null);
    fireToast("起点改回当前位置");
  }

  /** 点列变了就同步画出来——复用路线折线那条通道。 */
  function applyDrawnPath(next: Coordinate[]) {
    drawnRef.current = next;
    setDrawnPath(next);
    setRoutes(next.length > 0 ? [{ coordinates: next, distance: 0, travelTime: 0 }] : []);
    setRouteIndex(0);
  }

  function appendDrawnPoint(lat: number, lng: number) {
    const next = [...drawnRef.current, { latitude: lat, longitude: lng }];
    applyDrawnPath(next);
    fireToast(`已添加第 ${next.length} 个点`);
  }

  /** 进入手绘模式：收起面板，之后点地图就是落点。 */
  function handleBeginDrawing() {
    drawing.setValue(true);
    fireToast("手绘中：在地图上逐个点出要经过的位置");
  }

  /** 收笔。点够两个就直接把移动面板拉回来选速度，省得自己再找入口。 */
  function handleFinishDrawing() {
    drawing.setValue(false);
    if (drawnRef.current.length >= 2) openSheet("movement");
  }

  function handleAddDrawnPoint() {
    if (!coordReady.value) {
      showErrorAlert("请先在地图上选择位置");
      return;
    }
    appendDrawnPoint(coordLat.value, coordLng.value);
  }

  function handleUndoDrawnPoint() {
    applyDrawnPath(drawnRef.current.slice(0, -1));
  }

  function handleClearDrawnPath() {
    applyDrawnPath([]);
  }

  function handleStartDrawnPath(choice: MovementSelection) {
    drawing.setValue(false);
    void startWalking(drawnRef.current, choice, "沿手绘路径移动");
  }

  async function handleImportGPX(choice: MovementSelection): Promise<void> {
    const files = await DocumentPicker.pickFiles({ types: ["public.data", "public.item"] });
    if (!files || files.length === 0) return;

    const track = parseGPX(FileManager.readAsStringSync(files[0]));
    // GPX 按规范是 WGS-84，转成地图系后画在地图上才对得上。
    const path = track.coordinates.map((point) => fromDeviceCoordinate(point.latitude, point.longitude));

    applyDrawnPath([]);
    setRoutes([{ coordinates: path, distance: 0, travelTime: 0 }]);
    setRouteIndex(0);
    await startWalking(path, choice, track.name ? `GPX · ${track.name}` : "GPX 轨迹");
  }

  async function handleStartJoystick(choice: MovementSelection) {
    if (!coordReady.value) {
      showErrorAlert("请先在地图上选择起点");
      return;
    }

    const start: Coordinate = { latitude: coordLat.value, longitude: coordLng.value };
    const handle = await ensureSession(start);
    if (!handle) return;

    stopMovement();
    joystickPosition.setValue(start);
    setMovementKind("joystick");
    setSelection(choice);
    setStatusMsg(`摇杆 · ${modeInfo(choice.mode).label} ${(choice.speed.metresPerSecond * 3.6).toFixed(1)} km/h`);

    const timer = setInterval(() => {
      const current = joystickPosition.value;
      const active = session.value;
      const vector = joystickVector.value;
      if (!current || !active) return;

      const next = joystickStep(
        current,
        vector.dx,
        vector.dy,
        choice.speed.metresPerSecond,
        MOVEMENT_TICK_MS / 1000,
      );
      if (next.latitude === current.latitude && next.longitude === current.longitude) return;

      joystickPosition.setValue(next);
      /*
        「当前坐标」要跟着摇杆走。

        底部卡片显示的是选中点，不同步的话推了半天卡片还停在起点，
        点「更新坐标」会直接把位置拽回出发地。
        这里只写坐标不反查地名——每 500 ms 反查一次纯属给自己找麻烦，
        地名留到松手停下时再更新。
      */
      coordLat.setValue(next.latitude);
      coordLng.setValue(next.longitude);
      void pushCoordinate(active, next).catch((error) => {
        debugLog("ui", "摇杆下发坐标失败", describeError(error));
      });
    }, MOVEMENT_TICK_MS);
    movementTimer.setValue(timer);
  }

  /** @returns 失败原因；成功为 null */
  /**
   * 停止模拟。
   *
   * @param silent 由锁屏卡片的 intent 触发时传 true——那会儿用户在锁屏上，
   *               App 内的弹窗他看不见，失败原因由 intent 发通知告诉他。
   * @returns 失败原因；成功为 null
   */
  async function handleStopSession(silent = false): Promise<string | null> {
    stopMovement();
    const handle = session.value;
    session.setValue(null);
    setSessionState("idle");
    setStatusMsg("");
    activeLoc.setValue(null);
    saveActiveCache(null);
    void BackgroundKeeper.stopKeepAlive().catch(() => undefined);
    if (handle) {
      try {
        await handle.stop();
      } catch (e) {
        // 卡片和恢复记录都留着：停止指令没送到，设备可能还在模拟，
        // 卡片得继续提醒，下次启动也要接着提示恢复。
        // 说清后果：会话这边已经作废，但停止指令没送到，设备很可能还在模拟
        const message =
          `停止时出错：${e instanceof Error ? e.message : String(e)}。` +
          "设备可能仍在模拟位置，重新连接后再停一次。";
        if (!silent) showErrorAlert(message);
        return message;
      }
    }
    clearRecovery();
    void endLiveActivity();
    fireToast("已恢复真实位置");
    return null;
  }

  async function handleUpdateCoord() {
    const handle = session.value;
    if (!handle || !coordReady.value) return;

    const lat = coordLat.value;
    const lng = coordLng.value;
    const target = deviceCoordinate(lat, lng);
    try {
      await handle.update(target.latitude, target.longitude);
      setStatusMsg(`模拟中 · ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      markActive(lat, lng);
      void updateLiveActivity({ latitude: lat, longitude: lng });
      fireToast("坐标已更新");
    } catch (e) {
      showErrorAlert(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 启动时那枚致谢条。
   *
   * 来源不止一处（界面基座、协议参考、搜索服务），一个按钮跳不了那么多链接，
   * 所以点开的是关于页里的完整名单，而不是其中某一个仓库。
   */
  function handleOpenCreditLink() {
    void Navigation.present({ element: <AboutPage /> });
  }

  function buildSheetContent(kind: SheetKind): VirtualNode | null {
    switch (kind) {
      case "settings":
        return <SettingsPage settings={settings} onChange={handleSettingsChange} onDone={closeSheet} />;
      case "favorites":
        return (
          <FavoritesPage
            favorites={favorites}
            history={history}
            active={activeLoc.value}
            onPick={(coord: Coordinate, name?: string) => handlePick(coord, name)}
            onDelete={handleDeleteFav}
            onClearAll={handleClearAllFav}
            onClearHistory={() => {
              clearHistory();
              setHistory([]);
              fireToast("已清空历史");
            }}
          />
        );
      case "search":
        return (
          <SearchPage
            globalEndpoint={settings.globalSearchEndpoint.trim() || DEFAULT_GLOBAL_ENDPOINT}
            onPick={(coord: Coordinate, name: string) => {
              handlePick(coord, name);
              if (name) fireToast(`已定位到：${name}`);
            }}
          />
        );
      case "movement":
        return (
          <MovementPanel
            initial={selection}
            routes={routes.map((item, index) => ({
              label: item.name?.trim() || `方案 ${index + 1}`,
              detail: describeRoute(item),
            }))}
            selectedRouteIndex={routeIndex}
            onSelectRoute={handleSelectRoute}
            hasDestination={coordReady.value}
            startLabel={
              routeStart
                ? `${routeStart.latitude.toFixed(4)}, ${routeStart.longitude.toFixed(4)}`
                : "当前真实位置"
            }
            drawnCount={drawnPath.length}
            onPlanRoute={handlePlanRoute}
            onStartRoute={handleStartRoute}
            onImportGPX={handleImportGPX}
            onStartJoystick={handleStartJoystick}
            onUseSelectionAsStart={handleUseSelectionAsStart}
            onResetStart={handleResetStart}
            onBeginDrawing={handleBeginDrawing}
            onAddDrawnPoint={handleAddDrawnPoint}
            onUndoDrawnPoint={handleUndoDrawnPoint}
            onClearDrawnPath={handleClearDrawnPath}
            onStartDrawnPath={handleStartDrawnPath}
          />
        );
      default:
        return null;
    }
  }

  function describeRoute(item: PlannedRoute): string {
    if (item.distance <= 0) return `${item.coordinates.length} 个点`;
    const km = (item.distance / 1000).toFixed(2);
    // 按所选速度自己算耗时——地图给的是按真实路况估的，与要走的速度对不上。
    const minutes = Math.max(1, Math.round(item.distance / selection.speed.metresPerSecond / 60));
    return `${km} km · 按当前速度约 ${minutes} 分钟`;
  }

  const sheetContent = buildSheetContent(sheetKind.value);
  const loc = activeLoc.value;

  const topBtnSize = 24;
  const topBtnPadding = 9;

  function topBtn(icon: string, tint: Color, action: () => void) {
    return (
      <Button action={action} glassEffect="circle">
        <Image
          systemName={icon}
          foregroundStyle={tint}
          frame={{ width: topBtnSize, height: topBtnSize }}
          padding={topBtnPadding}
        />
      </Button>
    );
  }

  /**
   * 展开时一个接一个弹出来，收起时倒着收回去。
   *
   * 这里必须用 `transition` 而不是 `scaleEffect` + `animation`：
   * 按钮是条件渲染的，展开那一刻才被插入视图树。`animation={{value}}` 动画的是
   * 「已存在的视图上某个值变了」，而这些按钮一出生 `open` 就是 true，没有变化
   * 可动画，`.delay()` 也就永远不会生效——会变成一起蹦出来。
   * `transition` 管的正是插入 / 移除本身，延迟挂在它上面才有波浪。
   *
   * index 是「离齿轮多远」，count 是这条扇形上一共几个；
   * anchor 让缩放朝着齿轮那一侧收，看起来像从齿轮里长出来。
   */
  function menuBtn(
    entry: MenuEntry,
    { index, count, anchor }: { index: number; count: number; anchor: KeywordPoint },
  ) {
    // 每次重新构造：`animation()` 是否原地修改没写明，共用一个实例可能被后一次覆盖
    const pop = () => Transition.scale(0.1, anchor).combined(Transition.opacity());
    return (
      <Button
        key={entry.icon}
        action={entry.action}
        glassEffect="circle"
        transition={Transition.asymmetric(
          // 展开：带回弹，从齿轮那头逐个往外推
          pop().animation(
            Animation.bouncy({ duration: 0.42, extraBounce: 0.32 }).delay(index * 0.055),
          ),
          // 收起：不回弹也更快，最远的先走，像被一路收回齿轮里
          pop().animation(Animation.easeIn(0.16).delay((count - 1 - index) * 0.035)),
        )}
      >
        <Image
          systemName={entry.icon}
          foregroundStyle={entry.tint}
          frame={{ width: topBtnSize, height: topBtnSize }}
          padding={topBtnPadding}
        />
      </Button>
    );
  }

  /*
    菜单落在哪个角。
    右上角是 MapKit 自带控件（定位、3D、指南针）的固定位置，`controls` 没有
    放置位置的参数，那三个挪不动，所以只开放另外三个角。
    扇形永远朝屏幕内侧展开：贴底就往上长，靠右就往左铺。
  */
  const atBottom = settings.menuCorner !== "topLeft";
  const atRight = settings.menuCorner === "bottomRight";
  /** 摇杆躲去菜单没占的那个底角，省得抢位置。 */
  const joystickOnRight = settings.menuCorner === "bottomLeft";

  const gearBtn = topBtn(
    menuOpen.value ? "xmark.circle.fill" : "gearshape",
    menuOpen.value ? "systemBlue" : "label",
    toggleMenu,
  );

  /** 竖排那组，从挨着齿轮的一个开始。 */
  const columnEntries: MenuEntry[] = [
    { icon: layerIcon(layer.value), tint: "label", action: cycleLayer },
    { icon: "location", tint: "systemBlue", action: () => withMenuClosed(handleCurrentLocation) },
    {
      icon: "personalhotspot",
      tint: pairing ? "systemGreen" : "systemOrange",
      action: () => withMenuClosed(openPairingPage),
    },
    { icon: "gearshape.2", tint: "label", action: () => withMenuClosed(() => openSheet("settings")) },
  ];

  /** 横排那组，同样从挨着齿轮的一个开始。 */
  const rowEntries: MenuEntry[] = [
    {
      icon: favorites.length > 0 ? "star.fill" : "star",
      tint: favorites.length > 0 ? "systemYellow" : "label",
      action: () => withMenuClosed(() => openSheet("favorites")),
    },
    { icon: "link", tint: "label", action: () => withMenuClosed(handleLinkParse) },
    { icon: "mappin.and.ellipse", tint: "label", action: () => withMenuClosed(handlePickFromMap) },
    { icon: "magnifyingglass", tint: "label", action: () => withMenuClosed(() => openSheet("search")) },
  ];

  /**
   * 铺开一组入口。
   *
   * `reversed` 只影响摆放顺序，动画序号仍按「离齿轮多远」算——
   * 波浪永远从齿轮那头往外扩散，四个方向观感一致。
   */
  function fanGroup(entries: MenuEntry[], reversed: boolean, axis: "row" | "column") {
    if (!menuOpen.value) return null;
    // 缩放锚点朝着齿轮，按钮看起来是从齿轮里挤出来的，不是凭空浮现
    const anchor: KeywordPoint =
      axis === "row" ? (reversed ? "trailing" : "leading") : reversed ? "bottom" : "top";
    const ordered = reversed ? [...entries].reverse() : entries;
    return (
      <>
        {ordered.map((entry, i, arr) =>
          menuBtn(entry, {
            index: reversed ? arr.length - 1 - i : i,
            count: arr.length,
            anchor,
          }),
        )}
      </>
    );
  }

  /*
    齿轮和竖排绑在同一个 VStack：竖排自动对齐到齿轮正上/正下方，
    不必按按钮直径去算边距——玻璃效果的实际直径由系统决定，算出来的值迟早会错位。
  */
  const gearStack = (
    <VStack spacing={8}>
      {atBottom ? fanGroup(columnEntries, true, "column") : null}
      {gearBtn}
      {atBottom ? null : fanGroup(columnEntries, false, "column")}
    </VStack>
  );

  const menuCluster = (
    <HStack
      alignment={atBottom ? "bottom" : "top"}
      spacing={8}
      frame={{ maxWidth: "infinity" }}
      padding={atBottom ? { bottom: 8 } : undefined}
    >
      {atRight ? <Spacer /> : null}
      {atRight ? fanGroup(rowEntries, true, "row") : null}
      {gearStack}
      {atRight ? null : fanGroup(rowEntries, false, "row")}
      {atRight ? null : <Spacer />}
    </HStack>
  );

  return (
    <ZStack
      sheet={
        sheetKind.value && sheetContent ? { content: sheetContent, isPresented: showSheet } : undefined
      }
      alert={{
        title: "提示",
        message: <Text>{errorMsg.value}</Text>,
        actions: <Button title="好" action={() => showError.setValue(false)} />,
        isPresented: showError,
      }}
      toast={
        toastMsg.value
          ? { message: toastMsg.value, isPresented: showToast, position: "top", duration: 2.5 }
          : undefined
      }
    >
      <MapPage
        pendingCoord={pendingCoord}
        recenterCoord={recenterCoord}
        coordLat={coordLat}
        coordLng={coordLng}
        activeLoc={activeLoc}
        layer={layer}
        routes={routes.map((item) => item.coordinates)}
        selectedRouteIndex={routeIndex}
        jitterRadius={settings.jitterRadius}
        drawnPath={drawnPath}
        onCoordChange={handleCoordChange}
        onPickUnavailable={() => fireToast("地图还没准备好，稍等一下再点")}
      />

      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} alignment="leading">
        {/* 关闭键始终在左上角：它是退出，不该跟着惯用手跑来跑去 */}
        <HStack alignment="top" spacing={8} padding={{ top: 12, leading: 16, trailing: 16 }}>
          {topBtn("xmark", "systemRed", handleCloseApp)}
          {atBottom ? <Spacer /> : menuCluster}
        </HStack>
        <Spacer />
      </VStack>

      <VStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        alignment="leading"
        padding={{ leading: 16, trailing: 16, bottom: 0 }}
      >
        <Spacer />
        {/*
          手绘中的操作条。
          撤销 / 清空 / 完成都摆在地图上，是因为取点本来就在地图上发生——
          为了撤掉一个点去开一次面板，点不了几个就会放弃。
        */}
        {drawing.value ? (
          <HStack
            spacing={10}
            padding={{ vertical: 10, leading: 14, trailing: 14 }}
            frame={{ maxWidth: "infinity" }}
            glassEffect={{ type: "rect", cornerRadius: 18 }}
          >
            <Image systemName="scribble.variable" foregroundStyle="systemIndigo" font="subheadline" />
            <Text font="subheadline" foregroundStyle="label">
              {drawnPath.length > 0 ? `已点 ${drawnPath.length} 个` : "点地图落点"}
            </Text>
            <Spacer />
            <Button
              action={handleUndoDrawnPoint}
              disabled={drawnPath.length === 0}
              buttonStyle="borderless"
            >
              <Image systemName="arrow.uturn.backward" font="subheadline" />
            </Button>
            <Button
              action={handleClearDrawnPath}
              disabled={drawnPath.length === 0}
              buttonStyle="borderless"
            >
              <Image systemName="trash" foregroundStyle="systemRed" font="subheadline" />
            </Button>
            <Button action={handleFinishDrawing} buttonStyle="borderless">
              <Text font="subheadline" foregroundStyle="systemBlue">
                {drawnPath.length >= 2 ? "完成" : "退出"}
              </Text>
            </Button>
          </HStack>
        ) : null}
        {/*
          摇杆。
          必须和坐标卡同在这一层：顶部那层是另一个 ZStack 子节点，画在坐标卡
          下面，摇杆摆在那儿会被卡片整个盖住。
          左右跟着菜单走，占住菜单没用的那个底角。
        */}
        {movementKind === "joystick" ? (
          <HStack frame={{ maxWidth: "infinity" }} padding={{ bottom: 8 }}>
            {joystickOnRight ? <Spacer /> : null}
            <JoystickPad
              vector={joystickVector}
              cardOffset={joystickOffset}
              modeLabel={modeInfo(selection.mode).label}
              maxKmh={selection.speed.metresPerSecond * 3.6}
              onRecenter={() =>
                recenterCoord.setValue({ latitude: coordLat.value, longitude: coordLng.value })
              }
              onStop={() => {
                stopMovement();
                // 推的过程中只同步了坐标，地名还停在出发地——停下来补一次反查。
                void resolvePlaceName(coordLat.value, coordLng.value);
              }}
            />
            {joystickOnRight ? null : <Spacer />}
          </HStack>
        ) : null}
        {/*
          底角模式的菜单压在坐标卡正上方。
          排在摇杆下面，这样齿轮相对坐标卡的位置是固定的——
          放摇杆上面的话，一开摇杆齿轮就整体上移一截。
        */}
        {atBottom ? menuCluster : null}
        {showCredit ? (
          <Button action={handleOpenCreditLink}>
            <HStack
              spacing={6}
              padding={{ vertical: 8, leading: 12, trailing: 12 }}
              glassEffect={{ type: "rect", cornerRadius: 14 }}
            >
              <Text font="caption" foregroundStyle="secondaryLabel">致谢：</Text>
              <Text font="caption" foregroundStyle="systemBlue">wloc · BlackCCCat</Text>
            </HStack>
          </Button>
        ) : null}
        <VStack
          alignment="leading"
          spacing={12}
          padding={{ top: 16, bottom: 16, leading: 16, trailing: 16 }}
          frame={{ maxWidth: "infinity" }}
          glassEffect={{ type: "rect", cornerRadius: 24 }}
          shadow={{ color: "rgba(0,0,0,0.15)", radius: 20, y: -5 }}
          clipShape={{ type: "rect", cornerRadius: 24 }}
        >
          <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
            <Image
              systemName="personalhotspot"
              foregroundStyle={pairing ? "systemBlue" : "tertiaryLabel"}
              font="subheadline"
            />
            <Text font="subheadline" foregroundStyle="label">设备</Text>
            <Spacer />
            <Button action={openPairingPage}>
              <Text font="caption" foregroundStyle={pairing ? "systemGreen" : "systemOrange"}>
                {pairing ? `● ${pairing.deviceName || "已配对"}` : "● 未配对"}
              </Text>
            </Button>
          </HStack>

          <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
            <Image systemName="mappin.and.ellipse" foregroundStyle="systemRed" font="subheadline" />
            <Text font="headline" foregroundStyle="label">当前坐标</Text>
            <Spacer />
            {/*
              收藏相关的两个入口并排放在标题行。

              收藏放这儿，是因为它原先和「开始位置模拟」并排在底部，而那一排在模拟
              进行中会整个换成「更新坐标 / 恢复真实位置」——走到一个想记下来的地方
              时，收藏入口恰好不见了。它针对的本来就是上面这个坐标，挂在标题行才对。

              旁边补一个「收藏夹」：翻已存的地点比新增更常用，而它原先只在顶部菜单
              里，得先把菜单展开才看得到，比「收藏」这个低频动作还深一层。
              两个都用图标按钮，不带文字，省地方也不至于把标题挤掉。
            */}
            <Button
              buttonStyle="borderless"
              action={() => openSheet("favorites")}
            >
              <HStack spacing={4}>
                <Image systemName="list.star" foregroundStyle="systemBlue" font="caption" />
                <Text font="caption2" foregroundStyle="systemBlue">收藏夹</Text>
              </HStack>
            </Button>
            <Button
              buttonStyle="borderless"
              action={
                isCurrentCoordFavorited()
                  ? handleRemoveCurrentFavorite
                  : () => handleAddFavorite({ latitude: coordLat.value, longitude: coordLng.value })
              }
              disabled={!coordReady.value}
            >
              <HStack spacing={4}>
                <Image
                  systemName={isCurrentCoordFavorited() ? "star.fill" : "star"}
                  foregroundStyle={isCurrentCoordFavorited() ? "systemOrange" : "systemBlue"}
                  font="caption"
                />
                <Text
                  font="caption2"
                  foregroundStyle={isCurrentCoordFavorited() ? "systemOrange" : "systemBlue"}
                >
                  {isCurrentCoordFavorited() ? "已收藏" : "收藏"}
                </Text>
              </HStack>
            </Button>
          </HStack>

          {/*
            坐标这一行可以点：开系统选点器。
            地图只在手势结束时回写相机位置，没有逐帧回调，所以拖动时的跟随
            一定不如系统那个跟手——需要精确对点时直接用它更省事。
          */}
          <Button action={handlePickFromMap}>
            <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
              <Text font="subheadline" foregroundStyle="secondaryLabel">
                {coordReady.value
                  ? `经度 ${coordLng.value.toFixed(6)}  纬度 ${coordLat.value.toFixed(6)}`
                  : "在地图上点一下即可选点"}
              </Text>
              <Spacer />
              <Image systemName="scope" foregroundStyle="systemBlue" font="caption" />
              <Text font="caption2" foregroundStyle="systemBlue">精确选点</Text>
            </HStack>
          </Button>

          {!!statusMsg && (
            <Text font="caption" foregroundStyle={sessionState === "active" ? "systemGreen" : "secondaryLabel"}>
              {statusMsg}
            </Text>
          )}

          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            {/* 空闲时把当前方式与速度写在按钮上，省得为看一眼设置还要点进面板 */}
            <Button
              action={() => openSheet("movement")}
              frame={{ maxWidth: "infinity" }}
              background={{ style: movementKind === "none" ? "systemGray5" : "systemGreen", shape: "capsule" }}
              tint={movementKind === "none" ? "label" : "white"}
            >
              <HStack spacing={6} padding={{ vertical: 8, leading: 14, trailing: 16 }}>
                <Image systemName={modeInfo(selection.mode).systemImage} font="subheadline" />
                <Text font="subheadline" fontWeight="medium">
                  {movementKind === "none"
                    ? `移动 · ${modeInfo(selection.mode).label} ${(selection.speed.metresPerSecond * 3.6).toFixed(1)} km/h`
                    : movementKind === "joystick"
                      ? "摇杆中"
                      : "移动中"}
                </Text>
              </HStack>
            </Button>
            {movementKind === "route" ? (
              <Button
                action={togglePaused}
                frame={{ maxWidth: "infinity" }}
                background={{ style: paused ? "systemGreen" : "systemOrange", shape: "capsule" }}
                tint="white"
              >
                <HStack spacing={6} padding={{ vertical: 8, leading: 12, trailing: 14 }}>
                  <Image systemName={paused ? "play.fill" : "pause.fill"} font="subheadline" />
                  <Text font="subheadline" fontWeight="medium">{paused ? "继续" : "暂停"}</Text>
                </HStack>
              </Button>
            ) : null}
            {movementKind === "route" ? (
              <Button
                action={reverseMovement}
                frame={{ maxWidth: "infinity" }}
                background={{ style: "systemIndigo", shape: "capsule" }}
                tint="white"
              >
                <HStack spacing={6} padding={{ vertical: 8, leading: 12, trailing: 14 }}>
                  <Image systemName="arrow.uturn.backward" font="subheadline" />
                  <Text font="subheadline" fontWeight="medium">反向</Text>
                </HStack>
              </Button>
            ) : null}
            {movementKind !== "none" ? (
              <Button
                action={stopMovement}
                frame={{ maxWidth: "infinity" }}
                background={{ style: "systemRed", shape: "capsule" }}
                tint="white"
              >
                <HStack spacing={6} padding={{ vertical: 8, leading: 12, trailing: 14 }}>
                  <Image systemName="stop.fill" font="subheadline" />
                  <Text font="subheadline" fontWeight="medium">停止</Text>
                </HStack>
              </Button>
            ) : null}
          </HStack>

          <HStack spacing={12} frame={{ maxWidth: "infinity" }}>
            {sessionState === "active" ? (
              <>
                <Button
                  action={handleUpdateCoord}
                  frame={{ maxWidth: "infinity" }}
                  background={{ style: "systemBlue", shape: "capsule" }}
                  tint="white"
                >
                  <HStack spacing={6} padding={{ vertical: 10, leading: 16, trailing: 20 }}>
                    <Image systemName="arrow.triangle.2.circlepath" font="subheadline" />
                    <Text font="subheadline" fontWeight="medium">更新坐标</Text>
                  </HStack>
                </Button>
                <Button
                  action={handleStopSession}
                  frame={{ maxWidth: "infinity" }}
                  background={{ style: "systemRed", shape: "capsule" }}
                  tint="white"
                >
                  <HStack spacing={6} padding={{ vertical: 10, leading: 16, trailing: 20 }}>
                    <Image systemName="location.slash" font="subheadline" />
                    <Text font="subheadline" fontWeight="medium">恢复真实位置</Text>
                  </HStack>
                </Button>
              </>
            ) : (
              <>
                <Button
                  action={handleStartSession}
                  disabled={sessionState === "connecting" || !pairing}
                  frame={{ maxWidth: "infinity" }}
                  background={{
                    style: sessionState === "connecting" ? "systemGray" : "systemIndigo",
                    shape: "capsule",
                  }}
                  tint="white"
                >
                  <HStack spacing={6} padding={{ vertical: 10, leading: 16, trailing: 20 }}>
                    <Image
                      systemName={sessionState === "connecting" ? "hourglass" : "location.fill"}
                      font="subheadline"
                    />
                    <Text font="subheadline" fontWeight="medium">
                      {sessionState === "connecting" ? "连接中…" : "开始位置模拟"}
                    </Text>
                  </HStack>
                </Button>
              </>
            )}
          </HStack>

          <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
            {loc ? (
              <>
                <Image systemName="checkmark.circle.fill" foregroundStyle="systemGreen" font="subheadline" />
                <Text font="subheadline" foregroundStyle="systemGreen">
                  模拟中 经度 {loc.longitude.toFixed(6)} 纬度 {loc.latitude.toFixed(6)}
                </Text>
              </>
            ) : (
              <>
                <Image systemName="location.slash" foregroundStyle="tertiaryLabel" font="subheadline" />
                <Text font="subheadline" foregroundStyle="tertiaryLabel">当前为真实位置</Text>
              </>
            )}
          </HStack>
        </VStack>
      </VStack>

      {/*
        蜂窝引导压在最上层，并且盖一层半透明背景——这期间要用户去控制中心切
        飞行模式，底下的地图和按钮都不该还能点。
      */}
      {guideStage.value !== null ? (
        <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <Rectangle fill="rgba(0,0,0,0.45)" frame={{ maxWidth: "infinity", maxHeight: "infinity" }} />
          <CellularGuide
            stage={guideStage.value}
            attempts={guideAttempts.value}
            onRetry={() => void retryFromGuide()}
            onRetryNow={attemptInGuide}
            onUseCellular={beginGuideLoop}
            onCancel={() => dismissGuide(true)}
            onDone={() => dismissGuide(false)}
          />
        </ZStack>
      ) : null}
    </ZStack>
  );
}

const run = async () => {
  await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" });
  Script.exit();
};

run();
