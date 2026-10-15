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
} from "./utils/storage";
import { MapPage } from "./pages/MapPage";
import { SettingsPage } from "./pages/SettingsPage";
import { FavoritesPage } from "./pages/FavoritesPage";
import { PairingPage } from "./pages/PairingPage";
import { SearchPage } from "./pages/SearchPage";
import { AboutPage } from "./pages/AboutPage";
import { MovementPanel, type MovementSelection } from "./pages/MovementPanel";
import { JoystickPad } from "./pages/JoystickPad";
import { applyJitter, fromDeviceCoordinate, parseAndConvert, toDeviceCoordinate } from "./utils/coords";
import { loadPairing, type PairingRecord } from "./core/pairing";
import { debugLog, describeError } from "./core/debug";
import { restoreRealLocation, startLocationSession, type LocationSessionHandle } from "./core/session";
import { defaultSpeed, joystickStep, modeInfo, PathWalker } from "./core/movement";
import { parseGPX } from "./core/gpx";
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

interface PlannedRoute {
  name?: string;
  coordinates: Coordinate[];
  distance: number;
  travelTime: number;
}

async function openExternalURL(url: string): Promise<void> {
  const ok = await Safari.openURL(url);
  if (ok === false) throw new Error("打开 URL 失败");
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
  const walker = useObservable<PathWalker | null>(null);
  const movementTimer = useObservable<ReturnType<typeof setInterval> | null>(null);
  const joystickVector = useObservable({ dx: 0, dy: 0 });
  const joystickPosition = useObservable<Coordinate | null>(null);
  /** 锁屏/灵动岛卡片。脚本被划掉后它仍在，是「忘了恢复」的最后一道提醒。 */
  const liveActivity = useObservable(() => SimulationLiveActivity());
  const [placeName, setPlaceName] = useState("");

  // 当前选点（来自搜索/链接解析/收藏），供 MapPage 监听并跳转
  const pendingCoord = useObservable<Coordinate | null>(null);

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

  function handleCoordChange(lat: number, lng: number, name?: string) {
    coordLat.setValue(lat);
    coordLng.setValue(lng);
    coordReady.setValue(true);
    // 点中 POI 时 MapKit 会给出名称，留着给实时活动和历史记录用。
    if (name !== undefined) {
      setPlaceName(name);
      setHistory(addHistory(name || "地图选点", lat, lng));
    }
    // 手绘模式下点地图就是落点，不用为了加一个点去开合一次面板。
    if (drawing.value) appendDrawnPoint(lat, lng);
  }

  async function handleAddFavorite(coord: Coordinate) {
    const name = await Dialog.prompt({
      title: "收藏此位置",
      message: `经度 ${coord.longitude.toFixed(6)}  纬度 ${coord.latitude.toFixed(6)}`,
      defaultValue: "我的收藏",
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
      debugLog("keepalive", `scenePhase=${phase}`);
      if (session.value === null) return;
      if (phase === "background") void acquireKeepAlive();
      else if (phase === "active") void BackgroundKeeper.stopKeepAlive().catch(() => undefined);
    };
    AppEvents.scenePhase.addListener(listener);
    return () => AppEvents.scenePhase.removeListener(listener);
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
  async function handleSessionDropped(message: string, retry: (() => void) | null) {
    debugLog("ui", "会话中断", message);
    session.setValue(null);
    // 恢复记录故意不删：连接是异常断的，停止指令未必送达，
    // 下次启动仍要提示用户恢复。
    void BackgroundKeeper.stopKeepAlive().catch(() => undefined);

    if (retry && !reconnecting.current) {
      reconnecting.current = true;
      setSessionState("connecting");
      setStatusMsg("连接中断，正在重连…");
      fireToast("连接中断，正在重连…");
      try {
        retry();
        return;
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
      showErrorAlert("请先在「配对」里导入 wloc 导出的配对记录");
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
    try {
      const handle = await startLocationSession({
        record: pairing,
        endpoint: { host: settings.deviceHost, source: settings.tunnelSource },
        latitude: target.latitude,
        longitude: target.longitude,
        keepAlive: settings.keepAlive,
        onStatus: (message) => {
          debugLog("status", message);
          setStatusMsg(message);
        },
        onFailure: (message) => {
          void handleSessionDropped(message, () => void handleStartSession());
        },
      });
      session.setValue(handle);
      setSessionState("active");
      setStatusMsg(`模拟中 · ${lat.toFixed(5)}, ${lng.toFixed(5)}`);
      markActive(lat, lng);
      fireToast("位置模拟已启动");
      void startLiveActivity({ latitude: lat, longitude: lng });
      debugLog("ui", "会话已就绪", JSON.stringify(handle.peer));
    } catch (e) {
      setSessionState("idle");
      setStatusMsg("");
      debugLog("ui", "启动失败", describeError(e));
      showErrorAlert(e instanceof Error ? e.message : String(e));
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

  function liveActivityState(point: Coordinate): SimulationState {
    const movement =
      movementKind === "joystick"
        ? `摇杆 · ${modeInfo(selection.mode).label}`
        : movementKind === "route"
          ? `${modeInfo(selection.mode).label} ${(selection.speed.metresPerSecond * 3.6).toFixed(1)} km/h`
          : "";
    return {
      place: placeName || `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
      movement,
      latitude: point.latitude,
      longitude: point.longitude,
    };
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
      await liveActivity.value.start(liveActivityState(point));
      debugLog("liveactivity", "卡片已启动");
    } catch (error) {
      debugLog("liveactivity", "实时活动启动失败", describeError(error));
      fireToast("锁屏卡片启动失败，不影响定位模拟");
    }
  }

  async function updateLiveActivity(point: Coordinate) {
    try {
      await liveActivity.value.update(liveActivityState(point));
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
  async function ensureSession(start: Coordinate): Promise<LocationSessionHandle | null> {
    const existing = session.value;
    if (existing) {
      await pushCoordinate(existing, start);
      return existing;
    }

    if (!pairing) {
      showErrorAlert("请先在「配对」里导入 wloc 导出的配对记录");
      return null;
    }

    const target = deviceCoordinate(start.latitude, start.longitude);
    setSessionState("connecting");
    setStatusMsg("准备中…");
    try {
      const handle = await startLocationSession({
        record: pairing,
        endpoint: { host: settings.deviceHost, source: settings.tunnelSource },
        latitude: target.latitude,
        longitude: target.longitude,
        keepAlive: settings.keepAlive,
        onStatus: (message) => {
          debugLog("status", message);
          setStatusMsg(message);
        },
        onFailure: (message) => {
          // 移动中掉线不自动重连：重连要从头建会话，而路径进度、往返计数都在
          // PathWalker 里，续不上。停掉移动、如实报错，让用户自己决定重来。
          stopMovement();
          void handleSessionDropped(message, null);
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
      void startLiveActivity(start);
      return handle;
    } catch (e) {
      setSessionState("idle");
      setStatusMsg("");
      debugLog("ui", "启动失败", describeError(e));
      showErrorAlert(e instanceof Error ? e.message : String(e));
      return null;
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

    let start = routeStart;
    if (!start) {
      const gps = await Location.requestCurrent({ forceRequest: true });
      if (!gps) throw new Error("取不到当前位置，请手动指定起点");
      // GPS 是 WGS-84，而终点取自地图（地图系），规划前要统一到地图系。
      start = fromDeviceCoordinate(gps.latitude, gps.longitude);
    }

    const result = await MapDirections.calculate({
      source: { latitude: start.latitude, longitude: start.longitude },
      destination: { latitude: coordLat.value, longitude: coordLng.value },
      transportType: modeInfo(choice.mode).transportType,
      requestsAlternateRoutes: true,
    });

    const usable = result.routes
      .filter((item) => item.coordinates.length >= 2)
      .map((item) => ({
        name: item.name,
        coordinates: item.coordinates.map((c) => ({ latitude: c.latitude, longitude: c.longitude })),
        distance: item.distance,
        travelTime: item.expectedTravelTime,
      }));
    if (usable.length === 0) throw new Error("没有找到可用路线");

    setRoutes(usable);
    setRouteIndex(0);
    setSelection(choice);
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
      // 摇杆推着走时镜头要跟上，否则很快就推出视野。
      pendingCoord.setValue(next);
      void pushCoordinate(active, next).catch((error) => {
        debugLog("ui", "摇杆下发坐标失败", describeError(error));
      });
    }, MOVEMENT_TICK_MS);
    movementTimer.setValue(timer);
  }

  async function handleStopSession() {
    stopMovement();
    const handle = session.value;
    session.setValue(null);
    setSessionState("idle");
    setStatusMsg("");
    activeLoc.setValue(null);
    saveActiveCache(null);
    clearRecovery();
    void BackgroundKeeper.stopKeepAlive().catch(() => undefined);
    void endLiveActivity();
    if (handle) {
      try {
        await handle.stop();
      } catch (e) {
        showErrorAlert(`停止时出错：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    fireToast("已恢复真实位置");
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
        coordLat={coordLat}
        coordLng={coordLng}
        activeLoc={activeLoc}
        layer={layer}
        routes={routes.map((item) => item.coordinates)}
        selectedRouteIndex={routeIndex}
        jitterRadius={settings.jitterRadius}
        drawnPath={drawnPath}
        onCoordChange={handleCoordChange}
        onPickUnavailable={() => fireToast("3D 或旋转视角下点选不准，请先点右上角的 2D/3D 按钮回正")}
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
              speedLabel={`${modeInfo(selection.mode).label} ${(selection.speed.metresPerSecond * 3.6).toFixed(1)} km/h`}
              onStop={stopMovement}
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
                <Button
                  action={
                    isCurrentCoordFavorited()
                      ? handleRemoveCurrentFavorite
                      : () => handleAddFavorite({ latitude: coordLat.value, longitude: coordLng.value })
                  }
                  frame={{ maxWidth: "infinity" }}
                  background={{
                    style: isCurrentCoordFavorited() ? "systemGray" : "systemOrange",
                    shape: "capsule",
                  }}
                  tint="white"
                >
                  <HStack spacing={6} padding={{ vertical: 10, leading: 16, trailing: 20 }}>
                    <Image systemName={isCurrentCoordFavorited() ? "star.slash" : "star"} font="subheadline" />
                    <Text font="subheadline" fontWeight="medium">
                      {isCurrentCoordFavorited() ? "取消收藏" : "收藏"}
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
    </ZStack>
  );
}

const run = async () => {
  await Navigation.present({ element: <App />, modalPresentationStyle: "fullScreen" });
  Script.exit();
};

run();
