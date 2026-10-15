// 调试日志：桌面端用 scripting-cli 连着时，这些会打到终端。
//
// 定位阶段很长（配对 → 隧道 → RSD → DVT），出错时界面只能给一句话，
// 真正有用的中间量（端口、地址、原生错误的附加字段）都从这里出。
//
// **这个文件不要删。** 排查定位问题几乎全靠它——反馈 issue 时也要带上日志，
// 没有日志的「连不上」基本只能靠猜。
//
// 写日志的规矩：**只记长度，不记内容**。密钥材料（私钥、PSK、PIN）一律不进日志，
// 日志会被贴进 issue 和聊天窗口。
//
// 位置、地址、设备标识这类拦不住的（排查时又确实需要），在导出那一刻统一打码，
// 见 `core/redact.ts`。

import { redactLog } from "./redact";

/**
 * 这个开关只管「要不要往终端刷」。
 *
 * 默认关闭：正常使用时不刷屏，也免得无意间把协议细节留在别人的终端里。
 * 接着 scripting-cli 调试时改成 `true` 重跑即可。
 *
 * **关掉不影响下面的缓冲区**——日志照样在记，在「连接状态」页就能复制出来。
 */
export const DEBUG = false;

/**
 * 最近若干条日志的环形缓冲。
 *
 * 之所以不受 `DEBUG` 控制：手机上出了问题，用户不可能为了看日志去改一行代码
 * 再重跑一遍——那时候现场早没了。缓冲区常开，随时能把日志交出来。
 * 开销就是几百条字符串，可以忽略。
 */
const RING_SIZE = 600;

interface LogEntry {
  stamp: string;
  line: string;
  /** 这一行连着刷了多少次。见 debugLog 里的折叠。 */
  count: number;
}

const ring: LogEntry[] = [];

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return describeError(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function debugLog(tag: string, ...args: unknown[]): void {
  const line = `[wloc:${tag}] ${args.map(formatArg).join(" ")}`;
  // 只留时分秒毫秒，日期对排查没用，反而占宽度。
  const stamp = new Date().toISOString().slice(11, 23);

  /*
    连着刷的同一行只占一条，末尾累加次数。

    保活续期、重试循环这类地方一秒能刷好几条，不折叠的话几十条噪音就把前面的
    连接过程（握手、隧道、RSD）挤出缓冲区了——而那才是排查「连不上」要看的东西。
  */
  const last = ring[ring.length - 1];
  if (last && last.line === line) {
    last.count += 1;
    last.stamp = stamp;
  } else {
    ring.push({ stamp, line, count: 1 });
    if (ring.length > RING_SIZE) ring.shift();
  }

  if (DEBUG) console.log(line);
}

/**
 * 整段日志文本。
 *
 * **默认脱敏**：这个函数的调用方全是「要把日志交出去」——导出成文件、复制进 issue。
 * 原文只留在内存缓冲区和 scripting-cli 的终端里。规则见 `core/redact.ts`。
 */
export function debugLogText(options?: { raw?: boolean }): string {
  const text = ring
    .map((entry) => (entry.count > 1 ? `${entry.stamp} ${entry.line} ×${entry.count}` : `${entry.stamp} ${entry.line}`))
    .join("\n");
  return options?.raw ? text : redactLog(text);
}

export function debugLogCount(): number {
  return ring.length;
}

export function clearDebugLog(): void {
  ring.length = 0;
}

/**
 * 原生抛出的错误往往带 code / reason / permission 一类的附加字段，
 * 而 `${error}` 只会给一句 localizedDescription，把它们全抖出来。
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Object)) return String(error);

  const parts: string[] = [];
  const anyError = error as Record<string, unknown>;
  if (typeof anyError.name === "string") parts.push(`name=${anyError.name}`);
  if (typeof anyError.message === "string") parts.push(`message=${anyError.message}`);

  for (const key of Object.getOwnPropertyNames(error)) {
    if (key === "stack" || key === "message" || key === "name") continue;
    let value: unknown;
    try {
      value = anyError[key];
    } catch {
      continue;
    }
    if (value === undefined) continue;
    parts.push(`${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }

  return parts.join(" ") || String(error);
}
