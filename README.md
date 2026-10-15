# WLOC 虚拟定位

[Scripting](https://apps.apple.com/app/id6479691128) 应用上的定位模拟脚本。

仓库根目录就是脚本目录本身（`index.tsx` + `script.json` 在顶层），
这样 `script.json` 的 `remoteResource` 才能把本仓库直接当成更新源拉取。

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

### 远程更新

`script.json` 里配了：

```json
"remoteResource": {
  "url": "https://github.com/ios151/Scripting",
  "autoUpdateInterval": 86400
}
```

应用会按这个间隔（秒）自己来拉，脚本代码不参与。注意更新会覆盖设备上的本地改动。

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

## 致谢

- **[BlackCCCat](https://github.com/BlackCCCat/Scripting-Scripts)** —— 界面基座，WLOC 的 UI 沿用自其同名脚本
- [wloc for iOS](https://github.com/ios151/wloc) —— 协议实现参考
- [idevice](https://github.com/jkcoxson/idevice)、[pymobiledevice3](https://github.com/doronz88/pymobiledevice3) —— 协议参考

## 声明

脚本只在你自己拥有并控制的设备上运行，不上传任何位置、搜索或配对数据。配对记录存于钥匙串，仅本机可读。

位置模拟会影响所有依赖系统定位的应用。使用导航、紧急呼叫、交通出行或位置共享之前，请务必先恢复真实位置。请勿用于误导他人、伪造证据、获取无权使用的服务，或违反任何第三方服务的规则。
