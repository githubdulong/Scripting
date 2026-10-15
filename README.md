# Scripting

[Scripting](https://apps.apple.com/app/id6479691128) 应用上的脚本。

脚本目录直接放仓库根，发布产物在 `dist/`。

## WLOC 虚拟定位 2.0.0

用苹果官方的开发者接口模拟本机定位，与 Xcode 的 Simulate Location 走同一套机制，不涉及证书、代理改写或系统文件。

```
本机配对（RemotePairing）→ 回环隧道 → TLS-PSK 加密隧道 → RSD 查服务 → DVT 下发坐标
```

### 这一版做了什么

协议层按 [wloc for iOS](https://github.com/ios151/wloc) / [idevice](https://github.com/jkcoxson/idevice) 完全重写，去掉了 1.x 的证书代理那一套。纯 TypeScript 实现：

| 模块 | 内容 |
|---|---|
| `core/bplist.ts` | 二进制 plist 读写 |
| `core/keyed_archive.ts` | NSKeyedArchiver 编解码 |
| `core/crypto_utils.ts` | HKDF-SHA512、X25519、Ed25519、ChaCha20-Poly1305 |
| `core/rppairing.ts` | RemotePairing 握手、pair-verify M1–M4、隧道监听 |
| `core/xpc.ts` `core/http2.ts` `core/rsd.ts` | RemoteXPC 服务发现 |
| `core/dtx.ts` | DTX 消息帧与方法调用 |
| `core/location.ts` `core/session.ts` | 位置下发与会话管理 |
| `core/movement.ts` `core/geo.ts` `core/gpx.ts` | 移动模拟：球面几何、路径推进、GPX |

界面：Apple MapKit 原生地图（标准 / 卫星 / 混合、3D 地形、路况）、全球搜索、收藏与历史、四种移动方式各三档速度加自定义、多方案路线、手绘路径、摇杆、锁屏与灵动岛实时活动、连接诊断。

### 安装

```
https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FWLOC.zip%22%5D
```

`urls` 是一个经过 URL 编码的 JSON 数组，可以一次塞多个 zip。

### 发布

```bash
python build-release.py
```

遍历仓库根下每个带 `script.json` 的目录，打成 `dist/<名字>.zip`。
**zip 根必须直接是 `script.json` 和 `index.tsx`**，多包一层目录应用就认不出来，
构建脚本会断言这一点。

`script.json` 的 `remoteResource` 指向的就是这个 zip 的 raw 地址：

```json
"remoteResource": {
  "url": "https://raw.githubusercontent.com/ios151/Scripting/main/dist/WLOC.zip"
}
```

没有设 `autoUpdateInterval` —— 设了会按间隔自动覆盖设备上的脚本，开发期间不合适。

### 类型检查

`dts/` 是 Scripting 应用自带的类型定义，属于应用作者，不在本仓库内。从 Scripting 的工作区复制一份到仓库根目录即可：

```bash
npx -y -p typescript@5.6 tsc --noEmit -p tsconfig.json
```

### 已知限制

- **金融类应用改不了位置** —— 系统会给模拟位置打 `isSimulatedBySoftware` 标记，银行、保险等据此拒绝。这属于系统机制，本项目不绕过。
- **配对记录要从 wloc 导入** —— iOS 17+ 的本机配对要广播 mDNS 服务让系统发现，Scripting 没有这个接口。
- **重启后需重新配对** —— iOS 的配对授权是内存态，iPhone 重启即失效。
- **同时只能有一条 VPN** —— 用 Scripting 自身的隧道会顶掉正在跑的代理工具，可在设置里切换来源。

## 参与开发

先读 [CONTRIBUTING.md](CONTRIBUTING.md)——里面写了项目边界（哪些方向不接受）、
自测怎么跑、以及几个踩过的 Scripting API 坑。

提 issue 请用模板，Bug 那个模板里的「连接状态诊断」一栏很关键，
缺了基本只能靠猜。**任何情况下都不要贴配对记录或私钥。**

## 致谢

- **[BlackCCCat](https://github.com/BlackCCCat/Scripting-Scripts)** —— 界面基座，WLOC 的 UI 沿用自其同名脚本
- [wloc for iOS](https://github.com/ios151/wloc) —— 协议实现参考
- [idevice](https://github.com/jkcoxson/idevice)、[pymobiledevice3](https://github.com/doronz88/pymobiledevice3) —— 协议参考

## 声明

脚本只在你自己拥有并控制的设备上运行，不上传任何位置、搜索或配对数据。配对记录存于钥匙串，仅本机可读。

位置模拟会影响所有依赖系统定位的应用。使用导航、紧急呼叫、交通出行或位置共享之前，请务必先恢复真实位置。请勿用于误导他人、伪造证据、获取无权使用的服务，或违反任何第三方服务的规则。
