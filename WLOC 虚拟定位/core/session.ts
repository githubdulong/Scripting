// 定位会话编排：本机隧道 → 配对握手 → RSD 隧道 → DVT 位置模拟。
//
// 与 wloc（iOS）同一条链路，区别只在隧道那一段：
// wloc 自己实现 TLS-PSK + CDTunnel，这里交给 VPN.localDevVPN.openRSDTunnel。
//
// 设备的 RemotePairing 端口本应由 Bonjour 公布，Scripting 没有 mDNS 接口，
// 只能扫端口再用 RPPairing 握手确认——握手帧头对不上就不是它。

import { dvtPort, discoverServices } from "./rsd";
import { toHex } from "./bytes";
import { debugLog, describeError } from "./debug";
import { DtxConnection } from "./dtx";
import { LocationSimulation } from "./location";
import { RemotePairingClient, RpPairingSocket, type PeerHandshakeInfo } from "./rppairing";
import { connectTCP, probeTCP } from "./tcp";
import { discoverPairingPort } from "./bonjour";
import { probeTlsPsk } from "./tlsprobe";
import { delay, withTimeout, type ByteStream } from "./stream";
import { loadPairing, type PairingRecord } from "./pairing";
import type { TunnelSource } from "../types";

const PORT_RANGE_START = 49152;
const PORT_RANGE_END = 49400;
const PORT_SCAN_BATCH = 24;
const PORT_SCAN_TIMEOUT = 450;
const PORT_CACHE_KEY = "wloc_pairing_port_v1";
/** 位置下发的心跳间隔，与 wloc 的 4 秒一致：设备久不收就会把会话收掉。 */
const KEEPALIVE_INTERVAL = 4000;

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

    log("检查代理工具提供的回环地址…");
    // 不逐个扫端口，只确认对端地址有响应——配对端口随后会扫。
    const reachable = await probeTCP(endpoint.host, PORT_RANGE_START, 1500);
    debugLog("vpn", `代理模式下 ${endpoint.host}:${PORT_RANGE_START} ${reachable ? "可达" : "暂不可达"}`);
    if (!reachable) {
      log(`${endpoint.host} 暂无响应，仍继续尝试…`);
    }
    return;
  }

  await ensureLocalDevVPN(endpoint, log);
}

/**
 * 确认 Scripting 自身的本机隧道已生效，并返回它实际在反射的地址。
 *
 * openRSDTunnel 的 host 必须是「已生效的数字 IPv4 反射地址」，所以把
 * effectiveAddresses 一并带出来给调用方核对——纯 TCP 能连通不代表原生侧认这个地址。
 */

async function ensureLocalDevVPN(endpoint: TunnelEndpoint, log: StatusReporter): Promise<VPNLocalDevState> {
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

/**
 * 缓存端口优先，然后是 Bonjour 公告的端口，最后才是全段扫描。
 *
 * 扫 49152-49400 要来回几百次 TCP 探测，而 Bonjour 一次解析就能直接拿到端口，
 * 还能用设备 IRK 校验公告确实来自这台设备。只是它依赖组播，不一定可用——
 * 旧记录没有 IRK、或者组播被挡住时就只能退回扫描。
 */
async function candidatePorts(endpoint: TunnelEndpoint, log: StatusReporter): Promise<number[]> {
  const ports: number[] = [];
  const cached = Number(Storage.get<number>(PORT_CACHE_KEY) ?? 0);
  if (cached > 0) ports.push(cached);

  log("查找配对服务…");

  const record = loadPairing();
  if (record?.altIrk && record.altIrk.length === 16) {
    try {
      const announced = await discoverPairingPort(record.altIrk);
      if (announced !== null && !ports.includes(announced)) {
        debugLog("scan", `Bonjour 公告端口 ${announced}`);
        ports.push(announced);
      }
    } catch (error) {
      debugLog("scan", "Bonjour 发现失败，退回端口扫描", describeError(error));
    }
  }
  if (ports.length > 0) return ports;

  debugLog("scan", `缓存端口 ${cached || "无"}，开始扫 ${PORT_RANGE_START}-${PORT_RANGE_END}`);
  for (let base = PORT_RANGE_START; base <= PORT_RANGE_END; base += PORT_SCAN_BATCH) {
    const batch: Promise<number | null>[] = [];
    for (let port = base; port < base + PORT_SCAN_BATCH && port <= PORT_RANGE_END; port++) {
      if (ports.includes(port)) continue;
      batch.push(probeTCP(endpoint.host, port, PORT_SCAN_TIMEOUT).then((open) => (open ? port : null)));
    }
    for (const port of await Promise.all(batch)) {
      if (port !== null) ports.push(port);
    }
  }

  debugLog("scan", "开放端口", ports.join(", ") || "无");
  if (ports.length === 0) {
    throw new Error(
      `${endpoint.host} 的 ${PORT_RANGE_START}-${PORT_RANGE_END} 没有开放端口。\n` +
        "请确认：① 已开启开发者模式；② 本机隧道已连接；③ 设备刚重启过的话需要重新配对。",
    );
  }
  return ports;
}

interface PairingSession {
  stream: ByteStream;
  client: RemotePairingClient;
  peer: PeerHandshakeInfo;
  port: number;
}

/** 逐个端口试 RPPairing 握手，握上即认定是配对服务。 */
async function openPairingSession(endpoint: TunnelEndpoint, log: StatusReporter): Promise<PairingSession> {
  const ports = await candidatePorts(endpoint, log);
  let lastError: unknown = null;

  for (const port of ports) {
    let stream: ByteStream | null = null;
    try {
      stream = await connectTCP(endpoint.host, port, 4000);
      const client = new RemotePairingClient(new RpPairingSocket(stream));
      const peer = await withTimeout(client.attemptPairVerify(), 6000, `${port} 端口握手超时`);
      log(`配对服务：${port}`);
      debugLog("pair", `端口 ${port} 握手成功`, JSON.stringify(peer));
      Storage.set(PORT_CACHE_KEY, port);
      return { stream, client, peer, port };
    } catch (error) {
      lastError = error;
      debugLog("pair", `端口 ${port} 不是配对服务`, describeError(error));
      if (stream) {
        try {
          await stream.close();
        } catch {
          // 关不掉就算了，这条连接本来就要丢。
        }
      }
    }
  }

  throw new Error(
    `试过 ${ports.length} 个端口都不是 RemotePairing 服务。` +
      `最后一个错误：${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
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

  log("探测配对端口…");
  const cached = Number(Storage.get<number>(PORT_CACHE_KEY) ?? 0);
  let reachablePort = 0;
  for (const port of cached > 0 ? [cached, PORT_RANGE_START] : [PORT_RANGE_START]) {
    if (await probeTCP(endpoint.host, port, 1500)) {
      reachablePort = port;
      break;
    }
  }
  items.push({
    label: "配对端口",
    value: reachablePort > 0 ? `${reachablePort} 可达` : `${endpoint.host} 无响应`,
    ok: reachablePort > 0,
  });

  items.push({
    label: "配对记录",
    value: options.record ? options.record.identifier : "未导入",
    ok: !!options.record,
  });

  if (reachablePort > 0) {
    log("与设备握手…");
    let stream: ByteStream | null = null;
    try {
      stream = await connectTCP(endpoint.host, reachablePort, 4000);
      const client = new RemotePairingClient(new RpPairingSocket(stream));
      const peer = await withTimeout(client.attemptPairVerify(), 6000, "握手超时");
      items.push({ label: "设备握手", value: "成功", ok: true });
      items.push({
        label: "协议版本",
        value: `设备 ${peer.wireProtocolVersion ?? "?"}（最低支持 ${peer.minimumWireProtocolVersion ?? "?"}）`,
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
  client: RemotePairingClient,
  firstPort: number,
  preSharedKey: Uint8Array,
  log: StatusReporter,
): Promise<VPNRSDTunnel> {
  let lastError: unknown = null;

  // openRSDTunnel 读的是 Scripting **自身**的隧道状态，不认别人提供的回环。
  // 代理工具模式下这里必定不满足，与其让原生那句英文原文漏到界面上
  // （"Turn on this app's VPN and LocalDevVPN…"，看着像是用户漏开了什么开关），
  // 不如提前说清楚：这是接口本身的限制，不是配置错了。
  const preflight = await VPN.localDevVPN.getState();
  if (preflight.effectiveStatus !== "active") {
    debugLog("tunnel", "开隧道前自身状态不满足", JSON.stringify(preflight));
    if (endpoint.source === "proxyApp") {
      throw new Error(
        "当前的隧道接口只接受 Scripting 自己的回环，不认代理工具提供的那条。\n" +
          `自身隧道现在是 ${preflight.effectiveStatus}（VPN ${preflight.vpnStatus}）。\n\n` +
          "请到设置里把「隧道来源」改成「Scripting 自身」再试——" +
          "它会顶掉正在运行的代理工具，这是目前唯一能走通的方式。\n" +
          "（配对与申请监听都已成功，差的只是这一步。）",
      );
    }
    throw new Error(
      `本机隧道尚未生效（${preflight.effectiveStatus}，VPN ${preflight.vpnStatus}）。\n` +
        "请确认 Scripting 已获得 VPN 权限，且系统里没有别的 VPN 占着。",
    );
  }

  try {
    debugLog("tunnel", `openRSDTunnel host=${endpoint.host} port=${firstPort}`);
    const tunnel = await VPN.localDevVPN.openRSDTunnel({
      host: endpoint.host,
      port: firstPort,
      preSharedKey,
    });
    debugLog("tunnel", "隧道已建立", JSON.stringify(await tunnel.getState()));
    return tunnel;
  } catch (error) {
    lastError = error;
    debugLog("tunnel", "openRSDTunnel 失败", describeError(error));
  }

  // 失败后再开一个监听，自己拼 ClientHello 探一次——这一步会消费监听，
  // 所以只在确定要报错时做。结论直接决定锅在哪一侧：
  //   ServerHello → 设备的 PSK 端点是好的，问题在原生客户端
  //   Alert       → 设备主动拒绝，带出拒绝原因
  let probeDetail = "未探测";
  try {
    const probePort = await withTimeout(client.createTcpListener(), 15000, "申请探测用端口超时");
    debugLog("probe", `用端口 ${probePort} 做 TLS ClientHello 探测`);
    const result = await probeTlsPsk(endpoint.host, probePort);
    probeDetail = `${result.outcome}：${result.detail}`;
    debugLog("probe", "探测结果", probeDetail);
  } catch (error) {
    probeDetail = `探测本身失败：${error instanceof Error ? error.message : String(error)}`;
    debugLog("probe", probeDetail);
  }

  debugLog("tunnel", "此时的本机隧道状态", JSON.stringify(await VPN.localDevVPN.getState()));

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(
    `建立加密隧道失败：${detail}\n` +
      `（端口 ${firstPort}，PSK ${preSharedKey.length} 字节）\n` +
      `TLS 探测：${probeDetail}\n` +
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

  // openRSDTunnel 要求「已生效的数字 IPv4 反射地址」，而它读的是 Scripting 自身的
  // 反射状态。由代理工具提供反射时这里必然对不上，先记一笔，真被拒时好对照。
  const vpnState = await VPN.localDevVPN.getState();
  debugLog("vpn", "自身生效地址", JSON.stringify(vpnState.effectiveAddresses));
  if (!vpnState.effectiveAddresses.some((address) => address.split("/")[0] === endpoint.host)) {
    debugLog(
      "vpn",
      `注意：${endpoint.host} 不在 Scripting 自身隧道的生效地址里` +
        `（来源=${endpoint.source}），openRSDTunnel 可能因此拒绝`,
      JSON.stringify(vpnState),
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
      `隧道端口 ${tunnelPort}，PSK ${preSharedKey.length} 字节 ${toHex(preSharedKey).slice(0, 16)}…`,
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
    tunnel = await openTunnelWithDiagnostics(endpoint, pairing.client, tunnelPort, preSharedKey, log);
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
    keepalive = setInterval(() => {
      if (stopped) return;
      void enqueue(() => context.simulation.set(latitude, longitude)).catch(async (error) => {
        if (stopped) return;
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
