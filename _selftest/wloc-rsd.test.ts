// 用假设备跑一遍隧道内的 RSD 握手（HTTP/2 + RemoteXPC）。
//
// 验证：客户端前言、SETTINGS/WINDOW_UPDATE/HEADERS/DATA 帧的字节布局、
// 流 1 与流 3 的分工、XPC 消息外壳的粘包切分，以及服务表解析
// （Port 是字符串、空字典消息要跳过）。
//
//   npx -y -p tsx tsx _selftest/wloc-rsd.test.ts

import { concat, fromUtf8, readU32LE, utf8 } from "../WLOC 虚拟定位/core/bytes";
import { discoverServices, dvtPort } from "../WLOC 虚拟定位/core/rsd";
import { BufferedReader, type ByteStream } from "../WLOC 虚拟定位/core/stream";
import { decodeXpcMessage, encodeXpcMessage, XpcFlag } from "../WLOC 虚拟定位/core/xpc";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function createPipe(): [ByteStream, ByteStream] {
  const queues: Uint8Array[][] = [[], []];
  const waiters: ((chunk: Uint8Array | null) => void)[][] = [[], []];

  function makeSide(readIndex: number, writeIndex: number): ByteStream {
    return {
      read(): Promise<Uint8Array | null> {
        const chunk = queues[readIndex].shift();
        if (chunk) return Promise.resolve(chunk);
        return new Promise((resolve) => waiters[readIndex].push(resolve));
      },
      write(data: Uint8Array): Promise<void> {
        const waiter = waiters[writeIndex].shift();
        if (waiter) waiter(data.slice());
        else queues[writeIndex].push(data.slice());
        return Promise.resolve();
      },
      close(): Promise<void> {
        for (const side of waiters) {
          while (side.length > 0) side.shift()!(null);
        }
        return Promise.resolve();
      },
    };
  }

  return [makeSide(0, 1), makeSide(1, 0)];
}

const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

interface SeenFrame {
  type: number;
  flags: number;
  streamId: number;
  body: Uint8Array;
}

/** 假 RSD 服务：读完客户端握手后，在流 1 回一条带 Services 的 XPC 消息。 */
async function fakeRsdDevice(stream: ByteStream, seen: SeenFrame[]): Promise<void> {
  const reader = new BufferedReader(stream);

  const preface = fromUtf8(await reader.readExact(PREFACE.length));
  if (preface !== PREFACE) throw new Error(`前言不对：${JSON.stringify(preface)}`);

  // 读到带非空字典的那条消息（即设备握手）为止
  let handshakeSeen = false;
  while (!handshakeSeen) {
    const header = await reader.readExact(9);
    const length = (header[0] << 16) | (header[1] << 8) | header[2];
    const frame: SeenFrame = {
      type: header[3],
      flags: header[4],
      streamId: ((header[5] << 24) | (header[6] << 16) | (header[7] << 8) | header[8]) & 0x7fffffff,
      body: length > 0 ? await reader.readExact(length) : new Uint8Array(0),
    };
    seen.push(frame);

    if (frame.type === 0x00 && frame.body.length > 0) {
      const decoded = decodeXpcMessage(frame.body);
      const body = decoded?.message.body as Record<string, unknown> | undefined;
      if (body && Object.keys(body).length > 0) handshakeSeen = true;
    }
  }

  // 先回一条空字典（真机也会发这种占位），客户端必须跳过它
  const empty = encodeXpcMessage(XpcFlag.AlwaysSet, 1, {});
  const services = encodeXpcMessage(XpcFlag.DataFlag | XpcFlag.AlwaysSet, 1, {
    Services: {
      "com.apple.instruments.dtservicehub": {
        Port: "52345",
        Entitlement: "com.apple.private.dt.instruments",
        Properties: { UsesRemoteXPC: true },
      },
      "com.apple.mobile.lockdown.remote.trusted": {
        Port: "52346",
        Entitlement: "com.apple.private.mobile.lockdown",
        Properties: {},
      },
    },
  });

  // 两条消息塞进同一个 DATA 帧，顺便验证粘包切分
  const payload = concat(empty, services);
  const dataFrame = new Uint8Array(9 + payload.length);
  dataFrame.set([
    (payload.length >> 16) & 0xff,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
  ]);
  dataFrame.set(payload, 9);
  await stream.write(dataFrame);
}

async function main(): Promise<void> {
  console.log("\n[RSD 握手端到端]");

  const [clientStream, deviceStream] = createPipe();
  const seen: SeenFrame[] = [];
  const deviceTask = fakeRsdDevice(deviceStream, seen);

  const services = await discoverServices(clientStream);
  await deviceTask;

  const settings = seen.find((frame) => frame.type === 0x04);
  check("发了 SETTINGS 帧", !!settings);
  check("SETTINGS 在流 0", settings?.streamId === 0);
  check("SETTINGS 带两项", settings?.body.length === 12, String(settings?.body.length));
  check(
    "MaxConcurrentStreams = 100",
    settings !== undefined &&
      ((settings.body[0] << 8) | settings.body[1]) === 0x03 &&
      ((settings.body[2] << 24) | (settings.body[3] << 16) | (settings.body[4] << 8) | settings.body[5]) === 100,
  );

  const windowUpdate = seen.find((frame) => frame.type === 0x08);
  check("发了 WINDOW_UPDATE", !!windowUpdate && windowUpdate.streamId === 0);
  check(
    "增量为 983041",
    windowUpdate !== undefined &&
      ((windowUpdate.body[0] << 24) |
        (windowUpdate.body[1] << 16) |
        (windowUpdate.body[2] << 8) |
        windowUpdate.body[3]) === 983041,
  );

  const headers = seen.filter((frame) => frame.type === 0x01);
  check("开了两条流（HEADERS）", headers.length === 2, String(headers.length));
  check("根流为 1、回复流为 3", headers[0]?.streamId === 1 && headers[1]?.streamId === 3);
  check("HEADERS 为空且带 END_HEADERS", headers.every((frame) => frame.body.length === 0 && frame.flags === 0x04));

  const dataFrames = seen.filter((frame) => frame.type === 0x00);
  check("回复流上发过 InitHandshake", dataFrames.some((frame) => frame.streamId === 3));
  const initFrame = dataFrames.find((frame) => frame.streamId === 3);
  check(
    "InitHandshake 标志位正确",
    initFrame !== undefined && (readU32LE(initFrame.body, 4) & XpcFlag.InitHandshake) !== 0,
    initFrame ? `0x${readU32LE(initFrame.body, 4).toString(16)}` : "",
  );
  check(
    "发过 0x201 那条怪消息",
    dataFrames.some((frame) => frame.streamId === 1 && frame.body.length >= 8 && readU32LE(frame.body, 4) === 0x201),
  );

  check("解析出两个服务", services.size === 2, String(services.size));
  check("dtservicehub 端口", dvtPort(services) === 52345, String(dvtPort(services)));
  check(
    "entitlement 一并解出",
    services.get("com.apple.instruments.dtservicehub")?.entitlement === "com.apple.private.dt.instruments",
  );
  check("UsesRemoteXPC 解出", services.get("com.apple.instruments.dtservicehub")?.usesRemoteXpc === true);

  // 没有 DVT 服务时要给出可读的报错
  let rejected = "";
  try {
    dvtPort(new Map([["com.apple.other", { port: 1, entitlement: "", usesRemoteXpc: false }]]));
  } catch (error) {
    rejected = error instanceof Error ? error.message : String(error);
  }
  check("缺 DVT 时报错提示开发者模式", rejected.includes("开发者模式"), rejected);

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
