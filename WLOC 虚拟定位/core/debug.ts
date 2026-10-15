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

/**
 * 默认关闭。
 *
 * 平时只留界面上的状态文案，免得正常使用时刷屏、也免得无意间把协议细节
 * 留在别人的终端里。排查问题时改成 `true`，重跑一次脚本即可。
 */
export const DEBUG = false;

export function debugLog(tag: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  console.log(`[wloc:${tag}]`, ...args);
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
