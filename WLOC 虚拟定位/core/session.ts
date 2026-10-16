// 定位会话编排：本机隧道 → 配对握手 → RSD 隧道 → DVT 位置模拟。
//
// 与 wloc（iOS）同一条链路，区别只在隧道那一段：
// wloc 自己实现 TLS-PSK + CDTunnel，这里交给 VPN.localDevVPN.openRSDTunnel。
//
// 设备的 RemotePairing 落点由 Bonjour 公布：端口和地址都得照它说的办，
// 只认端口、把连接一律打到隧道对端，蜂窝下必然吃 ECONNREFUSED。
// 公告拿不到时退回全段扫描，再用 RPPairing 握手确认——帧头对不上就不是它。

import { dvtPort, discoverServices } from "./rsd";
import { debugLog, describeError } from "./debug";
import { DtxConnection } from "./dtx";
import { LocationSimulation } from "./location";
import { RemotePairingClient, RpPairingSocket, type PeerHandshakeInfo } from "./rppairing";
import { connectTCP, probeTCP } from "./tcp";
import { discoverPairingService } from "./bonjour";
import { probeTlsPsk } from "./tlsprobe";
import { delay, withTimeout, type ByteStream } from "./stream";
import { loadPairing, type PairingRecord } from "./pairing";
import type { TunnelSource } from "../types";

/*
  端口扫描的范围与节奏。

  iOS 的动态端口是 49152–65535，全扫一遍不现实；但原先只扫到 49400（249 个，
  占整个范围的 1.5%），而实测日志里隧道端口出现过 50724、50857、50343——
  都在旧范围之外。配对服务重启后未必还落在 49152，扫不到就只能报「找不到」，
  还分不清是服务没起还是端口搬了。

  现在扫到 51200（2048 个），并发提到 64、单次超时压到 200 ms：
  2048 / 64 × 200ms ≈ 6.4 秒，比原先慢两秒，换来 8 倍覆盖。
  这条路不依赖 mDNS，是蜂窝下唯一走得通的发现方式，值得这点时间。
*/
const PORT_RANGE_START = 49152;
const PORT_RANGE_END = 51200;
const PORT_SCAN_BATCH = 64;
const PORT_SCAN_TIMEOUT = 200;
/*
  上次握手成功的落点，存「地址 + 端口」。

  v1 只存端口，因为那时所有连接都打到隧道对端。现在地址也会变（蜂窝下走的
  往往不是 10.7.0.1），光记端口会把下次连接导到错的地址上去。v1 的残留读不出
  就当没有，不必迁移。
*/
const PORT_CACHE_KEY = "wloc_pairing_target_v2";
/** 位置下发的心跳间隔，与 wloc 的 4 秒一致：设备久不收就会把会话收掉。 */
const KEEPALIVE_INTERVAL = 4000;
/*
  心跳连续失败多少次才判定会话真的断了。
  4 秒一拍 × 4 = 16 秒宽限，足够跨过关飞行模式、WiFi 转蜂窝这类网络切换；
  真断了也就多等十几秒，比动不动拆隧道重建划算得多。
*/
const KEEPALIVE_MAX_MISSES = 4;
/**
 * 「只绑回环」这个判定在失败文案里的标记。
 * 引导和锁屏通知都靠这句话认出这类失败并换成短提示，改文案时别把它改没了。
 */
const LOOPBACK_ONLY_MARK = "只绑在回环地址上";

export type StatusReporter = (message: string) => void;

/** 隧道从哪来、对端地址是什么。两者都可在设置里改。 */
export interface TunnelEndpoint {
  host: string;
  source: TunnelSource;
}

export interface LocationSessionHandle {
  readonly peer: PeerHandshakeInfo;
  update(latitude: number, longitude: number): Promise<void>;
  stop(): Promise<void>;
}

/**
 * 催系统重新定位一次。
 *
 * `stopLocationSimulation` 发出去之后，设备其实已经不再模拟了，但 CoreLocation
 * 仍会把上一次的坐标当作「最近已知位置」返回，直到有人发起新的定位请求——
 * 所以常见的现象是「必须打开地图 App 才看到位置变回来」。这里主动强制请求一次，
 * 把那一步省掉。
 */
async function nudgeRealLocation(): Promise<void> {
  try {
    await Location.requestCurrent({ forceRequest: true });
    debugLog("dvt", "已强制重新定位，真实位置应随即生效");
  } catch (error) {
    // 没权限或一时取不到都无所谓，这只是催系统刷新缓存。
    debugLog("dvt", "强制重新定位失败（不影响已发出的停止指令）", describeError(error));
  }
}

/** 把隧道连接套成通用字节流。 */
function wrapTunnelConnection(connection: VPNRSDConnection): ByteStream {
  return {
    read: (max: number) => connection.read(max),
    write: (data: Uint8Array) => connection.write(data),
    close: () => connection.close(),
  };
}

/**
 * 确认回环通路可用。
 *
 * `proxyApp` 模式下**绝不碰 VPN 开关**——反射由代理工具提供，脚本只需确认对端地址
 * 能连上。必须如此：iOS 同时只允许一条 VPN 生效，去启用 Scripting 自己的 VPN
 * 正好会把提供反射的那个代理顶掉。
 *
 * 但脚本也不会替用户关掉 Scripting 自己的 VPN——那条 VPN 可能正是用户在用的代理，
 * 只提示，不代劳。
 */
async function ensureTunnelReady(endpoint: TunnelEndpoint, log: StatusReporter): Promise<void> {
  if (endpoint.source === "proxyApp") {
    const state = await VPN.localDevVPN.getState();
    debugLog("vpn", "代理模式，自身隧道状态", JSON.stringify(state));

    // Scripting 自己的 VPN 还连着就等于占着唯一的 VPN 名额，代理工具根本起不来。
    if (state.vpnStatus === "connected") {
      log("注意：Scripting 自己的 VPN 仍在连接，代理工具可能起不来");
      debugLog(
        "vpn",
        `代理模式下 Scripting 自身 VPN 仍为 connected（反射地址 ${JSON.stringify(state.effectiveAddresses)}）` +
          "，iOS 只允许一条 VPN 生效，请先断开它再让代理接管",
      );
    }

    /*
      LocalDevVPN 这个开关要打开，但**不要启动 Scripting 自己的 VPN**。

      原生那句报错要的是两样东西：this app's VPN 和 LocalDevVPN。代理模式下
      前者必须让给代理工具，后者只是个功能开关——开着它不会去抢 VPN 名额，
      却是 openRSDTunnel 的前提之一。以前这里一个都没碰，等于少开了一半。
    */
    if (!state.enabled) {
      log("启用 LocalDevVPN 开关…");
      try {
        const next = await VPN.localDevVPN.setEnabled(true, { expectedState: state.expectedState });
        debugLog("vpn", "代理模式下已打开 LocalDevVPN", JSON.stringify(next));
      } catch (error) {
        debugLog("vpn", "打开 LocalDevVPN 失败", describeError(error));
        log("LocalDevVPN 开关打不开，仍继续尝试…");
      }
    }

    log("检查代理工具提供的回环地址…");
    /*
      只记一笔，不据此拦截。

      探的是 49152 这一个端口，而配对服务重启后未必还在那儿——服务一搬家，
      这里就报「暂不可达」，吓人一跳却什么也没说明。真正判断可不可达要靠
      后面的扫描，它会遍历整个范围。

      之所以还留着：`ECONNREFUSED` 和超时的区别很有价值——前者说明回环通了
      只是没服务，后者说明代理根本没把这个地址接回来。两种情况要做的事完全不同。
    */
    const reachable = await probeTCP(endpoint.host, PORT_RANGE_START, 1500);
    debugLog(
      "vpn",
      `代理模式下 ${endpoint.host}:${PORT_RANGE_START} ${reachable ? "可达" : "无响应"}` +
        "（只探这一个端口，服务可能在别的端口上，以扫描结果为准）",
    );
    return;
  }

  await ensureLocalDevVPN(log);
}

/**
 * 确认 Scripting 自身的本机隧道已生效，并返回它实际在反射的地址。
 *
 * openRSDTunnel 的 host 必须是「已生效的数字 IPv4 反射地址」，所以把
 * effectiveAddresses 一并带出来给调用方核对——纯 TCP 能连通不代表原生侧认这个地址。
 */

/*
  正在进行的 VPN 启动。

  `VPN.start` 要几秒才落定，这期间再调一次会直接报
  「A VPN control operation is already in progress.」。蜂窝引导的重试是
  500 ms 一轮，于是前三轮全撞在这上面，白白浪费了十秒——第四轮才赶上空档。

  用一个模块级的 Promise 把并发调用并到同一次启动上：后来者等前一次的结果，
  而不是再发一次。
*/
let vpnStarting: Promise<VPNLocalDevState> | null = null;

async function ensureLocalDevVPN(log: StatusReporter): Promise<VPNLocalDevState> {
  if (vpnStarting) {
    debugLog("vpn", "已有启动操作在跑，等它的结果");
    return vpnStarting;
  }
  vpnStarting = startLocalDevVPN(log).finally(() => {
    vpnStarting = null;
  });
  return vpnStarting;
}

async function startLocalDevVPN(log: StatusReporter): Promise<VPNLocalDevState> {
  let state = await VPN.localDevVPN.getState();
  debugLog("vpn", "初始状态", JSON.stringify(state));
  if (state.effectiveStatus === "active") return state;

  if (state.effectiveStatus === "unavailable") {
    throw new Error("本机隧道不可用。请确认 Scripting 已获得 VPN 权限，且系统里没有别的 VPN 正在连接。");
  }

  if (!state.enabled) {
    log("启用本机隧道…");
    state = await VPN.localDevVPN.setEnabled(true, { expectedState: state.expectedState });
  }

  if (state.vpnStatus !== "connected") {
    log("启动 VPN（首次会弹系统授权）…");
    try {
      const vpnState = await VPN.start();
      debugLog("vpn", "VPN.start 返回", JSON.stringify(vpnState));
    } catch (error) {
      debugLog("vpn", "VPN.start 失败", describeError(error));
      throw new Error(
        `启动 VPN 失败：${error instanceof Error ? error.message : String(error)}\n` +
          "iOS 同时只允许一条 VPN 生效，请先断开 Surge / ClashMi 一类的代理。",
      );
    }
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(500);
    state = await VPN.localDevVPN.getState();
    debugLog("vpn", `第 ${attempt + 1} 次轮询`, JSON.stringify(state));
    if (state.effectiveStatus === "active") return state;
    if (state.problem) log(`隧道：${state.problem}`);
  }

  throw new Error("本机隧道迟迟没有生效。请先断开其他 VPN / 代理，再试一次。");
}

/*
  这里曾经有一套「重建隧道自愈」：判定到「只绑回环」就 VPN.stop() → start()，
  指望 utun 重建能让 remotepairingd 重新枚举接口，省掉用户那趟控制中心。

  2026-10-16 实测无效，已删。重建完公告里依然只有 127.0.0.1 和 ::1——
  remotepairingd 要的不是「有接口变化」，而是蜂窝/WiFi 接口本身重建，
  那不是 utun 能顶替的。别再往这个方向试了。
*/

/** 一个待试的落点。地址未必是隧道对端——见 candidateTargets。 */
interface PairingTarget {
  host: string;
  port: number;
}

function sameTarget(a: PairingTarget, b: PairingTarget): boolean {
  return a.host === b.host && a.port === b.port;
}

function pushTarget(list: PairingTarget[], target: PairingTarget): void {
  if (!list.some((item) => sameTarget(item, target))) list.push(target);
}

/**
 * 缓存落点优先，然后是 Bonjour 公告，最后才是全段扫描。
 *
 * 扫 2048 个端口要来回几千次 TCP 探测，而 Bonjour 一次解析就直接拿到端口，
 * 还能用设备 IRK 校验公告确实来自这台设备。只是它依赖组播，不一定可用——
 * 旧记录没有 IRK、或者组播被挡住时就只能退回扫描。
 *
 * **公告里的地址和端口一样重要。** 上一版只取端口，一律连隧道对端
 * （10.7.0.1），WiFi 下没问题，蜂窝下必然 ECONNREFUSED：设备的
 * remotepairingd 没绑到那条回环上，内核直接回 RST。而同一份公告里带着它
 * 真正在听的地址，试一下就能通。现在把「公告地址」排在对端地址之后一起试，
 * 这正是 wloc（iOS）的做法。
 */
async function candidateTargets(endpoint: TunnelEndpoint, log: StatusReporter): Promise<PairingTarget[]> {
  const targets: PairingTarget[] = [];

  const cached = Storage.get<PairingTarget>(PORT_CACHE_KEY);
  if (cached && typeof cached.host === "string" && Number(cached.port) > 0) {
    pushTarget(targets, { host: cached.host, port: Number(cached.port) });
  }

  log("查找配对服务…");

  const record = loadPairing();
  if (record?.altIrk && record.altIrk.length === 16) {
    try {
      const announced = await discoverPairingService(record.altIrk);
      if (announced !== null) {
        debugLog(
          "scan",
          `Bonjour 公告端口 ${announced.port}，地址 ${announced.addresses.join(", ") || "未提供"}`,
        );
        // 隧道对端排第一：WiFi 下它一直是对的，不该为了蜂窝把快路径让出去。
        pushTarget(targets, { host: endpoint.host, port: announced.port });
        for (const host of announced.addresses) {
          pushTarget(targets, { host, port: announced.port });
        }
      }
    } catch (error) {
      debugLog("scan", "Bonjour 发现失败，退回端口扫描", describeError(error));
    }
  }
  if (targets.length > 0) return targets;

  return (await scanPorts(endpoint, [])).map((port) => ({ host: endpoint.host, port }));
}

/**
 * 全段扫描。**不碰 Bonjour，也不看缓存**——这正是它存在的意义。
 *
 * 上一版把扫描塞在候选收集的末尾，于是只要 Bonjour 公告了一个端口，
 * 扫描这条路就永远走不到；而「Bonjour 报的端口连不上」恰恰是最需要扫描的时候。
 * 真机日志里一行 `[wloc:scan] 扫完…` 都没出现过，就是因为这个。
 *
 * @param skip 已经试过、不必再探的端口
 */
async function scanPorts(endpoint: TunnelEndpoint, skip: number[]): Promise<number[]> {
  const ports: number[] = [];
  debugLog("scan", `开始扫 ${PORT_RANGE_START}-${PORT_RANGE_END}（跳过已试：${skip.join(", ") || "无"}）`);
  const scanBegan = Date.now();
  for (let base = PORT_RANGE_START; base <= PORT_RANGE_END; base += PORT_SCAN_BATCH) {
    const batch: Promise<number | null>[] = [];
    for (let port = base; port < base + PORT_SCAN_BATCH && port <= PORT_RANGE_END; port++) {
      if (skip.includes(port) || ports.includes(port)) continue;
      batch.push(probeTCP(endpoint.host, port, PORT_SCAN_TIMEOUT).then((open) => (open ? port : null)));
    }
    for (const port of await Promise.all(batch)) {
      if (port !== null) ports.push(port);
    }
  }

  debugLog(
    "scan",
    `${endpoint.host} 扫完 ${PORT_RANGE_END - PORT_RANGE_START + 1} 个端口，` +
      `耗时 ${Date.now() - scanBegan}ms，开放：${ports.join(", ") || "无"}`,
  );
  // 扫空了也只是返回空：调用方可能还有别的地址要扫，这里抛错会把它们挡掉。
  return ports;
}

interface PairingSession {
  stream: ByteStream;
  client: RemotePairingClient;
  peer: PeerHandshakeInfo;
  /** 实际握上手的地址——后面建隧道必须跟着它走，不能再用隧道对端。 */
  host: string;
  port: number;
}

/** 逐个落点试 RPPairing 握手，握上即认定是配对服务。 */
async function tryTargets(
  targets: PairingTarget[],
  log: StatusReporter,
): Promise<{ session: PairingSession | null; lastError: unknown }> {
  let lastError: unknown = null;

  for (const target of targets) {
    const { host, port } = target;
    let stream: ByteStream | null = null;
    try {
      stream = await connectTCP(host, port, 4000);
      const client = new RemotePairingClient(new RpPairingSocket(stream));
      const peer = await withTimeout(client.attemptPairVerify(), 6000, `${host}:${port} 握手超时`);
      log(`配对服务：${port}`);
      debugLog("pair", `${host}:${port} 握手成功`, JSON.stringify(peer));
      Storage.set(PORT_CACHE_KEY, target);
      return { session: { stream, client, peer, host, port }, lastError: null };
    } catch (error) {
      lastError = error;
      debugLog("pair", `${host}:${port} 不是配对服务`, describeError(error));
      if (stream) {
        try {
          await stream.close();
        } catch {
          // 关不掉就算了，这条连接本来就要丢。
        }
      }
    }
  }

  return { session: null, lastError };
}

/** 退回扫描时最多扫几个地址——每个都是两秒多，再多就该怀疑别的环节了。 */
const MAX_SCAN_HOSTS = 3;

/**
 * 回环地址。
 *
 * 配对服务确实在这儿监听（2026-10-16 蜂窝实测：127.0.0.1:49152 连得上，是
 * **读**的时候才 ECONNRESET，说明对面接了连接、读完才砍），但设备不接受本机
 * 直连——localDevVPN 这层回环隧道存在的全部意义就是让连接看起来像是远程来的。
 * 所以回环地址只值得试那个公告端口，拿到 ECONNRESET 作为「服务在哪」的证据，
 * 扫它的全段纯属浪费：扫出来的端口同样连不通，每个还要赔 6 秒握手超时。
 */
function isLoopback(host: string): boolean {
  return host === "::1" || host.startsWith("127.");
}

async function openPairingSession(endpoint: TunnelEndpoint, log: StatusReporter): Promise<PairingSession> {
  // 第一轮：缓存落点 + Bonjour 公告（对端地址、公告地址都算），都是现成的，快。
  const first = await candidateTargets(endpoint, log);
  const firstTry = await tryTargets(first, log);
  if (firstTry.session) return firstTry.session;

  /*
    第一轮全军覆没，退回全段扫描。

    上一版这里是再收集一次候选、然后把缓存端口过滤掉——可 Bonjour
    每次都报同一个端口，过滤完就是空数组，扫描于是从来没跑过。真机日志里
    「Bonjour 公告端口 49152 → ECONNREFUSED → 结束」就是这么来的。

    扫哪些地址同样要紧。2026-10-16 蜂窝实测：公告端口 49152 在 10.7.0.1 上直接
    ECONNREFUSED，扫这个地址只扫出 50370（上一轮遗留的隧道监听，它等的是
    TLS-PSK，握手必然超时）——真正的配对服务压根不在这个地址上。所以凡是第一轮
    见过的地址都要扫一遍，而不是只认隧道对端。
  */
  /*
    公告地址全是回环，就不必再找了——这本身就是确诊。

    Bonjour 公告的是服务**实际绑着**的地址。只报 127.0.0.1 和 ::1，说明
    remotepairingd 这会儿没绑任何网络接口，隧道对端自然 ECONNREFUSED；而回环
    那条路设备又不接受。两头都堵死，再扫多少端口都是白扫。
  */
  const announced = first.filter((target) => target.host !== endpoint.host);
  if (announced.length > 0 && announced.every((target) => isLoopback(target.host))) {
    throw new Error(loopbackOnlyFailure(endpoint));
  }

  Storage.remove(PORT_CACHE_KEY);
  log("公告的端口连不上，扫一遍…");

  const hosts: string[] = [];
  for (const target of first) {
    if (isLoopback(target.host)) continue;
    if (!hosts.includes(target.host) && hosts.length < MAX_SCAN_HOSTS) hosts.push(target.host);
  }
  if (hosts.length === 0) hosts.push(endpoint.host);

  let tried = first.length;
  let lastError: unknown = firstTry.lastError;
  let anyOpen = false;

  for (const host of hosts) {
    const skip = first.filter((target) => target.host === host).map((target) => target.port);
    const ports = await scanPorts({ ...endpoint, host }, skip);
    if (ports.length === 0) continue;
    anyOpen = true;
    tried += ports.length;
    const attempt = await tryTargets(ports.map((port) => ({ host, port })), log);
    if (attempt.session) return attempt.session;
    lastError = attempt.lastError;
  }

  if (!anyOpen) {
    throw new Error(
      `${hosts.join("、")} 的 ${PORT_RANGE_START}-${PORT_RANGE_END} 没有开放端口。\n\n` +
        "① 在用蜂窝数据吗？mDNS 在蜂窝接口上找不到配对服务。\n" +
        "　 确认隧道已连接后，控制中心开关一次飞行模式再回来重试\n" +
        "② 开发者模式开着吗？\n" +
        "③ 本机隧道连上了吗？\n" +
        "④ 刚更新过系统的话，需要回「配对」页重新配一次",
    );
  }

  throw new Error(describePairingFailure(endpoint, tried, lastError));
}

/**
 * 把底层错误码翻译成能照着做的提示。
 *
 * 原先一律甩「试过 N 个端口都不是 RemotePairing 服务，最后一个错误：Connection
 * refused」——用户看完不知道该去动哪儿，而这几个错误码其实指向完全不同的原因：
 *
 * - `ECONNREFUSED`：SYN 出去了、对面回了 RST。流量**到了某处**但没人在那个端口
 *   监听，不是路由不通。代理模式下这几乎总是「回环没生效」。
 * - 超时：流量石沉大海，那才是路由或反射规则的问题。
 */
/**
 * 公告里只有回环地址时的说明。
 *
 * 这是唯一一种「能确诊」的失败：不用猜开发者模式、不用猜配对记录，Bonjour 已经
 * 把服务绑在哪儿写出来了。2026-10-16 蜂窝实测的完整证据链——
 *   - 公告地址 = 127.0.0.1 + ::1，没有任何网络接口地址
 *   - 10.7.0.1:49152 → ECONNREFUSED（连都连不上，没人听）
 *   - 127.0.0.1:49152 → 读时 ECONNRESET（接了连接才砍，服务确实在）
 * 所以：服务活着，只是这会儿没绑网络接口，而回环又不被接受。
 */
function loopbackOnlyFailure(endpoint: TunnelEndpoint): string {
  const base =
    `配对服务这会儿${LOOPBACK_ONLY_MARK}，没绑任何网络接口。\n\n` +
    "设备不接受从回环直连配对服务，所以这条路走不通——这跟开发者模式、配对记录都没关系。\n\n" +
    "用蜂窝数据时就是这样。按顺序做一遍：\n" +
    "① 先确认隧道已连接\n" +
    "② 控制中心开一次飞行模式，等几秒再关掉\n" +
    "③ 回来重新开始模拟\n" +
    "④ 连上之后蜂窝照常用，位置模拟不受影响\n\n";
  return endpoint.source === "proxyApp"
    ? base + "代理那边确认 10.7.0.1 的回环改写是生效的；实在不行改连 WiFi。"
    : base +
        "也可以把「隧道来源」切到「代理工具提供」试试：代理的回环改写会把目标落回本机，\n" +
        "跟 Scripting 自身隧道走的不是同一条路。实在不行改连 WiFi。";
}

function describePairingFailure(endpoint: TunnelEndpoint, tried: number, error: unknown): string {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const proxy = endpoint.source === "proxyApp";

  if (code === "ECONNREFUSED") {
    /*
      被拒绝说明流量到了本机、只是那个端口上没有服务。

      头一个要问的是蜂窝。配对服务靠 mDNS 公告自己，而蜂窝接口上没有本地链路，
      发现不了它，缓存的端口又早已失效。

      解法不是「必须连 WiFi」——**临时**打开飞行模式即可：撤掉蜂窝接口，mDNS 就
      回到本地，会话建起来之后关掉飞行模式，模拟照常继续（mDNS 只在建会话那一刻
      用得上）。这套顺序是原生那版（wloc for iOS）验证过的，见它的
      MobileDataGuidanceView 三阶段引导。
    */
    const cellular =
      `${endpoint.host} 拒绝了连接——流量到了本机，但那个端口上没有服务。\n\n` +
      "用蜂窝数据的话多半是这个原因：配对服务靠 mDNS 公告，而蜂窝接口上没有本地链路，找不到它。\n" +
      "按顺序做一遍：\n" +
      "① 先确认隧道已连接\n" +
      "② 控制中心开一次飞行模式，等几秒再关掉\n" +
      "③ 回来重新开始模拟\n" +
      "④ 连上之后蜂窝照常用，位置模拟不受影响\n\n" +
      "怎么弄都不行的话，改连 WiFi。\n\n";
    return proxy
      ? cellular +
          "用 WiFi 还这样的话：开发者模式开着吗？代理工具在运行、回环模块已启用吗？\n" +
          "把「隧道来源」切回「Scripting 自身」试一次——那边也连不上，就不是代理工具的问题。"
      : cellular + "用 WiFi 还这样的话：开发者模式开着吗？刚更新过系统的话需要回「配对」页重新配一次。";
  }

  /*
    网络不可达：连 10.7.0.1 这条路由都没有，和「到了但没服务」是两回事。

    最常见的就是飞行模式开着——隧道依附于网络接口，飞行模式一开它也跟着断。
    所以按引导开关飞行模式时，中间这一下报错是预期的，关掉之后才会连上。
  */
  if (code === "ENETUNREACH") {
    return (
      `连不到 ${endpoint.host}，这条路由不存在。\n\n` +
      "飞行模式开着吗？隧道会跟着一起断——关掉飞行模式，网络和隧道一起恢复，再重试。\n" +
      (proxy
        ? "代理工具也要确认是在运行的，TUN 断了之后有些工具不会自己重连。"
        : "本机隧道可能也需要重新连一次，去「连接状态」看一眼。")
    );
  }

  /*
    连上了又被砍：服务在那个端口上，只是不接受这条连接。

    回环地址上这是常态（设备要求连接看起来像远程），那种情况已经在
    openPairingSession 里按「只公告回环」提前确诊了，走到这儿说明是别的地址，
    值得单独说一句——至少能告诉用户「找到了，但被拒」，而不是「找不到」。
  */
  if (code === "ECONNRESET") {
    return (
      `${endpoint.host} 上找到了配对服务，但它把连接砍掉了。\n\n` +
      "设备不接受这条路径上的配对连接。开关一次飞行模式让它重新绑定，再重试。\n" +
      (proxy ? "也确认一下代理的回环改写有没有把源地址改掉。" : "")
    );
  }

  /*
    握手超时 ≠ 连不上，两者的下一步完全相反。

    TCP 明明连上了、对面却不按 RPPairing 回话，说明那个端口上蹲着别的服务——
    最常见的是上一轮会话遗留的隧道监听，它等的是 TLS-PSK。2026-10-16 蜂窝实测
    就是这样：50370 连得上、握手超时，而下面那句「本机隧道可能没真正建立」
    把人引去查隧道，隧道其实好好的。
  */
  if (message.includes("握手超时")) {
    return (
      "扫到了开放端口，但没有一个是配对服务。\n\n" +
      "说明配对服务没在这个地址上监听。用蜂窝数据时常见，按顺序做一遍：\n" +
      "① 先确认隧道已连接\n" +
      "② 控制中心开一次飞行模式，等几秒再关掉\n" +
      "③ 回来重新开始模拟\n\n" +
      "刚更新过系统的话，去「配对」页重新配一次。"
    );
  }

  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || message.includes("超时")) {
    return proxy
      ? `连 ${endpoint.host} 没有响应——代理工具没把这个地址反射回本机。\n\n` +
          `检查回环模块是否生效，以及 TUN 的包含路由里有没有 ${endpoint.host}。`
      : `连 ${endpoint.host} 没有响应，本机隧道可能没真正建立。去「连接状态」跑一遍看卡在哪。`;
  }

  return `试过 ${tried} 个端口都不是 RemotePairing 服务。最后一个错误：${message}`;
}

/** 诊断项：`ok` 为 null 表示只是陈述事实，无所谓好坏。 */
export interface DiagnosticItem {
  label: string;
  value: string;
  ok: boolean | null;
}

/**
 * 逐项体检：隧道 → 地址可达 → 配对记录 → 设备握手。
 *
 * 只做到握手为止，不跑 pair-verify，也不建隧道——那些慢且有副作用
 * （会在设备上开监听）。排查「连不上」时这几项足以定位到是哪一环断的。
 */
export async function collectDiagnostics(options: {
  endpoint: TunnelEndpoint;
  record: PairingRecord | null;
  onStatus?: StatusReporter;
}): Promise<DiagnosticItem[]> {
  const log = options.onStatus ?? (() => {});
  const items: DiagnosticItem[] = [];
  const endpoint = options.endpoint;

  items.push({
    label: "隧道来源",
    value: endpoint.source === "builtIn" ? "Scripting 自身" : "代理工具提供",
    ok: null,
  });
  items.push({ label: "对端地址", value: endpoint.host, ok: null });
  items.push({
    label: "系统版本",
    value: `${Device.systemName} ${Device.systemVersion} · ${Device.model}`,
    ok: null,
  });

  log("查询本机隧道状态…");
  try {
    const state = await VPN.localDevVPN.getState();
    items.push({
      label: "本机隧道",
      value: `${state.effectiveStatus}（VPN ${state.vpnStatus}）`,
      ok: endpoint.source === "proxyApp" ? null : state.effectiveStatus === "active",
    });
    items.push({
      label: "自身反射地址",
      value: state.effectiveAddresses.length > 0 ? state.effectiveAddresses.join("、") : "（无）",
      ok: endpoint.source === "proxyApp" ? null : state.effectiveAddresses.length > 0,
    });
    if (state.problem) items.push({ label: "隧道报错", value: state.problem, ok: false });
  } catch (error) {
    items.push({ label: "本机隧道", value: describeError(error), ok: false });
  }

  /*
    Scripting 自己那条 VPN 的状态。

    注意它**只能看到自己**——dts 原文：「App-only global control of Scripting's
    VPN」。iOS 不让应用读别家的 VPN 配置，所以看不出当前是 Loon 还是 Surge 在跑，
    这一项也无从判断代理工具有没有起来。
    判定按模式反过来：自身模式要它连着，代理模式要它**断开**（名额得让出去）。
  */
  try {
    const vpn = await VPN.getState();
    debugLog("vpn", "Scripting 自身 VPN", JSON.stringify(vpn));
    const profile = vpn.selectedConfigurationName ?? vpn.providerBundleId ?? "（未选择）";
    const connected = vpn.status === "connected";
    items.push({
      label: "Scripting 的 VPN",
      value:
        endpoint.source === "proxyApp" && !connected
          ? `${profile} · ${vpn.status}（已让出名额，正常）`
          : `${profile} · ${vpn.status}`,
      ok: endpoint.source === "proxyApp" ? !connected : connected,
    });
    if (vpn.problem) items.push({ label: "VPN 报错", value: vpn.problem, ok: false });
  } catch (error) {
    items.push({ label: "Scripting 的 VPN", value: describeError(error), ok: null });
  }

  log("探测配对端口…");
  /*
    只探现成的落点，不跑全段扫描——那要好几秒，诊断页该是秒回的。
    缓存里存的是上次握成的「地址 + 端口」，蜂窝下它未必是隧道对端。
  */
  const cached = Storage.get<PairingTarget>(PORT_CACHE_KEY);
  const probes: PairingTarget[] = [];
  if (cached && typeof cached.host === "string" && Number(cached.port) > 0) {
    pushTarget(probes, { host: cached.host, port: Number(cached.port) });
  }
  pushTarget(probes, { host: endpoint.host, port: PORT_RANGE_START });

  let reachable: PairingTarget | null = null;
  for (const target of probes) {
    if (await probeTCP(target.host, target.port, 1500)) {
      reachable = target;
      break;
    }
  }
  items.push({
    label: "配对端口",
    value: reachable
      ? `${reachable.host}:${reachable.port} 可达`
      : `${probes.map((target) => `${target.host}:${target.port}`).join("、")} 无响应`,
    ok: !!reachable,
  });

  items.push({
    label: "配对记录",
    value: options.record ? options.record.identifier : "未导入",
    ok: !!options.record,
  });

  if (reachable) {
    log("与设备握手…");
    let stream: ByteStream | null = null;
    try {
      stream = await connectTCP(reachable.host, reachable.port, 4000);
      const client = new RemotePairingClient(new RpPairingSocket(stream));
      const peer = await withTimeout(client.attemptPairVerify(), 6000, "握手超时");
      items.push({ label: "设备握手", value: "成功", ok: true });
      // 这是 RemotePairing 的 wire protocol version，和 iOS 版本没关系——
      // 两者数字撞上了（设备报 26、系统也叫 iOS 26），被当成系统版本问过一次。
      items.push({
        label: "RemotePairing 协议",
        value:
          `v${peer.wireProtocolVersion ?? "?"}（最低支持 v${peer.minimumWireProtocolVersion ?? "?"}）` +
          "，与 iOS 版本无关",
        ok: null,
      });
      items.push({
        label: "接受隧道连接",
        value: peer.allowsIncomingTunnelConnections === false ? "否" : "是",
        ok: peer.allowsIncomingTunnelConnections !== false,
      });
      // 这一项只说明「能不能反过来对设备发起 pair-setup」，是主动方的方向。
      // 「配对这台设备」走的是响应方：我们广播成可配对主机、设备来连我们、
      // PIN 在系统设置里输，不受这个标志影响。别把它读成「配不了对」。
      items.push({
        label: "对设备发起配对",
        value:
          peer.allowsPairSetup === true
            ? "设备允许"
            : "设备不允许（不影响「配对这台设备」）",
        ok: null,
      });
    } catch (error) {
      items.push({ label: "设备握手", value: describeError(error), ok: false });
    } finally {
      if (stream) {
        try {
          await stream.close();
        } catch {
          // 诊断用的连接，关不掉也无妨。
        }
      }
    }
  }

  debugLog("diag", "诊断结果", JSON.stringify(items));
  return items;
}

/**
 * 建隧道；失败时再开一个监听做 TLS 探测，把锅分到设备侧还是客户端侧。
 *
 * 注意：**拿到端口后绝不能先探测**。监听是一次性的，一次普通 TCP 连接就会把它
 * 消费掉，之后 openRSDTunnel 连到的是个死监听——上一版就因此把错误 6 测成了 7。
 * 实测 peerConnectionsInfo 与 identity 两个参数都不影响结果，故不再逐个重试。
 */
async function openTunnelWithDiagnostics(
  endpoint: TunnelEndpoint,
  firstPort: number,
  preSharedKey: Uint8Array,
): Promise<VPNRSDTunnel> {
  let lastError: unknown = null;

  /*
    开隧道之前先看一眼自身状态，但**只在「Scripting 自身」模式下据此拦截**。

    代理工具模式下自身隧道本来就是 inactive（回环由代理提供），拿它当拦截条件
    等于永远不让试。这里以前真的拦了——应用后来支持了代理提供的回环，
    结果还是弹我们自己那句「只接受 Scripting 自己的回环」，用户以为是应用没改。
    现在代理模式下只记一笔就放行，成不成交给 openRSDTunnel 自己说。
  */
  const preflight = await VPN.localDevVPN.getState();
  debugLog("tunnel", `开隧道前自身状态（来源=${endpoint.source}）`, JSON.stringify(preflight));
  if (endpoint.source === "builtIn" && preflight.effectiveStatus !== "active") {
    throw new Error(
      `本机隧道尚未生效（${preflight.effectiveStatus}，VPN ${preflight.vpnStatus}）。
` +
        "请确认 Scripting 已获得 VPN 权限，且系统里没有别的 VPN 占着。",
    );
  }

  try {
    debugLog("tunnel", `openRSDTunnel host=${endpoint.host} port=${firstPort}`);
    /*
      必须包超时。

      openRSDTunnel 自己不超时：对端不回 TLS 握手时它就一直挂着，既不成功也不
      失败。飞行模式下正是这样——界面停在「建立加密隧道…」，上层的重试循环
      以为这一轮还在跑，于是再也不发起下一轮（蜂窝引导就栽在这儿，试两次就死）。
      15 秒：正常建隧道是百毫秒级，这个值只用来兜住挂死。
    */
    const tunnel = await withTimeout(
      VPN.localDevVPN.openRSDTunnel({
        host: endpoint.host,
        port: firstPort,
        preSharedKey,
      }),
      15000,
      `建立加密隧道超时（端口 ${firstPort}）`,
    );
    debugLog("tunnel", "隧道已建立", JSON.stringify(await tunnel.getState()));
    return tunnel;
  } catch (error) {
    lastError = error;
    debugLog("tunnel", "openRSDTunnel 失败", describeError(error));
  }

  debugLog("tunnel", "此时的本机隧道状态", JSON.stringify(await VPN.localDevVPN.getState()));

  // 这里曾经自动跑一次 TLS ClientHello 探测来判断锅在哪一侧。那是为了取证
  // openRSDTunnel 的 Failure 6，该 bug 已修；而探测会消费掉一次性的隧道监听，
  // 让这次失败更难复查。要取证的话去「连接状态」页手动跑。
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `建立加密隧道失败：${detail}
` +
      `（端口 ${firstPort}，PSK ${preSharedKey.length} 字节）
` +
      "配对与申请监听都已成功，卡在隧道握手这一步。详细日志见 scripting-cli 终端。",
  );
}

/**
 * 启动定位模拟。
 *
 * 任一步失败都会把已经建立的连接收干净再抛错，不留半开的隧道。
 */
/** 已建好的定位通道：拿到它就能下发坐标，用完必须 teardown。 */
interface LocationChannel {
  peer: PeerHandshakeInfo;
  simulation: LocationSimulation;
  dtx: DtxConnection;
  tunnel: VPNRSDTunnel;
  pairingStream: ByteStream;
  teardown: () => Promise<void>;
}

/**
 * 一路连到 DVT 的定位频道：隧道 → 配对 → RSD → DVT。
 *
 * 「开始模拟」和「恢复真实位置」走的是同一条连接流程，只是最后一步一个发坐标、
 * 一个发停止，所以抽出来共用——两边各写一遍迟早会走样。
 */
async function openLocationChannel(
  record: PairingRecord,
  endpoint: TunnelEndpoint,
  log: StatusReporter,
): Promise<LocationChannel> {
  debugLog("vpn", `隧道来源=${endpoint.source} 对端=${endpoint.host}`);
  await ensureTunnelReady(endpoint, log);

  // 自身的反射地址只作记录。2026-10-16 实测：代理工具模式下自身隧道 inactive、
  // effectiveAddresses 为空，openRSDTunnel 照样能建起来——它已经不要求对端地址
  // 出现在自己的反射列表里了。所以这里不再当成「可能被拒」的征兆。
  const vpnState = await VPN.localDevVPN.getState();
  debugLog("vpn", "自身生效地址", JSON.stringify(vpnState.effectiveAddresses));
  if (!vpnState.effectiveAddresses.some((address) => address.split("/")[0] === endpoint.host)) {
    debugLog(
      "vpn",
      `${endpoint.host} 不在自身隧道的生效地址里（来源=${endpoint.source}）——` +
        "代理模式下本就如此，不影响建立隧道",
    );
  }

  const pairing = await openPairingSession(endpoint, log);

  async function closeQuietly(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch {
      // 收尾失败无所谓，调用方已经在报错路径上了。
    }
  }

  let preSharedKey: Uint8Array;
  let tunnelPort: number;
  try {
    log("校验配对记录…");
    await withTimeout(pairing.client.validatePairing(record), 20000, "pair-verify 超时");
    debugLog("pair", "pair-verify 通过");
    log("申请隧道端口…");
    tunnelPort = await withTimeout(
      pairing.client.createTcpListener({ peerConnectionsInfo: false }),
      15000,
      "申请隧道端口超时",
    );
    preSharedKey = pairing.client.preSharedKey;
    debugLog(
      "pair",
      // 只记长度，不记内容——日志会被贴进 issue 和聊天窗口，密钥不该跟着走。
      `隧道端口 ${tunnelPort}，PSK ${preSharedKey.length} 字节`,
    );
  } catch (error) {
    debugLog("pair", "配对阶段失败", describeError(error));
    await closeQuietly(() => pairing.stream.close());
    throw error;
  }

  // 配对连接要留到会话结束：设备的隧道监听挂在这条会话上，提前关掉它就会被一起收走。
  log(`建立加密隧道（${tunnelPort}）…`);
  let tunnel: VPNRSDTunnel;
  try {
    /*
      隧道要连回**握上手的那个地址**，不是设置里的隧道对端。

      设备申请到的监听跟着配对连接走，而配对未必是在 10.7.0.1 上握成的
      （蜂窝下往往是 Bonjour 公告里的另一个地址）。照旧用 endpoint.host
      就会把隧道开到一个没人听的地方去。
    */
    tunnel = await openTunnelWithDiagnostics(
      { ...endpoint, host: pairing.host },
      tunnelPort,
      preSharedKey,
    );
  } catch (error) {
    await closeQuietly(() => pairing.stream.close());
    throw error;
  }

  let dtx: DtxConnection | null = null;
  try {
    const tunnelState = await tunnel.getState();

    log("查询设备服务…");
    debugLog("rsd", `连 RSD 端口 ${tunnelState.rsdPort}`);
    const rsdConnection = await tunnel.connect({ port: tunnelState.rsdPort });
    let servicePort: number;
    try {
      const services = await withTimeout(
        discoverServices(wrapTunnelConnection(rsdConnection)),
        20000,
        "查询服务列表超时",
      );
      debugLog("rsd", `服务表 ${services.size} 项`, [...services.keys()].join(", "));
      servicePort = dvtPort(services);
      debugLog("rsd", `dtservicehub 端口 ${servicePort}`);
    } finally {
      await rsdConnection.close();
    }

    log("打开定位服务…");
    const dvtConnection = await tunnel.connect({ port: servicePort });
    dtx = new DtxConnection(wrapTunnelConnection(dvtConnection));
    const simulation = await LocationSimulation.open(dtx);
    debugLog("dvt", "定位频道已打开");

    const opened = dtx;
    return {
      peer: pairing.peer,
      simulation,
      dtx: opened,
      tunnel,
      pairingStream: pairing.stream,
      teardown: async () => {
        await closeQuietly(() => opened.close());
        await closeQuietly(() => tunnel.close());
        await closeQuietly(() => pairing.stream.close());
      },
    };
  } catch (error) {
    debugLog("rsd", "隧道内阶段失败", describeError(error));
    await closeQuietly(async () => dtx?.close());
    await closeQuietly(() => tunnel.close());
    await closeQuietly(() => pairing.stream.close());
    throw error;
  }
}

/**
 * 启动定位模拟。
 *
 * 任一步失败都会把已经建立的连接收干净再抛错，不留半开的隧道。
 */
export async function startLocationSession(options: {
  record: PairingRecord;
  endpoint: TunnelEndpoint;
  latitude: number;
  longitude: number;
  /** 是否按心跳持续重发坐标，默认开启。 */
  keepAlive?: boolean;
  onStatus?: StatusReporter;
  onFailure?: (message: string) => void;
}): Promise<LocationSessionHandle> {
  const log = options.onStatus ?? (() => {});
  const channel = await openLocationChannel(options.record, options.endpoint, log);

  try {
    log("下发坐标…");
    await channel.simulation.set(options.latitude, options.longitude);
    debugLog("dvt", `坐标已下发 ${options.latitude}, ${options.longitude}`);
  } catch (error) {
    await channel.teardown();
    throw error;
  }

  return createHandle({
    peer: channel.peer,
    simulation: channel.simulation,
    dtx: channel.dtx,
    tunnel: channel.tunnel,
    pairingStream: channel.pairingStream,
    latitude: options.latitude,
    longitude: options.longitude,
    keepAlive: options.keepAlive !== false,
    onFailure: options.onFailure,
  });
}

/**
 * 手动跑一次 TLS-PSK 取证。
 *
 * 向设备申请一个隧道监听，然后自己拼一个 TLS 1.2 ClientHello 发过去，看它回什么：
 *   ServerHello → 设备的 PSK 端点是好的，问题在原生客户端那边
 *   Alert       → 设备主动拒绝，返回里带着拒绝原因
 *
 * **会消费掉一次性的隧道监听**，所以不放在自动失败路径上——跑完这次，
 * 本次会话的那个监听就没了，要重新配对握手。只在排查隧道问题时手动用。
 */
export async function probeTunnelTls(
  record: PairingRecord,
  endpoint: TunnelEndpoint,
  log: StatusReporter = () => {},
): Promise<string> {
  await ensureTunnelReady(endpoint, log);
  const session = await openPairingSession(endpoint, log);
  try {
    await session.client.validatePairing(record);
    log("申请探测用端口…");
    const port = await withTimeout(session.client.createTcpListener(), 15000, "申请端口超时");
    log(`用端口 ${port} 发 ClientHello…`);
    // 跟建隧道一样，要连回握上手的那个地址——监听是挂在这条配对连接上的。
    const result = await probeTlsPsk(session.host, port);
    debugLog("probe", "探测结果", `${result.outcome}：${result.detail}`);
    return `${result.outcome}：${result.detail}`;
  } finally {
    await session.stream.close().catch(() => undefined);
  }
}

/**
 * 独立验证一份配对记录能不能用。
 *
 * 用在「配对这台设备」之后：PIN 握手成功只说明 SRP 那一步对了，不代表设备
 * 之后会认这份记录。先用它单独跑一次 pair-verify，过了才覆盖钥匙串里的旧记录——
 * 配对途中任何一步出岔子都可能留下一份连不上的记录，直接覆盖会把本来能用的那份弄丢。
 */
export async function verifyPairingRecord(
  record: PairingRecord,
  endpoint: TunnelEndpoint,
  log: StatusReporter = () => {},
): Promise<void> {
  await ensureTunnelReady(endpoint, log);
  const session = await openPairingSession(endpoint, log);
  try {
    await session.client.validatePairing(record);
  } finally {
    await session.stream.close().catch(() => undefined);
  }
}

/**
 * 只发一次「停止模拟」然后断开，不建立持续会话。
 *
 * 用于上次会话没有正常收尾的情况：脚本被杀、隧道掉线时，停止指令没能送出去，
 * 设备可能还保持着最后那个模拟位置。这时重新连一次把指令补上即可。
 */
export async function restoreRealLocation(options: {
  record: PairingRecord;
  endpoint: TunnelEndpoint;
  onStatus?: StatusReporter;
}): Promise<void> {
  const log = options.onStatus ?? (() => {});
  const channel = await openLocationChannel(options.record, options.endpoint, log);

  try {
    log("发送停止指令…");
    await channel.simulation.clear();
    debugLog("dvt", "已发送 stopLocationSimulation");
  } finally {
    await channel.teardown();
    await nudgeRealLocation();
  }
}

function createHandle(context: {
  peer: PeerHandshakeInfo;
  simulation: LocationSimulation;
  dtx: DtxConnection;
  tunnel: VPNRSDTunnel;
  /** 配对连接，隧道监听的归属，会话结束前不能关。 */
  pairingStream: ByteStream;
  latitude: number;
  longitude: number;
  keepAlive: boolean;
  onFailure?: (message: string) => void;
}): LocationSessionHandle {
  let latitude = context.latitude;
  let longitude = context.longitude;
  let stopped = false;
  // DTX 连接同时只允许一个待完成读写，所有调用串成一条链。
  let queue: Promise<unknown> = Promise.resolve();
  let keepalive: ReturnType<typeof setInterval> | null = null;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  async function shutdown(): Promise<void> {
    if (keepalive !== null) {
      clearInterval(keepalive);
      keepalive = null;
    }
    try {
      await context.dtx.close();
    } catch {
      // 连接已经断了也无所谓。
    }
    try {
      await context.tunnel.close();
    } catch {
      // 同上
    }
    try {
      await context.pairingStream.close();
    } catch {
      // 同上
    }

    // 连接一断，设备侧的模拟就结束了；再催一次定位，免得界面上仍显示旧坐标。
    await nudgeRealLocation();
  }

  if (context.keepAlive) {
    /*
      心跳失败不等于会话完了，得先宽限几拍。

      原先一失败就 shutdown()，而它会把 dtx、tunnel、pairingStream 一起关掉——
      隧道是我们自己毁的，上层想重连就只能从配对握手开始整套重来，又慢又容易
      再失败。而最常见的失败根本不是掉线，是网络切换的那一两秒（关掉飞行模式、
      WiFi 转蜂窝），隧道本身好端端的，下一拍就能恢复。

      所以连续失败到上限才拆链。原生那版同样只在「隧道与服务仍在」时做轻量重连，
      这里是同一个思路的下沉实现——让隧道活着，重连就不必发生。
    */
    let misses = 0;
    keepalive = setInterval(() => {
      if (stopped) return;
      void enqueue(() => context.simulation.set(latitude, longitude))
        .then(() => {
          if (misses > 0) {
            debugLog("dvt", `心跳恢复（此前连续失败 ${misses} 次）`);
            misses = 0;
          }
        })
        .catch(async (error) => {
          if (stopped) return;
          misses += 1;
          if (misses < KEEPALIVE_MAX_MISSES) {
            debugLog(
              "dvt",
              `心跳第 ${misses} 次失败，隧道未关，等下一拍：${describeError(error)}`,
            );
            return;
          }
          stopped = true;
          await shutdown();
          context.onFailure?.(
            `定位会话已中断：${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }, KEEPALIVE_INTERVAL);
  }

  return {
    peer: context.peer,
    async update(nextLatitude: number, nextLongitude: number): Promise<void> {
      if (stopped) throw new Error("定位会话已结束");
      latitude = nextLatitude;
      longitude = nextLongitude;
      await enqueue(() => context.simulation.set(nextLatitude, nextLongitude));
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (keepalive !== null) {
        clearInterval(keepalive);
        keepalive = null;
      }
      try {
        await enqueue(() => context.simulation.clear());
      } finally {
        await shutdown();
      }
    },
  };
}
