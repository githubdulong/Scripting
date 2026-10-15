# 维护手册

写给接手这个项目的人（包括三个月后的自己）。重点不是「代码在哪」——那个看目录
就行——而是**哪些地方反直觉、为什么那样写、改了会怎么坏**。

---

## 1. 这个东西是怎么工作的

```
本机配对（RemotePairing）
  → 申请一次性隧道监听，拿到端口和 PSK
    → VPN.localDevVPN.openRSDTunnel（TLS-PSK + CDTunnel 由原生做）
      → HTTP/2 + RemoteXPC 取服务表，找 com.apple.instruments.dtservicehub
        → DTX 开 LocationSimulation 频道
          → simulateLocationWithLatitude:longitude:
```

和 Xcode 的 Simulate Location 是同一套机制。整条链路里**只有 TLS-PSK 隧道那一段
是原生做的**，其余（RemotePairing 握手、pair-verify、HTTP/2、RemoteXPC、DTX、
bplist、NSKeyedArchiver）全是这个仓库里的 TypeScript 实现。

协议细节以 [jkcoxson/idevice](https://github.com/jkcoxson/idevice) 为真值。
改字节之前先对一遍它，别凭猜测调。

### 模块地图

| 文件 | 职责 |
|---|---|
| `core/bytes.ts` | hex / base64 / 拼接 / 大小端读写 |
| `core/bplist.ts` | 二进制 plist 读写 |
| `core/keyed_archive.ts` | NSKeyedArchiver 编解码 |
| `core/tlv8.ts` | HomeKit 风格的 TLV8（含 >255 字节分片） |
| `core/crypto_utils.ts` | HKDF-SHA512、X25519、Ed25519、ChaCha20-Poly1305 |
| `core/rppairing.ts` | RemotePairing 信封、pair-verify M1–M4、申请隧道监听 |
| `core/srp.ts` `core/opack.ts` `core/pair_setup.ts` `core/bonjour.ts` | PIN 自配对（响应方） |
| `core/pairing.ts` | 配对记录的存取、解析、三种格式导出 |
| `core/xpc.ts` `core/http2.ts` `core/rsd.ts` | RemoteXPC 服务发现 |
| `core/dtx.ts` | DTX 消息帧与方法调用 |
| `core/location.ts` `core/session.ts` | 坐标下发、会话生命周期、诊断 |
| `core/geo.ts` `core/movement.ts` `core/gpx.ts` | 移动模拟（纯计算，脱机可测） |
| `core/tlsprobe.ts` | 手搓 TLS 1.2 ClientHello，隧道取证用（只在诊断页手动触发） |
| `utils/coords.ts` | GCJ-02 ↔ WGS-84 换算、地图链接解析、位置扰动 |

---

## 2. 改之前必须知道的坑

这一节是这个手册的核心。每一条都是真栽过的。

### 2.1 Node 的 Buffer 不能开视图，必须拷贝

```ts
// 错：在 Node 的 Buffer 内存上开视图
push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
// 对：拷贝
push(new Uint8Array(data));
```

Buffer 来自共享内存池，数据在队列里排队期间底层就可能被回收复用。
症状是**偶发的协议解析错误**，难复现、难定位。见 `core/tcp.ts`。

### 2.2 `BackgroundKeeper.keepAlive()` 返回 boolean，不是抛错

系统拒绝时 `resolve(false)`，不是 reject。只接 reject 分支的话，保活失败会被
当成成功，锁屏掉线时界面上一点线索都没有。要检查返回值，再复核
`BackgroundKeeper.isActive`。

### 2.3 `List` 的一行里放多个 `Button`，只有最后一个会响应

SwiftUI 把列表行当成一个点击目标。做一排颜色圆点时栽过——点哪里都只选中最后
一个。加 `buttonStyle="borderless"` 即可。

### 2.4 实时活动的几个槽位不接受 `null`

`compactLeading` / `compactTrailing` / `minimal` 传 `null` 过不了类型检查，
想「不显示」只能塞一个空白 `Text` 占位。

### 2.5 实时活动的卡片生命周期独立于脚本

脚本被划掉、会话异常中断时卡片都会留在灵动岛上，内容停在最后一次更新那一刻。
所以：

- 启动时要清掉**无主卡片**（没有「未收尾记录」就说明上次正常结束，那张卡是残留）
- 设置改动要**主动推一次更新**，不能只在「有进行中的会话」时推——卡片可能是
  上一次留下的，那时 `activeLoc` 已经是 null，但岛上还挂着旧内容

### 2.6 Observable 必须在组件自己的 render 里读

```tsx
// 错：在 GeometryReader 的子闭包里读，订阅建立不到本组件身上
<GeometryReader>{(proxy) => <Map>{activeLoc.value && <Marker/>}</Map>}</GeometryReader>

// 对：先在 render 里读出来
const active = activeLoc.value;
<GeometryReader>{(proxy) => <Map>{active && <Marker/>}</Map>}</GeometryReader>
```

症状是**底部坐标卡在变、地图上的标记不动**。render-prop 嵌套会把响应式边界搞糊。

### 2.7 `useEffect(…, [])` 捕获的是首帧闭包

`pages/MapPage.tsx` 里有三处这样的 effect 捕获了 `onCoordChange`。现在能跑是
因为里面读的全是 Observable / ref / `setState`（稳定引用）。**哪天有人在回调里
读一个普通 state，POI 选点就会静默用旧值。**

这也是 `drawing` / `drawnPath` 当初不得不改成 Observable + ref 的原因——那是绕过
症状，没治根。根治办法是用 ref 存最新回调，effect 里读 `ref.current`。

### 2.8 不要静默吞掉用户发起的动作的错误

`.catch(() => undefined)` 只用在清理路径上。这个项目已经因为「catch 掉就算了」
栽过三次——后台保活、实时活动、地图选点，每次都是界面上毫无线索，排查全靠猜。

### 2.9 密钥材料不进日志

只记长度，不记内容。日志会被贴进 issue 和聊天窗口。`core/debug.ts` 的 `DEBUG`
默认是 `false`，排查时才打开。

### 2.10 XML 实体：写入转义了，读取也要反转义

`core/pairing.ts` 的 XML plist 路径当初只做了写入转义，设备名带 `&` 或 `<` 的
记录读回来是 `A&lt;B`。wloc 导出的记录同样会中招。注意 `&amp;` 要**最后**反转义，
否则 `&amp;lt;` 会被还原成 `<`。

### 2.11 `node:net` 的 Server 要自己补类型

@types/node 这一版把 `net.Server` 写成 `class Server implements EventEmitter`
而非 `extends`，`on` / `once` / `removeListener` 一个都没继承到。
`dts/node-server-pending.d.ts` 补了这几个。

**必须增补 `"node:net"` 而不是 `"net"`** —— 代码从前者导入，augment 后者完全无效
（排查了很久才发现）。

另外**不要给 tsconfig 加 `"types": []`** 来排除 @types/node：会把
`setInterval` / `clearInterval` 一起切掉（Scripting 自己的 dts 没声明它们）。

### 2.12 隧道监听是一次性的

`createTcpListener()` 拿到的端口只能用一次。**拿到端口后绝不能先做 TCP 探测**，
否则监听被消费掉，真正的隧道建立会失败，错误码还会变（当初排查时错误 6 变成了
错误 7，白白误导了半天）。

`core/tlsprobe.ts` 的取证因此做成了诊断页里的手动按钮，不放在自动失败路径上。

### 2.13 地图选点只能靠手算

Scripting 没有 MapKit 的 `MapReader` / `proxy.convert(_:from:)`。现在的做法是从
`cameraPosition` 取可视范围、配合 `GeometryReader` 的尺寸做线性插值。

注意 `MapCameraPosition` 有四种形态（`region` / `rect` / `camera` / `item`），
**双向绑定回写成哪一种由 MapKit 决定**。只认 `region` 的话，用户一拖地图就再也
算不出坐标。`camera` 形态（倾斜、旋转）下是透视投影，线性插值从原理上不成立，
这时退回选**地图中心**——那个值四种形态都读得到。

这是已知的能力缺口，已反馈给应用作者。

### 2.14 坐标系：地图是 GCJ-02，设备是 WGS-84

界面上存的是地图系坐标，下发前用 `toDeviceCoordinate` 转成 WGS-84。
中国境内两者差 300–500 米，**漏转就是整条街的偏差**。

反过来，`Location.reverseGeocode` 和 `Location.requestCurrent` 给的是 WGS-84，
摆到地图上要先 `fromDeviceCoordinate`。

---

## 3. 开发流程

```bash
# 类型检查（dts 从 Scripting 的工作区复制到仓库根）
npx -y -p typescript@5.6 tsc --noEmit -p tsconfig.json

# 自测，脱机可跑，不需要设备（190 项）
npx -y tsx _selftest/wloc-engine.test.ts      # 字节序、plist、归档、握手原语、配对记录导出
npx -y tsx _selftest/wloc-movement.test.ts    # 球面几何、路径推进、往返、摇杆、GPX
npx -y tsx _selftest/wloc-pairverify.test.ts  # pair-verify 四步与密钥派生
npx -y tsx _selftest/wloc-rsd.test.ts         # HTTP/2 帧、RemoteXPC、服务发现

# 打包发布产物
python build-release.py
```

**协议层的改动必须补自测。** 往返测试最有价值：编码 → 解码 → 比对。
加配对记录导出时就是靠它抓出了「写入转义了、读取没反转义」。

### 发布

- `dist/<名字>.zip`，**zip 根目录必须直接是 `script.json` + `index.tsx`**，
  多包一层目录应用就认不出来（`build-release.py` 会断言这一点）
- `script.json` 的 `remoteResource.url` 指向 **raw zip 地址**，不是仓库地址
- **不要设 `autoUpdateInterval`** ——会按间隔自动覆盖设备上的脚本，开发期间很坑
- 改了代码记得把 `version` 往上提，否则用户看不出有更新

安装链接：

```
https://www.scripting.fun/import_scripts/?urls=<URL编码的JSON数组>
```

---

## 4. 已知限制（不是 bug，别重复排查）

- **金融类应用改不了位置**。系统给模拟位置打 `isSimulatedBySoftware` 标记。
  本项目不绕过，相关 PR 不会被接受。
- **停止模拟后系统地图未必立刻回到真实位置**。拿 Xcode 做对照也一样，根因未明。
  打开地图 App 触发一次真实定位即可。
- **步频 / 步数做不了**。`LocationSimulation` 只有
  `simulateLocationWithLatitude:longitude:`，步数属于 CMPedometer / HealthKit，
  硬件层面隔离。原生 wloc-ios 同样没有。
- **代理工具提供的回环不被接受**。`openRSDTunnel` 读的是 Scripting 自身的反射
  状态，不认别人提供的。已反馈给应用作者。
- **隧道开着时系统的地理编码可能出不去**。iOS 同时只允许一条 VPN，本机回环占着
  那个名额。想要地名的话，**先选点等地名查出来，再开始模拟**——结果有缓存。
- **iPhone 重启后要重新配对**。配对授权是内存态。

---

## 5. 和 wloc-ios（原生版）的关系

协议层对照它实现，但那是 Swift 原生 App，有些事它能做我们做不到：

| | wloc-ios | 这个脚本 |
|---|---|---|
| 地图选点 | `MapReader` + `proxy.convert` | 手算跨度 + 线性插值 |
| 相机跟踪 | `onMapCameraChange(frequency: .continuous)` | 只有手势结束时回写 |
| 后台 | Info.plist 的 background modes | `BackgroundKeeper` 保活队列 |
| 实时活动 | ActivityKit 直接用 | `LiveActivity.register` + 独立文件 |

**不要照搬它的后台方案**——两边机制完全不同，照搬没有意义。
协议细节可以对照，UI 和系统集成要按 Scripting 文档来。

---

## 6. 还没做的

按价值排序，想动手可以从这里挑：

1. **`index.tsx` 1700 多行**，该拆。对照 wloc-ios 的分法：
   `live_activity_controller`（卡片控制）、`path_simulation`（移动编排）、
   `route_planner`（路线）、`map_link`（从 coords.ts 拆出链接解析）。
2. **2.7 那个 stale closure**，用 ref 存最新回调根治。
3. **坐标格式化散落 14 处**、**速度换算 `* 3.6` 散落 10 处**，该各提一个函数。
