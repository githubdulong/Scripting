// RSD（Remote Service Discovery）：在隧道内用 RemoteXPC 问设备要服务表。
//
// 握手照抄 idevice 的 RemoteXpcClient：根流 1、回复流 3，
// 先互发几个空消息，再发设备握手字典，然后在根流上读回 Services。
// 返回的 Port 是字符串，别当数字读。

import { Http2Client, Setting } from "./http2";
import type { ByteStream } from "./stream";
import {
  decodeXpcMessage,
  encodeXpcMessage,
  XpcFlag,
  XpcUInt64,
  XpcUuid,
  type XpcValue,
} from "./xpc";

const ROOT_CHANNEL = 1;
const REPLY_CHANNEL = 3;
const ROOT_MESSAGE_ID = 1;
/** idevice 里的 REMOTE_XPC_VERSION_FLAGS。 */
const REMOTE_XPC_VERSION_FLAGS = BigInt("0x0100000000000006");

export interface RsdService {
  port: number;
  entitlement: string;
  usesRemoteXpc: boolean;
}

export type RsdServices = Map<string, RsdService>;

/** 按 XPC 消息边界切分根流上的字节。 */
class XpcChannelReader {
  private buffer = new Uint8Array(0);

  constructor(
    private readonly client: Http2Client,
    private readonly streamId: number,
  ) {}

  private append(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;
  }

  /** 读到第一条带非空字典的消息为止——空字典是对端的心跳/占位。 */
  async receiveBody(): Promise<unknown> {
    for (;;) {
      const decoded = this.buffer.length > 0 ? decodeXpcMessage(this.buffer) : null;
      if (decoded) {
        this.buffer = this.buffer.subarray(decoded.consumed);
        const body = decoded.message.body;
        if (body !== undefined && !(isEmptyDict(body))) return body;
        continue;
      }
      this.append(await this.client.readData(this.streamId));
    }
  }
}

function isEmptyDict(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

/** 建立 RemoteXPC 会话并取回服务表。 */
export async function discoverServices(stream: ByteStream): Promise<RsdServices> {
  const client = await Http2Client.create(stream);
  const root = new XpcChannelReader(client, ROOT_CHANNEL);

  await client.sendSettings([
    [Setting.MaxConcurrentStreams, 100],
    [Setting.InitialWindowSize, 1048576],
  ]);
  await client.sendWindowUpdate(983041, 0);

  await client.openStream(ROOT_CHANNEL);
  await client.sendData(encodeXpcMessage(XpcFlag.AlwaysSet, ROOT_MESSAGE_ID, {}), ROOT_CHANNEL);

  await client.openStream(REPLY_CHANNEL);
  await client.sendData(
    encodeXpcMessage(XpcFlag.InitHandshake | XpcFlag.AlwaysSet, ROOT_MESSAGE_ID),
    REPLY_CHANNEL,
  );

  await client.sendData(encodeXpcMessage(0x201, ROOT_MESSAGE_ID), ROOT_CHANNEL);

  const handshake: XpcValue = {
    MessageType: "Handshake",
    MessagingProtocolVersion: new XpcUInt64(BigInt(7)),
    UUID: XpcUuid.random(),
    Properties: {
      RemoteXPCVersionFlags: new XpcUInt64(REMOTE_XPC_VERSION_FLAGS),
      SensitivePropertiesVisible: true,
    },
    Services: {},
  };
  await client.sendData(
    encodeXpcMessage(XpcFlag.DataFlag | XpcFlag.AlwaysSet, ROOT_MESSAGE_ID, handshake),
    ROOT_CHANNEL,
  );

  const body = await root.receiveBody();
  const services = (body as Record<string, unknown> | null)?.["Services"];
  if (!services || typeof services !== "object") {
    throw new Error("设备没有返回服务列表");
  }

  const result: RsdServices = new Map();
  for (const [name, entry] of Object.entries(services as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const info = entry as Record<string, unknown>;
    const port = Number(info.Port);
    if (!Number.isFinite(port) || port <= 0) continue;
    const properties = (info.Properties as Record<string, unknown> | undefined) ?? {};
    result.set(name, {
      port,
      entitlement: String(info.Entitlement ?? ""),
      usesRemoteXpc: properties.UsesRemoteXPC === true,
    });
  }

  if (result.size === 0) throw new Error("服务列表为空");
  return result;
}

/** DVT（Instruments）服务的端口。 */
export function dvtPort(services: RsdServices): number {
  const service = services.get("com.apple.instruments.dtservicehub");
  if (!service) {
    throw new Error(
      `设备未提供 Instruments 服务，请确认已开启开发者模式。已公布的服务：${[...services.keys()].length} 个`,
    );
  }
  return service.port;
}
