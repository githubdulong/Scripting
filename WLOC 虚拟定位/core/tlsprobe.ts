// 隧道监听的 TLS 探针（排障用，不参与正常流程）。
//
// 隧道握手由 VPN.localDevVPN.openRSDTunnel 在原生侧完成，失败时只给一个错误号，
// 看不出是设备不接受 PSK 握手还是客户端那边的问题。
//
// 这里自己拼一个 TLS 1.2 ClientHello（只带 PSK 套件，与 idevice 一致）发过去，
// 读第一条记录就能判断：
//   ServerHello  → 监听确实是 TLS 1.2 PSK 端点，且接受这些套件
//   Alert        → 设备主动拒绝，并带出拒绝原因
//
// 注意：这会消费掉那个一次性监听，只能在准备放弃时调用。

import { connectTCP } from "./tcp";
import { BufferedReader, withTimeout } from "./stream";

/** iOS 的 remoted 优先 AES256-CBC-SHA384，AES128-CBC-SHA 兜底。 */
const PSK_CIPHER_SUITES = [
  [0x00, 0xaf],
  [0x00, 0x8c],
];

const ALERT_DESCRIPTIONS: Record<number, string> = {
  0: "close_notify",
  10: "unexpected_message",
  20: "bad_record_mac",
  40: "handshake_failure",
  47: "illegal_parameter",
  70: "protocol_version",
  71: "insufficient_security",
  80: "internal_error",
  109: "unknown_psk_identity",
  115: "unknown_psk_identity",
};

function buildClientHello(): Uint8Array {
  const random = crypto.getRandomValues(new Uint8Array(32));

  const body: number[] = [0x03, 0x03]; // TLS 1.2
  body.push(...random);
  body.push(0x00); // session_id 长度 0
  const suitesLength = PSK_CIPHER_SUITES.length * 2;
  body.push((suitesLength >> 8) & 0xff, suitesLength & 0xff);
  for (const suite of PSK_CIPHER_SUITES) body.push(...suite);
  body.push(0x01, 0x00); // 压缩方式：null

  // 握手消息头：类型 + 3 字节长度
  const handshake: number[] = [0x01, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff];
  handshake.push(...body);

  // 记录层：类型 + 版本 + 2 字节长度
  const record: number[] = [0x16, 0x03, 0x03, (handshake.length >> 8) & 0xff, handshake.length & 0xff];
  record.push(...handshake);

  return new Uint8Array(record);
}

export interface TlsProbeResult {
  outcome: "serverHello" | "alert" | "unexpected" | "closed" | "error";
  detail: string;
}

/** 对监听端口做一次 TLS 1.2 PSK ClientHello 探测。 */
export async function probeTlsPsk(host: string, port: number, timeoutMs = 5000): Promise<TlsProbeResult> {
  let stream;
  try {
    stream = await connectTCP(host, port, timeoutMs);
  } catch (error) {
    return { outcome: "error", detail: `连不上：${error instanceof Error ? error.message : String(error)}` };
  }

  try {
    await stream.write(buildClientHello());
    const reader = new BufferedReader(stream);
    const header = await withTimeout(reader.readExact(5), timeoutMs, "等待 TLS 响应超时");
    const contentType = header[0];
    const length = (header[3] << 8) | header[4];
    const payload = length > 0 ? await withTimeout(reader.readExact(length), timeoutMs, "读 TLS 记录超时") : new Uint8Array(0);

    if (contentType === 0x15) {
      const level = payload[0] ?? 0;
      const description = payload[1] ?? 0;
      return {
        outcome: "alert",
        detail: `TLS Alert level=${level} desc=${description}（${ALERT_DESCRIPTIONS[description] ?? "未知"}）`,
      };
    }

    if (contentType === 0x16 && payload[0] === 0x02) {
      // ServerHello：2 字节版本 + 32 字节随机数 + session_id + 2 字节选中套件
      const sessionIdLength = payload[4 + 2 + 32];
      const suiteOffset = 4 + 2 + 32 + 1 + sessionIdLength;
      const suite = ((payload[suiteOffset] << 8) | payload[suiteOffset + 1]).toString(16).padStart(4, "0");
      return { outcome: "serverHello", detail: `设备回了 ServerHello，选中套件 0x${suite}` };
    }

    return {
      outcome: "unexpected",
      detail: `记录类型 0x${contentType.toString(16)}，首字节 0x${(payload[0] ?? 0).toString(16)}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { outcome: detail.includes("关闭") ? "closed" : "error", detail };
  } finally {
    try {
      await stream.close();
    } catch {
      // 探针用完即弃。
    }
  }
}
