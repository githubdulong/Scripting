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

// 实时活动卡片上的按钮要执行的动作。
//
// 按系统要求，AppIntent 必须在这个文件里注册，卡片那边只能引用注册结果。
//
// 这里只放一个「恢复真实位置」：卡片存在的全部意义就是提醒你当前位置是假的，
// 那就该让你在锁屏上一键收尾，而不是解锁、找到 App、再点一次。

import { AppIntentManager, AppIntentProtocol, LiveActivity, Notification } from "scripting";
import { loadPairing } from "./core/pairing";
import { restoreRealLocation } from "./core/session";
import { debugLog, describeError } from "./core/debug";
import { clearRecovery, loadSessionID, loadSettings } from "./utils/storage";

/**
 * 主脚本处理完恢复请求后回的东西。
 *
 * 用 `type` 不用 `interface`，`message` 用 `null` 不用可选属性——两者都是为了
 * 满足 `ScriptSession.Value`：那个类型要求能 JSON 化，而 `string | undefined`
 * 不在其中，interface 也不会隐式满足它的索引签名。
 */
type RestoreAck = {
  ok: boolean;
  /** 失败原因；成功时为 null。 */
  message: string | null;
};

/**
 * 等主脚本回话的上限，取 `ScriptSession.request` 允许的最大值（100–30000）。
 *
 * 有现成会话时一两秒就回来。但主脚本**没有**会话时它要自己连一次设备补发停止
 * （握手 → pair-verify → 建隧道 → 下发），再加上锁屏时它可能先得醒过来，
 * 默认的 10 秒不够——超时就会退回去走那条根本走不通的自连路径，白等一场。
 */
const ASK_TIMEOUT_MS = 30_000;

/**
 * 在锁屏/灵动岛上恢复真实位置。
 *
 * 这个 intent 跑在单独的环境里（Script.env 为 "app_intents"），界面上的状态
 * 一概拿不到。成功才收卡片；失败卡片留着、再发条通知说明原因——上一版不论
 * 成败都收卡片，结果是「卡片没了，定位还在」，比什么都不做更误导。
 */
export const RestoreLocationIntent = AppIntentManager.register({
  name: "WlocRestoreLocation",
  protocol: AppIntentProtocol.LiveActivityIntent,
  perform: async (_params: undefined) => {
    const failure = await restore();
    if (failure === null) {
      // 用静态的 endAllActivities——这里拿不到主脚本起的那个活动句柄。
      await LiveActivity.endAllActivities({ dismissTimeInterval: 0 }).catch(() => undefined);
      return;
    }
    // 点通知默认打开本脚本；恢复记录还在，启动时会接着提示恢复。
    await Notification.schedule({
      title: "没能恢复真实位置",
      body: shortReason(failure),
    }).catch(() => false);
  },
});

/**
 * 把失败原因压成通知能放下的一句。
 *
 * 连接失败那套诊断文案有十几行（分步骤讲怎么开关飞行模式），放在 App 里是对的，
 * 塞进锁屏通知就只剩前两行、后面全被截断，等于什么也没说。锁屏上用户能做的
 * 其实只有一件事——打开 App 再试，那就只说这个。
 */
function shortReason(failure: string): string {
  // 「只绑回环」是能确诊的那一种，直接给出唯一有效的动作，不必让用户先打开 App。
  if (failure.includes("只绑在回环地址")) {
    return "配对服务没绑网络接口。开关一次飞行模式，再打开 WLOC 重试。";
  }
  if (failure.includes("拒绝了连接") || failure.includes("ECONNREFUSED")) {
    return "连不上设备。用蜂窝数据时常见，打开 WLOC 按提示操作一次即可。";
  }
  if (failure.includes("路由") || failure.includes("ENETUNREACH")) {
    return "网络不可达，飞行模式可能开着。关掉之后打开 WLOC 再试。";
  }
  if (failure.includes("没有配对记录")) {
    return "没有配对记录，需要先在 WLOC 里配对这台设备。";
  }
  // 兜底：取第一句，别把整段倒进通知
  const first = failure.split(/[。\n]/)[0];
  return `${first}。点这里打开 WLOC 再试。`;
}

/**
 * @returns 失败原因；成功为 null
 *
 * 主脚本开着会话时交给它收尾：会话心跳每 4 秒重发假坐标，这边另开连接发停止，
 * 几秒后就会被盖回去。主脚本不在（被划掉了）或迟迟不回话，才自己连上去。
 */
async function restore(): Promise<string | null> {
  /*
    先问主脚本，问不到才自己连。

    以前这里要先看心跳新不新鲜来决定等多久——而心跳本身就是个近似值，锁屏时
    iOS 会节流后台定时器，为此把阈值从 3 秒放宽到过 15 秒。现在不需要了：
    `ScriptSession.request` 要么拿到回话，要么直接失败，没有中间地带。

    注意它**不会唤起**主脚本（dts: No autolaunch, wake or keep-alive）。主脚本
    真的不在，request 立刻报错，正好走下面的自连。
  */
  const ack = await askMainScript();
  if (ack) return ack.ok ? null : ack.message ?? "停止失败";
  return restoreDirectly();
}

/** @returns 主脚本的处理结果；它不在、或者没能回话时返回 null */
async function askMainScript(): Promise<RestoreAck | null> {
  const id = loadSessionID();
  if (!id) {
    debugLog("intent", "没有主脚本的会话 ID，直接自己连");
    return null;
  }
  try {
    const ack = await ScriptSession.request<RestoreAck>(
      id,
      { type: "restore" },
      { timeout: ASK_TIMEOUT_MS },
    );
    debugLog("intent", `主脚本回话 ${JSON.stringify(ack)}`);
    return ack;
  } catch (error) {
    // 主脚本不在、ID 过期、超时都会走到这儿——都该回落到自己连设备。
    debugLog("intent", "主脚本没回话，改为自己连", describeError(error));
    return null;
  }
}

/**
 * 不经主脚本，自己连上设备补发一次停止指令。
 *
 * **这条路在这个环境里多半走不通**，留着只是最后的挣扎。
 * `local_dev_vpn` 文档写明本机隧道「所有操作仅允许原始活跃主 App 脚本」——
 * 这里是 app_intents 环境，不是主 App，`openRSDTunnel` 预期会被拒。
 *
 * 所以真正的出路是让主脚本去做：它有没有会话都能处理（见 index.tsx 里注册的
 * 那个 handler）。只有主脚本**完全不在**、`request` 都投不出去时才会落到这儿，
 * 而那时用户能做的其实只有打开 App —— 失败提示要照这个说。
 */
async function restoreDirectly(): Promise<string | null> {
  const record = loadPairing();
  if (!record) return "没有配对记录";

  const settings = loadSettings();
  try {
    await restoreRealLocation({
      record,
      endpoint: { host: settings.deviceHost, source: settings.tunnelSource },
    });
    // 停止指令送到了，上次会话的未收尾记录可以清掉。
    clearRecovery();
    return null;
  } catch (e) {
    debugLog("intent", "自连补发失败（本机隧道只允许主 App 操作）", describeError(e));
    return "WLOC 没在运行，锁屏这边连不上设备。请打开 WLOC，它会接着提示恢复。";
  }
}
