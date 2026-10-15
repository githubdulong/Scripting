# 本机开发服务回环

让代理工具把 `10.7.0.1` 的流量反射回本机，供设备上的开发者工具使用。

WLOC 虚拟定位把「隧道来源」设为「代理工具提供」时需要它——否则就得用 Scripting
自身的 VPN，而那会顶掉正在运行的代理工具（iOS 同时只允许一条 VPN 生效）。

| 工具 | 模块地址（在手机上长按复制，或直接点开） |
|---|---|
| Loon | [`dev-loopback.lpx`](https://raw.githubusercontent.com/ios151/Scripting/main/dev-loopback/modules/dev-loopback.lpx) |
| Surge | [`dev-loopback.sgmodule`](https://raw.githubusercontent.com/ios151/Scripting/main/dev-loopback/modules/dev-loopback.sgmodule) |

在代理工具里新建模块、粘贴上面的地址即可。脚本的「设置 → 代理工具的回环模块」
里也能直接复制这两个地址。

两边都是同样两件事：把 `10.7.0.1/32` 划进 TUN 的包含路由，再把该地址设为
`reflect`。参数名不同——Loon 是 `include-tun`，Surge 是 `tun-included-routes`。

## 两个文件的 `ipv6-vif` 不一样，这是有意的

```
Loon   ipv6-vif = off
Surge  ipv6-vif = auto
```

**不要「顺手统一」。** 两个工具的 TUN 行为不同，各自取的是能用的那个值。
Surge 这边需要强制给 tun 配上 IPv6 地址：关掉蜂窝后接口仍然有地址，才不会被
判成无网络而把隧道暂停。

## 其他工具

- **Egern** —— 支持同样的能力，写法见它自己的文档
- **Quantumult X** —— 据称也可以，但写法未经验证，所以这里不提供模块

图标 `modules/dev-loopback.png` 由两个模块的 `#!icon` 引用，指向本仓库自己的
raw 地址——仓库公开后才会显示。
