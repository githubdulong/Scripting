// 日志脱敏自测：该打码的打掉，该留的留住。
//
//   npx -y -p tsx tsx _selftest/wloc-redact.test.ts
//
// 这组正则最大的风险是误伤——时间戳长得像 IPv6、距离长得像经纬度、
// 版本号长得像 IP。所以「不该动的没被动」那几条和「该打码的打掉了」一样重要。
//
// **样本一律用虚构值。** 写这个文件时顺手贴了一份真机日志进来，里面是实际位置、
// 住处附近的街道名和设备 UUID——测脱敏的东西自己带着隐私，推上去就全公开了。
// 格式照着真日志抄（位数、结构、JSON 包裹方式），内容另造：坐标用公开地标，
// UUID 和 IPv6 用一眼看得出是编的那种。

import { redactLog } from "../WLOC 虚拟定位/core/redact";

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

/*
  样本：格式照搬真日志，值全是编的。
  坐标用上海（31.24, 121.50）和拉萨（29.65, 91.17）两地——隔得够远，
  正好验证「降精度之后仍看得出是不是跨区」。
  10.7.0.1 保留：那是 LocalDevVPN 的公开约定，README 里就写着。
*/
const SAMPLE = [
  `20:12:06.973 [wloc:tunnel] 隧道已建立 {"serverAddress":"fd00:5ea1:7e57::1","clientAddress":"fd00:5ea1:7e57::2","rsdPort":50753,"mtu":16000,"state":"open","id":"A1B2C3D4-5E6F-4789-ABCD-0123456789AB"}`,
  `19:38:49.649 [wloc:vpn] 隧道来源=proxyApp 对端=10.7.0.1`,
  `19:38:49.776 [wloc:vpn] 代理模式下 10.7.0.1:49152 可达`,
  `19:38:51.095 [wloc:tunnel] 开隧道前自身状态 {"profileId":"0F1E2D3C-4B5A-4698-8778-FEDCBA987654","expectedState":"eyJhZGRyZXNzZXMiOlsiMTAuNy4wLjEiXSwiZW5hYmxlZCI6dHJ1ZSwidmVyc2lvbiI6MX0=","addresses":["10.7.0.1"]}`,
  `19:38:27.899 [wloc:geocode] 31.239692, 121.499809 → 示例大街 1 号`,
  `20:12:07.060 [wloc:dvt] 坐标已下发 31.239692174151203, 121.4998090040871`,
  `19:38:57.245 [wloc:route] 规划 walking：31.23969, 121.49981 → 31.24082, 121.49824，直线 0.19 km`,
  `19:38:32.262 [wloc:route] 规划 walking：29.65249, 91.17211 → 31.23969, 121.49981，直线 2892.41 km`,
  `20:12:07.061 [wloc:settings] 已保存 {"deviceHost":"10.7.0.1","searchWorkerUrl":"https://my-private-worker.example.workers.dev","islandEmoji":"💕","cardCustomTitle":"示例标题","mapLayer":"standard"}`,
  `19:38:50.879 [wloc:pair] 端口 49152 握手成功 {"wireProtocolVersion":26,"minimumWireProtocolVersion":8}`,
  `19:38:57.464 [wloc:route] calculate 返回 1 条（累计 296ms）`,
  `20:12:09.159 [wloc:keepalive] keepAlive() 返回 true ×7`,
].join("\n");

const OUT = redactLog(SAMPLE);

console.log("\n[该打码的]");
{
  check("IPv6 只剩第一段", !OUT.includes("fd00:5ea1:7e57::1") && OUT.includes("fd00:…"));
  check("IPv4 后两段打掉", !OUT.includes("10.7.0.1") && OUT.includes("10.7.x.x"));
  check("UUID 只剩前 8 位", !OUT.includes("A1B2C3D4-5E6F-4789-ABCD-0123456789AB"));
  check("UUID 前缀保留（还能比对是不是同一个）", OUT.includes("A1B2C3D4-…"));
  check("base64 整块打掉", !OUT.includes("eyJhZGRyZXNzZXMiOlsiMTAuNy4wLjEiXQ"));
  check("精确坐标降精度", !OUT.includes("31.239692174151203") && !OUT.includes("121.499809"));
  check("地名打掉", !OUT.includes("示例大街"));
  check("自建 Worker 域名打掉", !OUT.includes("my-private-worker.example.workers.dev"));
  check("自定义卡片标题打掉", !OUT.includes("示例标题"));
  check("自定义 Emoji 打掉", !OUT.includes("💕"));
}

console.log("\n[不该动的]");
{
  // 排查全靠这些：时间顺序、端口、距离、协议版本、重复次数
  check("时间戳没被当成 IPv6", OUT.includes("20:12:06.973") && OUT.includes("19:38:32.262"));
  check("端口保留", OUT.includes("50753") && OUT.includes("49152"));
  check("直线距离保留", OUT.includes("2892.41 km") && OUT.includes("0.19 km"));
  check("耗时保留", OUT.includes("296ms"));
  check("协议版本保留", OUT.includes('"wireProtocolVersion":26'));
  check("mtu 没被当成坐标", OUT.includes('"mtu":16000'));
  check("tag 保留", OUT.includes("[wloc:tunnel]") && OUT.includes("[wloc:geocode]"));
  check("折叠计数保留", OUT.includes("×7"));
  check("非敏感设置项保留", OUT.includes('"mapLayer":"standard"'));
  check("隧道来源保留", OUT.includes("隧道来源=proxyApp"));
  check("行数不变", OUT.split("\n").length === SAMPLE.split("\n").length);
}

console.log("\n[粗粒度位置仍可用]");
{
  // 降到 1 位小数 ≈ 11 km：看得出「同城两点」还是「隔了 2900 km」，
  // 看不出具体在哪条街
  check("同城两点仍相近", OUT.includes("31.2…") && OUT.includes("121.5…"));
  check("跨区仍看得出", OUT.includes("29.7…") && OUT.includes("91.2…"));
}

console.log("\n[边界]");
{
  check("空串不炸", redactLog("") === "");
  check("没有敏感内容时原样返回", redactLog("[wloc:dvt] 定位频道已打开") === "[wloc:dvt] 定位频道已打开");
  check(
    "route 的箭头不被 geocode 规则吃掉",
    redactLog("[wloc:route] a → b，直线 5.00 km").includes("直线 5.00 km"),
  );
  check(
    "版本号不被当成 IPv4",
    redactLog("WLOC 2.2.0 · iOS 27.2").includes("2.2.0"),
  );
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
