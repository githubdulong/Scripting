// 调试日志：桌面端用 scripting-cli 连着时，这些会打到终端。
//
// 定位阶段很长（隧道 → 配对 → RSD → DVT），出错时界面只能给一句话，
// 真正有用的中间量（端口、地址、密钥长度、原生错误的附加字段）都从这里出。

/** 关掉就只剩界面上的状态文案。排障完成后可以置 false。 */
export const DEBUG = true;

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
