// 配对记录：解析、钥匙串存取。
//
// 记录由 wloc（iOS）在设备上自配对后生成，经「导出配对文件」得到
// .mobiledevicepairing（plist，字段 identifier / private_key / public_key / alt_irk）。
// 也可以由脚本自己配对（见 pair_setup.ts）：广播一个可配对主机，用 PIN 走 SRP。

import { fromBase64, fromHex, toHex } from "./bytes";
import { decodeBplist, isBplist, type PlistValue } from "./bplist";

export interface PairingRecord {
  /** 主机标识，pair-verify 的签名里要原样带上。 */
  identifier: string;
  /** Ed25519 私钥种子，32 字节。 */
  privateKey: Uint8Array;
  /** Ed25519 公钥，32 字节；仅用于界面核对。 */
  publicKey: Uint8Array;
  /** 设备身份解析密钥，用来校验 Bonjour 服务公告里的 authTag 是不是这台设备。 */
  altIrk: Uint8Array;
  /** 本机对外广播用的 IRK。和上面那个是两码事：一个认设备，一个认自己。 */
  hostAltIrk?: Uint8Array;
  deviceName: string;
  deviceUDID: string;
}

interface StoredRecord {
  identifier: string;
  privateKey: string;
  publicKey: string;
  altIrk: string;
  hostAltIrk?: string;
  deviceName: string;
  deviceUDID: string;
}

const KEYCHAIN_KEY = "wloc_pairing_record_v3";
/** 旧版脚本的记录（hex 字段、键名不同），读到后自动迁移。 */
const LEGACY_KEYCHAIN_KEY = "wloc_pairing_record_v2";

export function loadPairing(): PairingRecord | null {
  const current = readFrom(KEYCHAIN_KEY);
  if (current) return current;

  const legacy = readLegacy();
  if (legacy) {
    // 迁移失败就把私钥清零再抛——半截状态下留着明文私钥没有意义。
    try {
      savePairing(legacy);
      return legacy;
    } catch (error) {
      legacy.privateKey.fill(0);
      throw error;
    }
  }
  return null;
}

export function savePairing(record: PairingRecord): void {
  const stored: StoredRecord = {
    identifier: record.identifier,
    privateKey: toHex(record.privateKey),
    publicKey: toHex(record.publicKey),
    altIrk: toHex(record.altIrk),
    hostAltIrk: record.hostAltIrk ? toHex(record.hostAltIrk) : undefined,
    deviceName: record.deviceName,
    deviceUDID: record.deviceUDID,
  };
  // 返回值必须看：写钥匙串会失败（锁屏、权限变更），静默忽略的话用户以为配好了，
  // 下次启动才发现记录不在。
  if (!Keychain.set(KEYCHAIN_KEY, JSON.stringify(stored))) {
    throw new Error("无法保存配对记录，请检查钥匙串访问后重试");
  }
}

export function deletePairing(): void {
  Keychain.remove(KEYCHAIN_KEY);
  Keychain.remove(LEGACY_KEYCHAIN_KEY);
}

function readFrom(key: string): PairingRecord | null {
  try {
    const raw = Keychain.get(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredRecord;
    if (!stored.identifier || !stored.privateKey) return null;
    return {
      identifier: stored.identifier,
      privateKey: fromHex(stored.privateKey),
      publicKey: fromHex(stored.publicKey ?? ""),
      altIrk: fromHex(stored.altIrk ?? ""),
      hostAltIrk: stored.hostAltIrk ? fromHex(stored.hostAltIrk) : undefined,
      deviceName: stored.deviceName ?? "",
      deviceUDID: stored.deviceUDID ?? "",
    };
  } catch {
    return null;
  }
}

function readLegacy(): PairingRecord | null {
  try {
    const raw = Keychain.get(LEGACY_KEYCHAIN_KEY);
    if (!raw) return null;
    const legacy = JSON.parse(raw) as Record<string, string>;
    if (!legacy.identifier || !legacy.hostPrivateSeed) return null;
    return {
      identifier: legacy.identifier,
      privateKey: fromHex(legacy.hostPrivateSeed),
      publicKey: fromHex(legacy.hostPublicKey ?? ""),
      altIrk: new Uint8Array(0),
      deviceName: legacy.deviceName ?? "",
      deviceUDID: legacy.deviceUDID ?? "",
    };
  } catch {
    return null;
  }
}

// ── 解析导入的文件 ──────────────────────────────────────────────────────────

/** 私钥可能是裸种子，也可能带 PKCS#8/DER 外壳——末尾 32 字节即种子。 */
function seed32(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 32) return bytes;
  if (bytes.length > 32) return bytes.subarray(bytes.length - 32);
  throw new Error(`私钥只有 ${bytes.length} 字节，无法取出 32 字节种子`);
}

function asBytes(value: PlistValue | undefined): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0) return fromHex(text);
  try {
    return fromBase64(text);
  } catch {
    return null;
  }
}

function asString(value: PlistValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 从扁平 plist XML 里取出 key → 值。`<data>` 保持原文，交给 asBytes 解。 */
function parseXmlPlistDict(xml: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /<key>([\s\S]*?)<\/key>\s*<(string|data|integer|real)>([\s\S]*?)<\/\2>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    result[match[1].trim()] = match[3].trim();
  }
  return result;
}

function pick(dict: Record<string, PlistValue>, keys: string[]): PlistValue | undefined {
  for (const key of keys) {
    if (dict[key] !== undefined) return dict[key];
  }
  return undefined;
}

const IDENTIFIER_KEYS = ["identifier", "HostID", "hostId", "host_id"];
const PRIVATE_KEYS = ["private_key", "hostPrivateSeed", "HostPrivateKey", "privateKey"];
const PUBLIC_KEYS = ["public_key", "hostPublicKey", "HostPublicKey", "publicKey"];
const ALT_IRK_KEYS = ["alt_irk", "altIrk", "AltIRK"];
const NAME_KEYS = ["deviceName", "DeviceName", "device_name", "name"];
const UDID_KEYS = ["deviceUDID", "DeviceUDID", "UDID", "udid"];

function recordFromDict(dict: Record<string, PlistValue>): PairingRecord {
  const identifier = asString(pick(dict, IDENTIFIER_KEYS));
  if (!identifier) {
    throw new Error(`缺少 identifier 字段。文件里的字段：${Object.keys(dict).join("、") || "（空）"}`);
  }

  const privateKey = asBytes(pick(dict, PRIVATE_KEYS));
  if (!privateKey) throw new Error("缺少 private_key 字段，这不是有效的配对文件");

  return {
    identifier,
    privateKey: seed32(privateKey),
    publicKey: asBytes(pick(dict, PUBLIC_KEYS)) ?? new Uint8Array(0),
    altIrk: asBytes(pick(dict, ALT_IRK_KEYS)) ?? new Uint8Array(0),
    deviceName: asString(pick(dict, NAME_KEYS)),
    deviceUDID: asString(pick(dict, UDID_KEYS)),
  };
}

/**
 * 解析配对文件内容。支持二进制 plist、XML plist 与旧版 JSON。
 * 解析不出来时抛错，错误文案直接给用户看。
 */
export function parsePairingFile(bytes: Uint8Array): PairingRecord {
  if (isBplist(bytes)) {
    const { root } = decodeBplist(bytes);
    if (typeof root !== "object" || root === null || Array.isArray(root)) {
      throw new Error("二进制 plist 的顶层不是字典");
    }
    return recordFromDict(root as Record<string, PlistValue>);
  }

  const text = new TextDecoder().decode(bytes).trim();
  if (!text) throw new Error("文件内容为空");

  if (text.startsWith("{")) {
    const json = JSON.parse(text) as Record<string, PlistValue>;
    return recordFromDict(json);
  }

  if (text.includes("<plist") || text.includes("<dict>")) {
    const dict = parseXmlPlistDict(text);
    if (Object.keys(dict).length === 0) throw new Error("XML plist 里没有解析到任何字段");
    return recordFromDict(dict as Record<string, PlistValue>);
  }

  throw new Error(`无法识别的格式，文件开头：${text.slice(0, 60).replace(/\s+/g, " ")}`);
}
