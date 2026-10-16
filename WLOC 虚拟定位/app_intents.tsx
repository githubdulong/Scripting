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

/** 主脚本上次报平安在这之内，算它还在。它每秒报一次，留三拍余量。 */
const MAIN_ALIVE_MS = 3000;
/** 等主脚本回执的上限。停止指令走现成连接，正常一两秒就回来。 */
const ACK_TIMEOUT_MS = 10_000;
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
      body: `${failure}。点这里打开 WLOC 再试。`,
    }).catch(() => false);
  },
});

/**
 * @returns 失败原因；成功为 null
 *
 * 主脚本开着会话时交给它收尾：会话心跳每 4 秒重发假坐标，这边另开连接发停止，
 * 几秒后就会被盖回去。主脚本不在（被划掉了）或迟迟不回话，才自己连上去。
 */
async function restore(): Promise<string | null> {
  if (sessionBeatAge() < MAIN_ALIVE_MS) {
    const ack = await askMainScript();
    if (ack) return ack.ok ? null : ack.message ?? "停止失败";
  }
  return restoreDirectly();
}

async function askMainScript(): Promise<RestoreAck | null> {
  const id = requestRestore();
  const deadline = Date.now() + ACK_TIMEOUT_MS;
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
