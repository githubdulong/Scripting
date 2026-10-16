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
import { delay } from "./core/stream";
import {
  clearRecovery,
  loadRestoreAck,
  loadSettings,
  requestRestore,
  withdrawRestoreRequest,
  sessionBeatAge,
  type RestoreAck,
} from "./utils/storage";

/**
 * 主脚本上次报平安在这之内，算它「肯定还在」。
 *
 * 它每秒报一次，但**锁屏时 iOS 会节流后台定时器**，隔几秒才报一次是常态。
 * 这个值原先是 3 秒，太严了：稍一超时就判它死了、转去自己连设备，
 * 而蜂窝下那条路必然失败（mDNS 在蜂窝接口上找不到配对服务），
 * 用户看到的就是「锁屏点了没反应，还弹一条看不懂的通知」。
 */
const MAIN_ALIVE_MS = 15_000;
/** 心跳新鲜时等回执的上限。停止指令走现成连接，正常一两秒就回来。 */
const ACK_TIMEOUT_MS = 10_000;
/** 心跳过期时也投一次，只是少等——它可能只是被挂起，收到请求会醒。 */
const ACK_SHORT_MS = 4_000;
const ACK_POLL_MS = 300;

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
    先投请求，别拿心跳当硬门槛。

    心跳只决定「等多久」，不决定「要不要问」——主脚本被挂起时同样收得到请求，
    醒来就能用现成连接收尾，比我们自己从头连设备可靠得多。只有真的等不到
    才退回自己连。
  */
  const fresh = sessionBeatAge() < MAIN_ALIVE_MS;
  const ack = await askMainScript(fresh ? ACK_TIMEOUT_MS : ACK_SHORT_MS);
  if (ack) return ack.ok ? null : ack.message ?? "停止失败";
  return restoreDirectly();
}

async function askMainScript(timeoutMs: number): Promise<RestoreAck | null> {
  const id = requestRestore();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(ACK_POLL_MS);
    const ack = loadRestoreAck(id);
    if (ack) return ack;
  }
  // 等不到就撤回，免得这条请求留到下一次会话去误伤
  withdrawRestoreRequest(id);
  return null;
}

/** 不经主脚本，连上设备补发一次停止指令。配对记录和设置都得重新读。 */
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
    return e instanceof Error ? e.message : String(e);
  }
}
