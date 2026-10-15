# Scripting

[Scripting](https://apps.apple.com/app/id6479691128) 应用上的脚本。

脚本目录直接放仓库根，发布产物在 `dist/`。

## WLOC 虚拟定位 2.1.0

### ⬇️ [点此一键安装](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FWLOC.zip%22%5D)

**在 iPhone / iPad 上用 Safari 打开这个链接**，会直接唤起 Scripting 导入。
在电脑上点是没用的——那台机器上没有 Scripting。

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

**[⬇️ 一键安装 WLOC 虚拟定位](https://www.scripting.fun/import_scripts/?urls=%5B%22https%3A%2F%2Fraw.githubusercontent.com%2Fios151%2FScripting%2Fmain%2Fdist%2FWLOC.zip%22%5D)** —— 在 iOS 设备上用 Safari 打开。

链接长这样：

```
https://www.scripting.fun/import_scripts/?urls=<URL 编码的 JSON 数组>
```

`urls` 是一个经过 URL 编码的 JSON 数组，可以一次塞多个 zip 地址。
本仓库的产物地址是：

```
https://raw.githubusercontent.com/ios151/Scripting/main/dist/WLOC.zip
```

装好之后脚本会自己从这个地址检查更新（`script.json` 的 `remoteResource`）。

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

### 要求

- **iOS 17+**，并开启开发者模式（设置 → 隐私与安全性 → 开发者模式）
- iOS 18+ 才有「点中地点弹系统详情卡」；iOS 26+ 才有毛玻璃外观。两者缺失都只影响观感，不影响功能
- 灵动岛需要 iPhone 14 Pro 及以后的机型；没有的话实时活动仍会出现在锁屏和通知中心

### 已知限制

- **金融类应用改不了位置** —— 系统会给模拟位置打 `isSimulatedBySoftware` 标记，银行、保险等据此拒绝。这属于系统机制，本项目不绕过。
- **首次配对要去系统设置输 PIN** —— 脚本会把本机广播成可配对主机，但 PIN 只能在「设置 → 隐私与安全 → 开发者 → 配对」里输入，这一步系统不允许代劳。也可以继续用 wloc 导出的记录。
- **重启后需重新配对** —— iOS 的配对授权是内存态，iPhone 重启即失效。
- **同时只能有一条 VPN** —— 用 Scripting 自身的隧道会顶掉正在跑的代理工具。
- **目前只能用 Scripting 自身的隧道** —— `openRSDTunnel` 读的是 Scripting 自己的反射状态，不认代理工具提供的回环（已反馈给应用作者）。
- **停止模拟后系统地图未必立刻回到真实位置** —— 拿 Xcode 做对照也一样，属于系统行为。打开地图 App 触发一次真实定位即可。

## 参与开发

- [CONTRIBUTING.md](CONTRIBUTING.md) —— 项目边界（哪些方向不接受）、环境、提交约定
- [SKILL.md](SKILL.md) —— **维护手册**。协议链路怎么走、十几个踩过的坑、
  为什么某些地方要那么写。动 `core/` 之前先看这个。

提 issue 请用模板，Bug 那个模板里的「连接状态诊断」一栏很关键，
缺了基本只能靠猜。**任何情况下都不要贴配对记录或私钥。**

## 致谢

- **[BlackCCCat](https://github.com/BlackCCCat/Scripting-Scripts)** —— 界面基座，WLOC 的 UI 沿用自其同名脚本
- [wloc for iOS](https://github.com/ios151/wloc) —— 协议实现参考
- [Roam Control](https://github.com/seanhowarthdev/Roam-Control) —— 同类的原生实现（MIT），协议层可对照着读
- [idevice](https://github.com/jkcoxson/idevice)、[pymobiledevice3](https://github.com/doronz88/pymobiledevice3) —— 协议参考

## 声明

脚本只在你自己拥有并控制的设备上运行，不上传任何位置、搜索或配对数据。配对记录存于钥匙串，仅本机可读。

位置模拟会影响所有依赖系统定位的应用。使用导航、紧急呼叫、交通出行或位置共享之前，请务必先恢复真实位置。请勿用于误导他人、伪造证据、获取无权使用的服务，或违反任何第三方服务的规则。
