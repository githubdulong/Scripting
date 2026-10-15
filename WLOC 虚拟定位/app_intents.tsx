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

import { AppIntentManager, AppIntentProtocol, LiveActivity } from "scripting";
import { loadPairing } from "./core/pairing";
import { restoreRealLocation } from "./core/session";
import { clearRecovery, loadSettings } from "./utils/storage";

/**
 * 在锁屏/灵动岛上恢复真实位置。
 *
 * 这个 intent 跑在脚本进程之外，界面上的状态一概拿不到，所以配对记录和设置
 * 都得重新读一遍。做完把卡片一并收掉——否则卡片还挂在那儿说「正在模拟」。
 */
export const RestoreLocationIntent = AppIntentManager.register({
  name: "WlocRestoreLocation",
  protocol: AppIntentProtocol.LiveActivityIntent,
  perform: async (_params: undefined) => {
    const record = loadPairing();
    if (!record) return;

    const settings = loadSettings();
    try {
      await restoreRealLocation({
        record,
        endpoint: { host: settings.deviceHost, source: settings.tunnelSource },
      });
      // 停止指令送到了，上次会话的未收尾记录可以清掉。
      clearRecovery();
    } finally {
      // 不论成没成都把卡片收掉：留着一张写「正在模拟」的卡片更容易误导。
      // 用静态的 endAllActivities——这个 intent 不在脚本进程里，拿不到原来那个活动句柄。
      await LiveActivity.endAllActivities({ dismissTimeInterval: 0 }).catch(() => undefined);
    }
  },
});
