# 参与开发

## 先说清楚边界

这个项目用苹果官方的开发者接口模拟本机定位，和 Xcode 的 Simulate Location
走同一套机制。**不接受**以下方向的 PR 和 issue：

- 绕过 `isSimulatedBySoftware` 标记，或试图让金融类应用认不出模拟位置
- 隐藏开发者模式、伪装设备状态
- 任何用于误导他人、伪造证据、获取无权使用的服务的功能

这些不是「还没做」，是不会做。

## 环境

需要 [Scripting](https://apps.apple.com/app/id6479691128)（iOS 17+）、
一台开了开发者模式的设备，以及桌面端的 `scripting-cli` 用来同步和看日志。

```bash
# 类型检查（dts 要从 Scripting 的工作区复制到仓库根）
npx -y -p typescript@5.6 tsc --noEmit -p tsconfig.json

# 引擎自测，脱机可跑，不需要设备
npx -y tsx _selftest/wloc-engine.test.ts      # 字节序、plist、归档、握手原语、配对记录导出
npx -y tsx _selftest/wloc-movement.test.ts    # 球面几何、路径推进、往返、摇杆、GPX
npx -y tsx _selftest/wloc-pairverify.test.ts  # pair-verify 四步与密钥派生
npx -y tsx _selftest/wloc-rsd.test.ts         # HTTP/2 帧、RemoteXPC、服务发现

# 重新打包发布产物
python build-release.py
```

## 代码约定

**注释用中文，解释为什么。** 这个项目里几乎每个反直觉的写法都有原因——
比如 `tcp.ts` 里为什么必须拷贝 Buffer 而不是开视图、`pairing.ts` 里为什么
`&amp;` 要最后反转义。代码做了什么看 diff 就知道，为什么这么写只有写的人知道。
把那个「为什么」写下来，下一个人（包括三个月后的你）才不会把它「优化」掉。

**协议层以 idevice 源码为真值。** `core/` 里的实现对照的是
[jkcoxson/idevice](https://github.com/jkcoxson/idevice)。改动协议细节前先对一遍它，
别凭猜测调字节。

**Scripting 的 API 以离线文档和 dts 为准**，不要凭对 SwiftUI 的印象写。
踩过的坑：`BackgroundKeeper.keepAlive()` 返回的是 `boolean` 而不是抛错；
`List` 的一行里放多个 `Button` 只有最后一个会响应（要加 `buttonStyle="borderless"`）；
实时活动的 `compactLeading` 等槽位不接受 `null`。

**不要静默吞掉用户发起的动作的错误。** `catch (() => undefined)` 只用在清理路径上。
这个项目已经因为「catch 掉就算了」栽过三次——后台保活、实时活动、地图选点，
每次都是界面上一点线索都没有，排查全靠猜。

**密钥材料不进日志。** 只记长度，不记内容。日志会被贴进 issue 和聊天窗口。

## 协议层改动要有自测

`core/` 下涉及字节格式的改动（bplist、NSKeyedArchiver、DTX、TLV8、XPC、
配对记录解析），必须在 `_selftest/` 里补上对应的用例。这些测试脱机可跑，
是改动协议时唯一不依赖设备的保障。

往返测试尤其值得写：编码 → 解码 → 比对。这次加配对记录导出时就是靠它
抓出了「写入转义了、读取没反转义」。

## 提交信息

第一行一句话说清做了什么，不超过 50 字。正文解释为什么——尤其是当改动
看起来反直觉的时候。

```
修 Section 内重复 key

灵动岛那一节里图标和文字两组选项都有 id "none"，同一个 Section 下
key 撞了，SwiftUI 会丢失视图标识。加前缀区分。
```

## 一个 PR 只做一件事

「顺手改了格式」「顺便重命名」混在功能改动里，会让 review 变成猜谜。
格式和重命名单独开 PR，审起来快，出问题也好回退。
