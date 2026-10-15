// WLOC 引擎的纯编码层自测（在 Node 里跑，不碰 Scripting 的原生 API）。
//   npx -y -p tsx tsx _selftest/wloc-engine.test.ts

import * as nodeCrypto from "node:crypto";

import { concat, fromBase64, toBase64, toHex, u64le, utf8 } from "../WLOC 虚拟定位/core/bytes";
import { decodeBplist, encodeBplist, isBplist, PReal, PUid } from "../WLOC 虚拟定位/core/bplist";
import { archive, archiveDouble, archiveString, describeArchivedError, unarchive } from "../WLOC 虚拟定位/core/keyed_archive";
import { decodeTLV8, encodeTLV8, hasError, TLV8Type } from "../WLOC 虚拟定位/core/tlv8";
import { decodeXpcMessage, encodeXpcMessage, encodeXpcObject, decodeXpcObject, XpcFlag, XpcUInt64, XpcUuid } from "../WLOC 虚拟定位/core/xpc";
import { archivedArg, DtxConnection, u32Arg } from "../WLOC 虚拟定位/core/dtx";
import {
  exportPairingAsBinary,
  exportPairingAsJson,
  exportPairingAsXml,
  parsePairingFile,
} from "../WLOC 虚拟定位/core/pairing";
import type { ByteStream } from "../WLOC 虚拟定位/core/stream";

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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 收集写入的字节，并可把预置字节当作可读流喂回去。 */
class MemoryStream implements ByteStream {
  written: Uint8Array = new Uint8Array(0);
  private incoming: Uint8Array;

  constructor(incoming: Uint8Array = new Uint8Array(0)) {
    this.incoming = incoming;
  }

  async read(max: number): Promise<Uint8Array | null> {
    if (this.incoming.length === 0) return null;
    const chunk = this.incoming.subarray(0, max);
    this.incoming = this.incoming.subarray(chunk.length);
    return chunk;
  }

  async write(data: Uint8Array): Promise<void> {
    this.written = concat(this.written, data);
  }

  async close(): Promise<void> {}
}

async function main(): Promise<void> {
// ── bytes ────────────────────────────────────────────────────────────────
console.log("\n[bytes]");
{
  const sample = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
  check("base64 往返", equalBytes(fromBase64(toBase64(sample)), sample));
  check("hex 编码", toHex(sample) === "0001feff", toHex(sample));
  check("u64le 小端", toHex(u64le(1)) === "0100000000000000", toHex(u64le(1)));
}

// ── bplist ───────────────────────────────────────────────────────────────
console.log("\n[bplist]");
{
  const value = {
    str: "hello",
    unicode: "中文",
    int: 100000,
    real: new PReal(37.3317),
    bool: true,
    data: new Uint8Array([1, 2, 3]),
    list: ["a", 2, new PReal(0.5)],
    nested: { uid: new PUid(1) },
  };
  const encoded = encodeBplist(value);
  check("写出 bplist00 头", isBplist(encoded));

  const { root } = decodeBplist(encoded);
  const decoded = root as Record<string, any>;
  check("字符串往返", decoded.str === "hello");
  check("UTF-16 往返", decoded.unicode === "中文", String(decoded.unicode));
  check("整数往返", decoded.int === 100000);
  check("浮点往返", Math.abs(decoded.real.value - 37.3317) < 1e-9);
  check("布尔往返", decoded.bool === true);
  check("data 往返", equalBytes(decoded.data, new Uint8Array([1, 2, 3])));
  check("数组往返", decoded.list[0] === "a" && decoded.list[1] === 2);
  check("UID 往返", decoded.nested.uid instanceof PUid && decoded.nested.uid.value === 1);

  // 长字符串要走 0xF 长度前缀分支
  const long = "x".repeat(300);
  const longDecoded = decodeBplist(encodeBplist({ long })).root as Record<string, any>;
  check("长字符串（>15）", longDecoded.long === long);
}

// ── NSKeyedArchiver ──────────────────────────────────────────────────────
console.log("\n[NSKeyedArchiver]");
{
  const encoded = archiveDouble(37.331706);
  const parsed = decodeBplist(encoded).root as Record<string, any>;
  check("$archiver 正确", parsed.$archiver === "NSKeyedArchiver", String(parsed.$archiver));
  check("$version 为 100000", parsed.$version === 100000, String(parsed.$version));
  check("$objects[0] 是 $null", parsed.$objects[0] === "$null");
  check("$objects[1] 是实数", parsed.$objects[1] instanceof PReal);
  check("$top.root 指向 1", parsed.$top.root instanceof PUid && parsed.$top.root.value === 1);

  check("解档回原值", Math.abs((unarchive(encoded) as number) - 37.331706) < 1e-9);
  check("字符串解档", unarchive(archiveString("simulateLocation")) === "simulateLocation");

  // 仿一个 NSError 归档，验证能捞出描述
  const errorArchive = encodeBplist({
    $version: 100000,
    $archiver: "NSKeyedArchiver",
    $top: { root: new PUid(1) },
    $objects: [
      "$null",
      { NSLocalizedDescription: new PUid(2), $class: new PUid(3) },
      "Location simulation is not available",
      { $classname: "NSError" },
    ],
  });
  check(
    "NSError 描述可读出",
    describeArchivedError(unarchive(errorArchive)) === "Location simulation is not available",
    String(describeArchivedError(unarchive(errorArchive))),
  );

  // NSError 把文案放在 NSUserInfo 里是更常见的形态
  const nestedError = encodeBplist({
    $version: 100000,
    $archiver: "NSKeyedArchiver",
    $top: { root: new PUid(1) },
    $objects: [
      "$null",
      { NSCode: 1, NSDomain: new PUid(2), NSUserInfo: new PUid(3), $class: new PUid(5) },
      "DTXErrorDomain",
      { NSLocalizedDescription: new PUid(4) },
      "服务不可用",
      { $classname: "NSError" },
    ],
  });
  check(
    "NSUserInfo 里的描述也能读出",
    describeArchivedError(unarchive(nestedError)) === "服务不可用",
    String(describeArchivedError(unarchive(nestedError))),
  );

  // 正常回包里的字符串不能被当成错误
  check("普通字符串负载不算错误", describeArchivedError(unarchive(archiveString("ok"))) === "ok");
  check("数字负载不算错误", describeArchivedError(unarchive(archiveDouble(1.5))) === null);
  check(
    "普通字典不算错误",
    describeArchivedError({ capabilities: { "com.apple.instruments": 1 } }) === null,
  );
}

// ── TLV8 ─────────────────────────────────────────────────────────────────
console.log("\n[TLV8]");
{
  const publicKey = nodeCrypto.randomBytes(32);
  const encoded = encodeTLV8([
    { type: TLV8Type.State, data: new Uint8Array([1]) },
    { type: TLV8Type.PublicKey, data: new Uint8Array(publicKey) },
  ]);
  check("M1 长度 = 2+1 + 2+32", encoded.length === 37, String(encoded.length));
  check("首字节是 State 类型", encoded[0] === 0x06 && encoded[1] === 1);

  const decoded = decodeTLV8(encoded);
  check("解出 PublicKey", equalBytes(decoded.get(TLV8Type.PublicKey)!, new Uint8Array(publicKey)));
  check("无错误项", !hasError(decoded));

  // 超过 255 字节必须分片，解码时再拼回
  const big = new Uint8Array(600).map((_, index) => index & 0xff);
  const fragmented = encodeTLV8([{ type: TLV8Type.EncryptedData, data: big }]);
  check("分片数 = 3", fragmented.length === 600 + 3 * 2, String(fragmented.length));
  check("分片合并还原", equalBytes(decodeTLV8(fragmented).get(TLV8Type.EncryptedData)!, big));

  const errorTlv = decodeTLV8(encodeTLV8([{ type: TLV8Type.ErrorResponse, data: new Uint8Array([2]) }]));
  check("识别错误项", hasError(errorTlv));
}

// ── XPC ──────────────────────────────────────────────────────────────────
console.log("\n[XPC]");
{
  const handshake = {
    MessageType: "Handshake",
    MessagingProtocolVersion: new XpcUInt64(7n),
    UUID: XpcUuid.random(),
    Properties: {
      RemoteXPCVersionFlags: new XpcUInt64(BigInt("0x0100000000000006")),
      SensitivePropertiesVisible: true,
    },
    Services: {},
  };

  const object = encodeXpcObject(handshake);
  // 魔数按小端写出，所以字节序是 42 37 13 42。
  check("对象魔数 0x42133742", toHex(object.subarray(0, 4)) === "42371342", toHex(object.subarray(0, 4)));
  check("对象版本 5", toHex(object.subarray(4, 8)) === "05000000");

  const decoded = decodeXpcObject(object) as Record<string, any>;
  check("MessageType 往返", decoded.MessageType === "Handshake");
  check("u64 往返", decoded.MessagingProtocolVersion === 7);
  check(
    "大 u64 不丢精度",
    decoded.Properties.RemoteXPCVersionFlags === BigInt("0x0100000000000006"),
    String(decoded.Properties.RemoteXPCVersionFlags),
  );
  check("布尔往返", decoded.Properties.SensitivePropertiesVisible === true);
  check("空字典往返", Object.keys(decoded.Services).length === 0);

  const message = encodeXpcMessage(XpcFlag.DataFlag | XpcFlag.AlwaysSet, 1, handshake);
  check("消息魔数 0x29b00b92", toHex(message.subarray(0, 4)) === "920bb029", toHex(message.subarray(0, 4)));
  const parsed = decodeXpcMessage(message);
  check("消息可解析", !!parsed && parsed.consumed === message.length);
  check("flags 保留", parsed!.message.flags === (XpcFlag.DataFlag | XpcFlag.AlwaysSet));

  check("数据不足返回 null", decodeXpcMessage(message.subarray(0, 20)) === null);
  check("半条消息返回 null", decodeXpcMessage(message.subarray(0, message.length - 4)) === null);

  // 服务表解析走的就是这条路
  const services = decodeXpcObject(
    encodeXpcObject({
      Services: {
        "com.apple.instruments.dtservicehub": {
          Port: "52345",
          Entitlement: "com.apple.private.dt.instruments",
          Properties: { UsesRemoteXPC: true },
        },
      },
    }),
  ) as Record<string, any>;
  check(
    "服务端口是字符串",
    services.Services["com.apple.instruments.dtservicehub"].Port === "52345",
  );
}

// ── DTX ──────────────────────────────────────────────────────────────────
console.log("\n[DTX]");
{
  const outbound = new MemoryStream();
  const dtx = new DtxConnection(outbound);
  await dtx.callMethod(
    1,
    "simulateLocationWithLatitude:longitude:",
    [archivedArg(archiveDouble(37.331706)), archivedArg(archiveDouble(-122.030237))],
    true,
  );

  const frame = outbound.written;
  const view = new DataView(frame.buffer, frame.byteOffset);
  check("消息魔数 0x1F3D5B79", view.getUint32(0, true) === 0x1f3d5b79);
  check("header_len 恒为 32", view.getUint32(4, true) === 32, String(view.getUint32(4, true)));
  check("fragmentCount 为 1", view.getUint16(10, true) === 1);

  const bodyLength = view.getUint32(12, true);
  check("length = 帧长 - 32", bodyLength === frame.length - 32, `${bodyLength} vs ${frame.length - 32}`);
  check("identifier 从 1 开始", view.getUint32(16, true) === 1);
  check("channel 为 1", view.getInt32(24, true) === 1);
  check("expectsReply 为 1", view.getUint32(28, true) === 1);

  const auxLength = view.getUint32(32 + 4, true);
  const totalLength = view.getUint32(32 + 8, true);
  check("msg_type 为 2（方法调用）", frame[32] === 2, String(frame[32]));
  check("total = aux + data", totalLength === bodyLength - 16, `${totalLength} vs ${bodyLength - 16}`);

  const aux = frame.subarray(48, 48 + auxLength);
  const auxView = new DataView(aux.buffer, aux.byteOffset);
  check("aux buffer_size 496", auxView.getUint32(0, true) === 496);
  check("aux_size = 内容长度", auxView.getUint32(8, true) === auxLength - 16);
  check("首个参数前有 PNULL", auxView.getUint32(16, true) === 0x0a);
  check("参数类型为 0x02（归档对象）", auxView.getUint32(20, true) === 0x02);

  // 方法名必须是归档后的 plist，不能是裸字符串
  const data = frame.subarray(48 + auxLength);
  check("负载是 bplist", isBplist(data));
  check("负载解档出方法名", unarchive(data) === "simulateLocationWithLatitude:longitude:");

  // 把自己发出去的帧当成回包读回来，验证解析路径
  const loopback = new DtxConnection(new MemoryStream(frame));
  const message = await loopback.readMessage();
  check("回读 identifier", message.identifier === 1);
  check("回读方法名", message.payload === "simulateLocationWithLatitude:longitude:");

  // 参数里的经纬度能原样取出
  const firstArgOffset = 48 + 16 + 4 + 4 + 4; // aux 头 + PNULL + type + 长度
  const firstArgLength = auxView.getUint32(24, true);
  const archivedLat = frame.subarray(firstArgOffset, firstArgOffset + firstArgLength);
  check("参数归档值可还原", Math.abs((unarchive(archivedLat) as number) - 37.331706) < 1e-9);

  // 频道申请
  const channelStream = new MemoryStream();
  const channelDtx = new DtxConnection(channelStream);
  await channelDtx.callMethod(0, "_requestChannelWithCode:identifier:", [
    u32Arg(1),
    archivedArg(archiveString("com.apple.instruments.server.services.LocationSimulation")),
  ]);
  const channelFrame = channelStream.written;
  const channelView = new DataView(channelFrame.buffer, channelFrame.byteOffset);
  check("频道申请发在 0 号频道", channelView.getInt32(24, true) === 0);
  const channelAux = channelFrame.subarray(48, 48 + channelView.getUint32(36, true));
  const channelAuxView = new DataView(channelAux.buffer, channelAux.byteOffset);
  check("第一个参数是 u32 类型", channelAuxView.getUint32(20, true) === 0x03);
  check("频道号为 1", channelAuxView.getUint32(24, true) === 1);
}

// ── 配对文件解析 ─────────────────────────────────────────────────────────
console.log("\n[配对文件]");
{
  const privateKey = nodeCrypto.randomBytes(32);
  const publicKey = nodeCrypto.randomBytes(32);
  const altIrk = nodeCrypto.randomBytes(16);

  // wloc 导出的就是这种 XML plist
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>public_key</key>
  <data>${publicKey.toString("base64")}</data>
  <key>private_key</key>
  <data>${privateKey.toString("base64")}</data>
  <key>identifier</key>
  <string>wloc-7F3A1C</string>
  <key>alt_irk</key>
  <data>${altIrk.toString("base64")}</data>
</dict>
</plist>`;
  const fromXml = parsePairingFile(utf8(xml));
  check("XML plist：identifier", fromXml.identifier === "wloc-7F3A1C", fromXml.identifier);
  check("XML plist：私钥 32 字节", equalBytes(fromXml.privateKey, new Uint8Array(privateKey)));
  check("XML plist：alt_irk", equalBytes(fromXml.altIrk, new Uint8Array(altIrk)));

  // 二进制 plist 同样要能读（wloc 若改用 bplist 导出也不至于读不了）
  const binary = encodeBplist({
    public_key: new Uint8Array(publicKey),
    private_key: new Uint8Array(privateKey),
    identifier: "wloc-7F3A1C",
    alt_irk: new Uint8Array(altIrk),
  });
  const fromBinary = parsePairingFile(binary);
  check("二进制 plist：私钥一致", equalBytes(fromBinary.privateKey, new Uint8Array(privateKey)));

  // 旧版脚本的 JSON（hex 字段）
  const legacy = JSON.stringify({
    identifier: "wloc-legacy",
    hostPrivateSeed: privateKey.toString("hex"),
    hostPublicKey: publicKey.toString("hex"),
  });
  const fromJson = parsePairingFile(utf8(legacy));
  check("旧版 JSON：私钥一致", equalBytes(fromJson.privateKey, new Uint8Array(privateKey)));

  // PKCS#8 外壳要能剥掉
  const wrapped = concat(
    new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
    new Uint8Array(privateKey),
  );
  const fromWrapped = parsePairingFile(
    utf8(JSON.stringify({ identifier: "x", private_key: Buffer.from(wrapped).toString("base64") })),
  );
  check("PKCS#8 外壳剥离", equalBytes(fromWrapped.privateKey, new Uint8Array(privateKey)));

  let rejected = false;
  try {
    parsePairingFile(utf8("not a pairing file"));
  } catch {
    rejected = true;
  }
  check("垃圾输入会报错", rejected);
}

// ── 配对握手用到的密码学 ─────────────────────────────────────────────────
console.log("\n[crypto]");
{
  const subtle = nodeCrypto.webcrypto.subtle;

  // HKDF-SHA512：与手写 RFC 5869 实现对比
  async function referenceHkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Promise<Buffer> {
    const prk = nodeCrypto.createHmac("sha512", salt).update(ikm).digest();
    let previous = Buffer.alloc(0);
    const blocks: Buffer[] = [];
    for (let counter = 1; Buffer.concat(blocks).length < length; counter++) {
      previous = nodeCrypto
        .createHmac("sha512", prk)
        .update(Buffer.concat([previous, info, Buffer.from([counter])]))
        .digest();
      blocks.push(previous);
    }
    return Buffer.concat(blocks).subarray(0, length);
  }

  const ikm = nodeCrypto.randomBytes(32);
  const info = Buffer.from("ClientEncrypt-main");
  const material = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const derived = Buffer.from(
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-512", salt: new Uint8Array(0), info } as any,
      material,
      256,
    ),
  );
  const expectedZeroSalt = await referenceHkdf(ikm, Buffer.alloc(64), info, 32);
  check("空 salt 等价于全零 salt", derived.equals(expectedZeroSalt), derived.toString("hex"));

  // pair-verify 的固定 nonce 布局
  const pvNonce = Buffer.alloc(12);
  Buffer.from("PV-Msg03").copy(pvNonce, 4);
  check("PV-Msg03 nonce", pvNonce.toString("hex") === "0000000050562d4d73673033", pvNonce.toString("hex"));

  // 流加密 nonce：8 字节小端序号 + 4 个零
  const streamNonce = Buffer.concat([Buffer.from(u64le(0)), Buffer.alloc(4)]);
  check("流加密 nonce 全零（序号 0）", streamNonce.toString("hex") === "0".repeat(24));
  const streamNonce1 = Buffer.concat([Buffer.from(u64le(1)), Buffer.alloc(4)]);
  check("流加密 nonce 序号 1", streamNonce1.toString("hex") === "010000000000000000000000");

  // ChaCha20-Poly1305：Scripting 扩展与 node 的实现等价（密文后跟 16 字节标签）
  const key = nodeCrypto.randomBytes(32);
  const nonce = nodeCrypto.randomBytes(12);
  const plaintext = Buffer.from(JSON.stringify({ request: { _0: { createListener: {} } } }));
  const cipher = nodeCrypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  check("密文长度 = 明文 + 16", sealed.length === plaintext.length + 16);

  const decipher = nodeCrypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  decipher.setAuthTag(sealed.subarray(-16));
  const opened = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  check("解密还原", opened.equals(plaintext));

  // Ed25519：32 字节种子套 PKCS#8 后可签可验
  const seed = nodeCrypto.randomBytes(32);
  const pkcs8 = Buffer.concat([
    Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]),
    seed,
  ]);
  const signKey = await subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
  const signBuffer = Buffer.concat([nodeCrypto.randomBytes(32), Buffer.from("wloc-7F3A1C"), nodeCrypto.randomBytes(32)]);
  const signature = Buffer.from(await subtle.sign("Ed25519", signKey, signBuffer));
  check("Ed25519 签名 64 字节", signature.length === 64, String(signature.length));

  // 用 node 从同一种子导出公钥验签，证明 PKCS#8 外壳拼对了
  const nodeKey = nodeCrypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const nodePublic = nodeCrypto.createPublicKey(nodeKey);
  check(
    "PKCS#8 外壳正确（验签通过）",
    nodeCrypto.verify(null, signBuffer, nodePublic, signature),
  );

  // X25519 协商：两端得到同一个共享密钥，长度 32（即隧道 PSK）
  const alice = await subtle.generateKey("X25519", false, ["deriveBits"]);
  const bob = await subtle.generateKey("X25519", false, ["deriveBits"]);
  const ab = Buffer.from(
    await subtle.deriveBits({ name: "X25519", public: (bob as nodeCrypto.webcrypto.CryptoKeyPair).publicKey } as any, (alice as nodeCrypto.webcrypto.CryptoKeyPair).privateKey, 256),
  );
  const ba = Buffer.from(
    await subtle.deriveBits({ name: "X25519", public: (alice as nodeCrypto.webcrypto.CryptoKeyPair).publicKey } as any, (bob as nodeCrypto.webcrypto.CryptoKeyPair).privateKey, 256),
  );
  check("X25519 共享密钥一致且为 32 字节", ab.equals(ba) && ab.length === 32);
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

// ── 配对记录导出 ─────────────────────────────────────────────────────────
//
// 导出的三种格式必须都能被 parsePairingFile 读回来，否则「导出给另一台设备」
// 这件事就是坏的，而且坏在用户最不容易发现的地方。
console.log("\n[配对记录导出]");
{
  const record = {
    identifier: "wloc-7F3A1C",
    privateKey: new Uint8Array(nodeCrypto.randomBytes(32)),
    publicKey: new Uint8Array(nodeCrypto.randomBytes(32)),
    altIrk: new Uint8Array(nodeCrypto.randomBytes(16)),
    deviceName: "测试 iPhone",
    deviceUDID: "00008120-000111223344002E",
  };

  for (const [name, bytes] of [
    ["XML plist", utf8(exportPairingAsXml(record))],
    ["二进制 plist", exportPairingAsBinary(record)],
    ["JSON", utf8(exportPairingAsJson(record))],
  ] as const) {
    const back = parsePairingFile(bytes);
    check(`${name}：identifier`, back.identifier === record.identifier, back.identifier);
    check(`${name}：私钥一致`, equalBytes(back.privateKey, record.privateKey));
    check(`${name}：公钥一致`, equalBytes(back.publicKey, record.publicKey));
    check(`${name}：alt_irk 一致`, equalBytes(back.altIrk, record.altIrk));
  }

  // 含 XML 元字符的设备名不能把文档弄坏
  const tricky = { ...record, deviceName: "A<B>C&D" };
  const backTricky = parsePairingFile(utf8(exportPairingAsXml(tricky)));
  check("XML plist：设备名里的 < > & 已转义", backTricky.deviceName === "A<B>C&D", backTricky.deviceName);

  // 没有 alt_irk 的记录也要能往返
  const noIrk = { ...record, altIrk: new Uint8Array(0), publicKey: new Uint8Array(0) };
  const backNoIrk = parsePairingFile(exportPairingAsBinary(noIrk));
  check("二进制 plist：缺 alt_irk 也能读回", backNoIrk.identifier === record.identifier);
}
