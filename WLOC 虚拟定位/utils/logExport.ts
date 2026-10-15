// 日志导出：存成 txt 再走系统分享。
//
// 两处用到：设置主页的直达入口、「连接状态」页里日志那一节。反馈问题最常走这条路，
// 所以主页也留了一个入口——埋三层的东西没人找得到。

import { Script } from "scripting";
import { debugLogText, debugLogCount } from "../core/debug";

/**
 * 导出日志，返回一行状态文案给调用方显示。
 *
 * 文本已经脱敏（见 `core/redact.ts`），头部带上版本和机型——光有正文的话
 * 对面还得再问一遍环境。文件名带时间戳：反馈时经常要连发好几份（改前、改后、
 * 换个模式再来一次），名字一样根本分不清哪份是哪份。
 */
export async function exportDebugLog(): Promise<string> {
  const text = debugLogText();
  if (!text) return "暂无日志";

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = `${FileManager.temporaryDirectory}/wloc-${stamp}.txt`;
  const header =
    `WLOC ${Script.metadata.version} · ${Device.systemName} ${Device.systemVersion} · ${Device.model}\n` +
    `${debugLogCount()} 条 · 已脱敏（坐标降精度、地名与自定义文本打码、地址与标识只留前缀）\n\n`;

  await FileManager.writeAsString(path, header + text);
  await ShareSheet.present([path]);
  return "已导出";
}
