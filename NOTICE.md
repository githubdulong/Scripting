# 第三方声明与许可范围

本仓库以 **GPL-3.0** 发布（见 [LICENSE](LICENSE)）。

选这个协议的理由很直接：代码可以随便看、随便改、随便用，但**任何衍生作品都必须
同样以 GPL-3.0 开源并提供完整源码**。拿去改一改做成闭源 App 售卖这条路，协议上
走不通。

---

## 许可覆盖的范围

| 部分 | 状态 |
|---|---|
| `core/` 协议层 | 本项目独立实现（见下） |
| `pages/`、`index.tsx` 等界面 | 在 BlackCCCat 的脚本基础上改写（见下） |
| `_selftest/` | 本项目原创 |
| `dev-loopback/` | 本项目原创 |
| `dts/` | **不在本仓库内**，属于 Scripting 应用作者 |

---

## BlackCCCat 的 Scripting 脚本（界面基座）

- 项目：[BlackCCCat/Scripting-Scripts](https://github.com/BlackCCCat/Scripting-Scripts)
- 许可：**原脚本未声明任何许可**
- 说明：WLOC 的界面最初是在其同名脚本上改出来的。经过多轮重写，当前各页面与
  原脚本已有较大差异，但结构上的承袭关系仍然存在，因此在此声明。

**这一点需要如实说明**：原脚本既没有 LICENSE 文件，`script.json` 里的 `author`
与 `contributors` 也是空的。按版权法的默认规则，未声明许可即「保留所有权利」，
严格来说本项目无权对这部分代码重新许可。

本项目的处理方式是：在 README、`script.json` 的 `contributors`、应用内「关于」页
三处署名致谢，并在此说明来源与状态。**若原作者对此有任何异议，请通过 GitHub
Issue 联系，我们会立即配合调整或移除相关部分。**

---

## 协议层

`core/` 下的全部实现——二进制 plist、NSKeyedArchiver、OPACK、TLV8、SRP-6a、
HKDF / X25519 / Ed25519 / ChaCha20-Poly1305、RemotePairing 握手与 pair-verify、
HTTP/2 与 RemoteXPC、RSD 服务发现、DTX 消息帧——均为本项目的独立 TypeScript
实现，**未复制任何上游源码**。

实现过程中对照阅读了以下项目以理解协议格式。协议本身属于事实性接口，不受版权
保护，但仍在此致谢：

| 项目 | 许可 | 说明 |
|---|---|---|
| [wloc for iOS](https://github.com/ios151/wloc) | MIT | 同作者的原生实现，协议链路的主要参考 |
| [Roam Control](https://github.com/seanhowarthdev/Roam-Control) | MIT | 原生实现，可对照阅读 |
| [idevice](https://github.com/jkcoxson/idevice) | MIT | 协议格式参考 |
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) | GPL-3.0 | 协议格式参考 |

> `10.7.0.1` / `10.7.1.1` 这组回环地址沿用
> [LocalDevVPN](https://github.com/jkcoxson/LocalDevVPN) 的约定，以便已有工具
> 无需改动即可配合使用。这是接口约定而非代码复用。

---

## 运行环境

本项目是 [Scripting](https://apps.apple.com/app/id6479691128) 应用的脚本，
只能在该应用内运行。Scripting 应用本身及其类型定义（`dts/`）属于其作者，
不随本仓库分发，也不在本许可覆盖范围内。
