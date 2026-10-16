// 跳到本应用（Scripting）在「设置」里的那一页。
//
// iOS 只开放这一种跳转。iOS 27.2 上实测过两轮，结论是深链一条都用不了：
//
//   prefs:root=DEVELOPER_SETTINGS#DTPairedDevicesGroup   被拒绝
//   prefs:root=DEVELOPER_SETTINGS                        被拒绝
//   prefs:root=Privacy                                   被拒绝
//   prefs:root=Privacy&path=LOCAL_NETWORK                被拒绝
//   App-prefs:<任意 ROOT 名>                              跳转「设置 → App」列表
//   App-prefs:com.apple.Preferences                      可跳（bundle ID 形式）
//   app-settings:                                        可跳（本应用设置页）
//
// `prefs:` 整个前缀在 Scripting 里不放行——社区清单里那些路径在快捷指令能用，
// 是因为快捷指令是系统应用。而 iOS 18 起 `App-prefs:` 的语义改成了「按 bundle ID
// 跳应用设置页」，ROOT 名一律失效，这也是它们全落到 App 列表的原因。
//
// 这不只是实测结论，苹果官方也是这么说的。DTS 的 Quinn 维护着一份
// 「Supported URL Schemes」清单（developer.apple.com/forums/thread/761314），
// 列全了所有被认可的跳设置方式：
//
//   UIApplication.openSettingsURLString                      本应用设置页（= app-settings:）
//   UIApplication.openNotificationSettingsURLString          通知设置        iOS 16+
//   UIApplication.openDefaultApplicationsSettingsURLString   默认应用        iOS 18.3+
//   AccessibilitySettings.openSettings(for:)                 辅助功能
//   CXCallDirectoryManager.openSettings(_:)                  来电拦截
//   SFSafariSettings.openExtensionsSettings(forIdentifiers:) Safari 扩展
//   SMAppService.openSystemSettingsLoginItems()              登录项（macOS）
//   FIFinderSyncController.showExtensionManagementInterface()
//   VSOpenTVProviderSettingsURLString
//
// **没有「隐私与安全性」，也没有「开发者模式」**，苹果在同一页写明：不在列表里的
// 去提 enhancement request。同帖还有个直接印证——有人报告
// `App-prefs:ACCESSIBILITY&path=HEARING_AID_TITLE` 在 iOS 17 还能跳到助听设备，
// iOS 18 就只落到设置根页，苹果的回复就是指向这份清单。
//
// 结论：「设置 → 隐私与安全性 → 开发者 → 配对」只能继续写文字指引，别再试了。
//
// 但这一页本身就够用：**实时活动、本地网络、通知三个开关都在这儿**，
// 而它们被关掉恰好是「卡片不显示」「找不到设备」最常见的原因。

import { debugLog } from "../core/debug";

/** @returns 是否真的跳过去了；false 时调用方该把路径用文字写出来 */
export async function openAppSettings(): Promise<boolean> {
  try {
    const ok = await Safari.openURL("app-settings:");
    debugLog("ui", `跳转应用设置页：${ok}`);
    return ok;
  } catch (error) {
    debugLog("ui", "跳转应用设置页出错", String(error));
    return false;
  }
}
