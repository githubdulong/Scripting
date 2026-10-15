// 用一个按 idevice 协议实现的「假设备」跑完整的 RemotePairing 握手。
//
// 验证的是最容易写错的几处：RPPairing 帧头与 JSON 信封、pair-verify 的
// TLV 状态机、HKDF 的 salt/info 标签、ChaCha 的 nonce 布局、M3 签名的
// 内容顺序（clientPub ‖ identifier ‖ devicePub），以及加密请求的收发。
//
//   npx -y -p tsx tsx _selftest/wloc-pairverify.test.ts

import * as nodeCrypto from "node:crypto";

// crypto.chacha20Poly1305 是 Scripting 的扩展，Node 里用等价的 cipher 顶上。
const webcrypto = nodeCrypto.webcrypto as unknown as {
  subtle: SubtleCrypto;
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
  chacha20Poly1305?: unknown;
};
webcrypto.chacha20Poly1305 = {
  async encrypt(
    options: { key: ArrayBufferView | ArrayBuffer; nonce: ArrayBufferView | ArrayBuffer },
    data: ArrayBufferView | ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const cipher = nodeCrypto.createCipheriv(
      "chacha20-poly1305",
      toBuffer(options.key),
      toBuffer(options.nonce),
      { authTagLength: 16 },
    );
    const sealed = Buffer.concat([cipher.update(toBuffer(data)), cipher.final(), cipher.getAuthTag()]);
    return sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer;
  },
  async decrypt(
    options: { key: ArrayBufferView | ArrayBuffer; nonce: ArrayBufferView | ArrayBuffer },
    data: ArrayBufferView | ArrayBuffer,
  ): Promise<ArrayBuffer> {
    const payload = toBuffer(data);
    const decipher = nodeCrypto.createDecipheriv(
      "chacha20-poly1305",
      toBuffer(options.key),
      toBuffer(options.nonce),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(payload.subarray(-16));
    const opened = Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]);
    return opened.buffer.slice(opened.byteOffset, opened.byteOffset + opened.byteLength) as ArrayBuffer;
  },
};
// Node 里 globalThis.crypto 与 nodeCrypto.webcrypto 是同一个对象，
// 上面挂好扩展即可；真要换对象时再退回 defineProperty。
if ((globalThis as Record<string, unknown>).crypto !== webcrypto) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
}

function toBuffer(value: ArrayBufferView | ArrayBuffer): Buffer {
  return ArrayBuffer.isView(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : Buffer.from(value);
}

import { concat, fromBase64, fromUtf8, readU16BE, toBase64, u16be, u64le, utf8 } from "../WLOC 虚拟定位/core/bytes";
import { decodeTLV8, encodeTLV8, TLV8Type } from "../WLOC 虚拟定位/core/tlv8";
import { RemotePairingClient, RpPairingSocket } from "../WLOC 虚拟定位/core/rppairing";
import { BufferedReader, type ByteStream } from "../WLOC 虚拟定位/core/stream";
import type { PairingRecord } from "../WLOC 虚拟定位/core/pairing";

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

// ── 内存双工管道 ─────────────────────────────────────────────────────────

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

// ── 假设备：按 idevice 的 responder 行为回包 ──────────────────────────────

const FRAME_MAGIC = utf8("RPPairing");

class FakeDevice {
  private readonly reader: BufferedReader;
  private sequence = 0;
  private encryptedSequence = 0;
  private ephemeral: nodeCrypto.KeyObject | null = null;
  private sharedSecret: Buffer | null = null;
  private clientKey: Buffer | null = null;
  private serverKey: Buffer | null = null;

  /** 测试断言用的观测点 */
  signatureVerified = false;
  receivedIdentifier = "";
  createListenerKey = "";
  wireProtocolVersion = 0;
  originatedBy = "";

  constructor(
    private readonly stream: ByteStream,
    private readonly hostPublicKey: nodeCrypto.KeyObject,
  ) {
    this.reader = new BufferedReader(stream);
  }

  async run(steps: number): Promise<void> {
    for (let i = 0; i < steps; i++) await this.handleOne();
  }

  private async receiveFrame(): Promise<Record<string, any>> {
    const magic = await this.reader.readExact(FRAME_MAGIC.length);
    if (fromUtf8(magic) !== "RPPairing") throw new Error(`帧头不对：${fromUtf8(magic)}`);
    const length = readU16BE(await this.reader.readExact(2), 0);
    return JSON.parse(fromUtf8(await this.reader.readExact(length)));
  }

  private async sendPlain(value: unknown): Promise<void> {
    const body = utf8(
      JSON.stringify({
        message: { plain: { _0: value } },
        originatedBy: "device",
        sequenceNumber: this.sequence,
      }),
    );
    this.sequence += 1;
    await this.stream.write(concat(FRAME_MAGIC, u16be(body.length), body));
  }

  private async sendEncrypted(plaintext: Buffer, nonce: Buffer): Promise<void> {
    const cipher = nodeCrypto.createCipheriv("chacha20-poly1305", this.serverKey!, nonce, {
      authTagLength: 16,
    });
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const body = utf8(
      JSON.stringify({
        message: { streamEncrypted: { _0: sealed.toString("base64") } },
        originatedBy: "device",
        sequenceNumber: this.sequence,
      }),
    );
    this.sequence += 1;
    await this.stream.write(concat(FRAME_MAGIC, u16be(body.length), body));
  }

  private async handleOne(): Promise<void> {
    const frame = await this.receiveFrame();
    this.originatedBy = frame.originatedBy;

    const encrypted = frame.message?.streamEncrypted?._0;
    if (typeof encrypted === "string") {
      await this.handleEncrypted(Buffer.from(encrypted, "base64"));
      return;
    }

    const plain = frame.message?.plain?._0;

    if (plain?.request?._0?.handshake) {
      this.wireProtocolVersion = plain.request._0.handshake._0.wireProtocolVersion;
      // 与 iOS 27 真机的响应同形：只有协议版本与能力开关，没有设备名
      await this.sendPlain({
        response: {
          _1: {
            handshake: {
              _0: {
                wireProtocolVersion: 26,
                minimumSupportedWireProtocolVersion: 8,
                deviceOptions: {
                  allowsPinlessPairing: false,
                  allowsPairSetup: false,
                  allowsSharingSensitiveInfo: true,
                  allowsFreePairing: false,
                  allowsIncomingTunnelConnections: true,
                },
              },
            },
          },
        },
      });
      return;
    }

    const pairingData = plain?.event?._0?.pairingData?._0;
    if (pairingData) {
      await this.handlePairingData(pairingData);
      return;
    }

    throw new Error(`假设备收到看不懂的帧：${JSON.stringify(frame).slice(0, 120)}`);
  }

  private async handlePairingData(payload: Record<string, any>): Promise<void> {
    const tlv = decodeTLV8(fromBase64(payload.data));
    const state = tlv.get(TLV8Type.State)?.[0];

    if (state === 1) {
      // M2：回自己的临时公钥，并算出共享密钥
      const clientPublicKey = tlv.get(TLV8Type.PublicKey)!;
      this.ephemeral = nodeCrypto.generateKeyPairSync("x25519").privateKey;
      const devicePublicRaw = nodeCrypto
        .createPublicKey(this.ephemeral)
        .export({ type: "spki", format: "der" })
        .subarray(-32);

      this.sharedSecret = nodeCrypto.diffieHellman({
        privateKey: this.ephemeral,
        publicKey: nodeCrypto.createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b656e032100", "hex"),
            Buffer.from(clientPublicKey),
          ]),
          format: "der",
          type: "spki",
        }),
      });

      (this as { clientPublicKey?: Buffer }).clientPublicKey = Buffer.from(clientPublicKey);
      (this as { devicePublicKey?: Buffer }).devicePublicKey = Buffer.from(devicePublicRaw);

      await this.sendPlain({
        event: {
          _0: {
            pairingData: {
              _0: {
                data: toBase64(
                  encodeTLV8([
                    { type: TLV8Type.State, data: new Uint8Array([2]) },
                    { type: TLV8Type.PublicKey, data: new Uint8Array(devicePublicRaw) },
                  ]),
                ),
              },
            },
          },
        },
      });
      return;
    }

    if (state === 3) {
      // M3：解出主机签名并验证
      const sessionKey = hkdfSha512(
        this.sharedSecret!,
        Buffer.from("Pair-Verify-Encrypt-Salt"),
        Buffer.from("Pair-Verify-Encrypt-Info"),
        32,
      );
      const nonce = Buffer.alloc(12);
      Buffer.from("PV-Msg03").copy(nonce, 4);

      const sealed = tlv.get(TLV8Type.EncryptedData)!;
      const decipher = nodeCrypto.createDecipheriv("chacha20-poly1305", sessionKey, nonce, {
        authTagLength: 16,
      });
      decipher.setAuthTag(Buffer.from(sealed.subarray(sealed.length - 16)));
      const inner = Buffer.concat([
        decipher.update(Buffer.from(sealed.subarray(0, sealed.length - 16))),
        decipher.final(),
      ]);

      const innerTlv = decodeTLV8(new Uint8Array(inner));
      this.receivedIdentifier = fromUtf8(innerTlv.get(TLV8Type.Identifier)!);
      const signature = innerTlv.get(TLV8Type.Signature)!;

      // 签名内容必须是 clientPub ‖ identifier ‖ devicePub
      const signBuffer = Buffer.concat([
        (this as { clientPublicKey?: Buffer }).clientPublicKey!,
        Buffer.from(this.receivedIdentifier),
        (this as { devicePublicKey?: Buffer }).devicePublicKey!,
      ]);
      this.signatureVerified = nodeCrypto.verify(
        null,
        signBuffer,
        this.hostPublicKey,
        Buffer.from(signature),
      );

      this.clientKey = hkdfSha512(
        this.sharedSecret!,
        Buffer.alloc(0),
        Buffer.from("ClientEncrypt-main"),
        32,
      );
      this.serverKey = hkdfSha512(
        this.sharedSecret!,
        Buffer.alloc(0),
        Buffer.from("ServerEncrypt-main"),
        32,
      );

      await this.sendPlain({
        event: {
          _0: {
            pairingData: {
              _0: {
                data: toBase64(encodeTLV8([{ type: TLV8Type.State, data: new Uint8Array([4]) }])),
              },
            },
          },
        },
      });
      return;
    }

    throw new Error(`假设备收到意外的 pair-verify 状态：${state}`);
  }

  private async handleEncrypted(sealed: Buffer): Promise<void> {
    const nonce = Buffer.concat([Buffer.from(u64le(this.encryptedSequence)), Buffer.alloc(4)]);
    const decipher = nodeCrypto.createDecipheriv("chacha20-poly1305", this.clientKey!, nonce, {
      authTagLength: 16,
    });
    decipher.setAuthTag(sealed.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    const request = JSON.parse(plaintext.toString());

    const createListener = request?.request?._0?.createListener;
    if (!createListener) throw new Error(`假设备收到意外的加密请求：${plaintext.toString().slice(0, 120)}`);
    this.createListenerKey = createListener.key;

    await this.sendEncrypted(
      Buffer.from(
        JSON.stringify({
          response: { _1: { createListener: { port: 54321 } } },
        }),
      ),
      nonce,
    );
    this.encryptedSequence += 1;
  }

  get secret(): Buffer {
    return this.sharedSecret!;
  }
}

function hkdfSha512(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = nodeCrypto.createHmac("sha512", salt).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let counter = 1; Buffer.concat(blocks).length < length; counter++) {
    previous = nodeCrypto
      .createHmac("sha512", prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

// ── 跑完整流程 ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n[pair-verify 端到端]");

  const hostKeys = nodeCrypto.generateKeyPairSync("ed25519");
  const seed = hostKeys.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const hostPublicRaw = hostKeys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);

  const record: PairingRecord = {
    identifier: "wloc-7F3A1C2D",
    privateKey: new Uint8Array(seed),
    publicKey: new Uint8Array(hostPublicRaw),
    altIrk: new Uint8Array(0),
    deviceName: "",
    deviceUDID: "",
  };

  const [clientStream, deviceStream] = createPipe();
  const device = new FakeDevice(deviceStream, hostKeys.publicKey);
  const client = new RemotePairingClient(new RpPairingSocket(clientStream));

  // 设备侧在后台按序应答：握手、M2、M4、createListener 共 4 个来回
  const deviceTask = device.run(4);

  const peer = await client.attemptPairVerify();
  check("握手读出设备协议版本", peer.wireProtocolVersion === 26, String(peer.wireProtocolVersion));
  check("握手读出最低协议版本", peer.minimumWireProtocolVersion === 8, String(peer.minimumWireProtocolVersion));
  check("握手读出隧道开关", peer.allowsIncomingTunnelConnections === true);
  check("wireProtocolVersion 为 19", device.wireProtocolVersion === 19, String(device.wireProtocolVersion));
  check("originatedBy 为 host", device.originatedBy === "host", device.originatedBy);

  await client.validatePairing(record);
  check("设备验签通过（签名内容顺序正确）", device.signatureVerified);
  check("identifier 原样送达", device.receivedIdentifier === record.identifier, device.receivedIdentifier);
  check(
    "PSK = X25519 共享密钥",
    Buffer.from(client.preSharedKey).equals(device.secret),
    Buffer.from(client.preSharedKey).toString("hex").slice(0, 16),
  );

  const port = await client.createTcpListener();
  check("取回隧道端口", port === 54321, String(port));
  check(
    "createListener 带上了 PSK",
    device.createListenerKey === Buffer.from(client.preSharedKey).toString("base64"),
  );

  await deviceTask;

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
