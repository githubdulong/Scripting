// 移动引擎自测：球面几何、路径推进、往返、摇杆、GPX 解析。
//
//   npx -y -p tsx tsx _selftest/wloc-movement.test.ts

import {
  bearingBetween,
  cumulativeDistances,
  destination,
  distanceBetween,
  pointAtDistance,
  totalLength,
} from "../WLOC 虚拟定位/core/geo";
import {
  customSpeed,
  customSpeedRange,
  defaultSpeed,
  isCustomSpeed,
  joystickStep,
  modeInfo,
  MOVEMENT_MODES,
  PathWalker,
} from "../WLOC 虚拟定位/core/movement";
import { parseGPX } from "../WLOC 虚拟定位/core/gpx";
import type { Coordinate } from "../WLOC 虚拟定位/types";

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

function near(actual: number, expected: number, tolerance: number): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

const BEIJING: Coordinate = { latitude: 39.904179, longitude: 116.407387 };

console.log("\n[球面几何]");
{
  // 正北走 1000 米：纬度增加约 0.00899 度，经度不变
  const north = destination(BEIJING, 0, 1000);
  check("正北 1km 的距离", near(distanceBetween(BEIJING, north), 1000, 0.5));
  check("正北不改变经度", near(north.longitude, BEIJING.longitude, 1e-9));
  check("正北纬度增加", north.latitude > BEIJING.latitude);

  const east = destination(BEIJING, Math.PI / 2, 1000);
  check("正东 1km 的距离", near(distanceBetween(BEIJING, east), 1000, 0.5));
  check("正东纬度几乎不变", near(east.latitude, BEIJING.latitude, 1e-4), String(east.latitude));
  check("正东经度增加", east.longitude > BEIJING.longitude);

  check("自身距离为 0", distanceBetween(BEIJING, BEIJING) < 1e-6);

  // 方位角往返一致
  const target = destination(BEIJING, 1.0, 5000);
  check("方位角可复原", near(bearingBetween(BEIJING, target), 1.0, 1e-6));

  // 北京 → 上海，约 1065 km
  const shanghai: Coordinate = { latitude: 31.230391, longitude: 121.473701 };
  const km = distanceBetween(BEIJING, shanghai) / 1000;
  check("北京–上海约 1065km", near(km, 1065, 15), `${km.toFixed(1)}km`);

  // 跨日期变更线不跑飞
  const nearLine: Coordinate = { latitude: 0, longitude: 179.99 };
  const crossed = destination(nearLine, Math.PI / 2, 5000);
  check("跨 180° 经度已规整", crossed.longitude >= -180 && crossed.longitude <= 180, String(crossed.longitude));
}

console.log("\n[路径弧长]");
{
  const path: Coordinate[] = [
    BEIJING,
    destination(BEIJING, 0, 1000),
    destination(BEIJING, 0, 3000),
  ];
  const cumulative = cumulativeDistances(path);
  check("累计距离递增", cumulative[0] === 0 && cumulative[1] < cumulative[2]);
  check("总长约 3000m", near(totalLength(cumulative), 3000, 1), String(totalLength(cumulative)));

  const mid = pointAtDistance(path, cumulative, 1500);
  check("中点距起点 1500m", near(distanceBetween(path[0], mid), 1500, 1));

  check("负距离夹到起点", pointAtDistance(path, cumulative, -10).latitude === path[0].latitude);
  const beyond = pointAtDistance(path, cumulative, 99999);
  check("超长夹到终点", near(distanceBetween(beyond, path[2]), 0, 0.001));

  // 点疏密不均时也要匀速：取样间隔相同则步长相同
  const uneven: Coordinate[] = [
    BEIJING,
    destination(BEIJING, 0, 10),      // 很短的一段
    destination(BEIJING, 0, 2000),    // 很长的一段
  ];
  const unevenCumulative = cumulativeDistances(uneven);
  const a = pointAtDistance(uneven, unevenCumulative, 500);
  const b = pointAtDistance(uneven, unevenCumulative, 1000);
  check("疏密不均仍匀速", near(distanceBetween(a, b), 500, 1), String(distanceBetween(a, b)));
}

console.log("\n[移动方式]");
{
  check("四种方式", MOVEMENT_MODES.length === 4);
  check("每种三档速度", MOVEMENT_MODES.every((m) => m.speeds.length === 3));
  check("步行默认 1.4m/s", defaultSpeed("walking").metresPerSecond === 1.4);
  check("驾车默认 16.7m/s", defaultSpeed("driving").metresPerSecond === 16.7);
  check("驾车走车行路线", modeInfo("driving").transportType === "automobile");
  check("骑行走步行路线", modeInfo("cycling").transportType === "walking");
  check(
    "速度逐档递增",
    MOVEMENT_MODES.every((m) =>
      m.speeds.every((s, i) => i === 0 || s.metresPerSecond > m.speeds[i - 1].metresPerSecond),
    ),
  );
}

console.log("\n[自定义速度]");
{
  const speed = customSpeed(7.2);
  check("km/h 转 m/s", Math.abs(speed.metresPerSecond - 2) < 1e-9, String(speed.metresPerSecond));
  check("标记为自定义", isCustomSpeed(speed));
  check("预设档位不是自定义", !isCustomSpeed(defaultSpeed("walking")));

  // 各方式的范围要分开，否则会出现「步行 200 km/h」
  check("步行上限 12", customSpeedRange("walking").max === 12);
  check("驾车上限 200", customSpeedRange("driving").max === 200);
  check("驾车下限高于步行下限", customSpeedRange("driving").min > customSpeedRange("walking").min);
  check(
    "每种方式的范围都能容纳自己的预设档位",
    MOVEMENT_MODES.every((mode) => {
      const range = customSpeedRange(mode.key);
      return mode.speeds.every((s) => {
        const kmh = s.metresPerSecond * 3.6;
        return kmh >= range.min && kmh <= range.max;
      });
    }),
  );

  // 换方式时夹取：驾车 120 → 步行应被夹到 12
  const fast = customSpeed(120);
  const walkRange = customSpeedRange("walking");
  const clamped = Math.min(walkRange.max, Math.max(walkRange.min, fast.metresPerSecond * 3.6));
  check("驾车速度切到步行被夹住", clamped === walkRange.max, String(clamped));
}

console.log("\n[沿路径行进]");
{
  const path: Coordinate[] = [BEIJING, destination(BEIJING, Math.PI / 2, 1000)];

  // 单程：10m/s 走 1000m 应恰好 100 秒
  const walker = new PathWalker(path, 10, "oneWay");
  check("单程总长 1000m", near(walker.singleLegLength, 1000, 1));

  walker.advance(50);
  check("50 秒走一半", near(walker.state.travelled, 500, 1), String(walker.state.travelled));
  check("中途未结束", !walker.state.finished);
  check(
    "位置在路径中点",
    near(distanceBetween(walker.state.coordinate, path[0]), 500, 1),
  );

  walker.advance(60); // 超出终点
  check("到终点即结束", walker.state.finished);
  check("终点不越界", near(walker.state.travelled, 1000, 1));
  check("停在终点坐标", near(distanceBetween(walker.state.coordinate, path[1]), 0, 1));

  // 结束后再推进不应变化
  const before = walker.state.travelled;
  walker.advance(100);
  check("结束后不再推进", walker.state.travelled === before);
}

console.log("\n[往返]");
{
  const path: Coordinate[] = [BEIJING, destination(BEIJING, 0, 1000)];
  const walker = new PathWalker(path, 100, "round1"); // 往返 1 次 = 2 趟

  // 用 10.01 秒而不是整 10 秒：路径长度经球面往返计算后是 999.9999…，
  // 按整数距离推进会差之毫厘刚好跨不过终点。
  walker.advance(10.01); // 走完第 1 趟并越过终点约 1m
  check("第 1 趟末转入第 2 趟", walker.state.leg === 1, `leg=${walker.state.leg}`);
  check("折返后未结束", !walker.state.finished);
  check(
    "折返瞬间仍在终点附近",
    near(distanceBetween(walker.state.coordinate, path[1]), 0, 3),
    String(distanceBetween(walker.state.coordinate, path[1])),
  );

  walker.advance(5); // 返程再走 500m
  check(
    "返程中点距起点约 500m",
    near(distanceBetween(walker.state.coordinate, path[0]), 500, 3),
    String(distanceBetween(walker.state.coordinate, path[0])),
  );

  walker.advance(5.1); // 走完返程并越过起点
  check("两趟后结束", walker.state.finished, `leg=${walker.state.leg}`);
  check("终点回到起点", near(distanceBetween(walker.state.coordinate, path[0]), 0, 3));

  // 暂停：定时器照常调用 advance，但不前进
  const pausable = new PathWalker(path, 100, "oneWay");
  pausable.advance(3);
  const atPause = pausable.state.travelled;
  pausable.setPaused(true);
  check("暂停标记生效", pausable.isPaused && pausable.state.paused);
  pausable.advance(5);
  check("暂停期间不前进", pausable.state.travelled === atPause, String(pausable.state.travelled));
  pausable.setPaused(false);
  pausable.advance(1);
  check("继续后恢复前进", pausable.state.travelled > atPause);
  check("继续后清除暂停标记", !pausable.state.paused);

  // 不限趟数不会结束
  const endless = new PathWalker(path, 100, "endless");
  endless.advance(1000);
  check("不限趟数不结束", !endless.state.finished, `leg=${endless.state.leg}`);

  // 手动调头：位置不变，方向反转
  const manual = new PathWalker(path, 100, "oneWay");
  manual.advance(3); // 走了 300m
  const atReverse = manual.state.coordinate;
  manual.reverse();
  check(
    "调头瞬间位置不变",
    near(distanceBetween(manual.state.coordinate, atReverse), 0, 2),
  );
  manual.advance(1);
  check(
    "调头后朝起点走",
    distanceBetween(manual.state.coordinate, path[0]) < distanceBetween(atReverse, path[0]),
  );
}

console.log("\n[摇杆]");
{
  // 正北：dx=0, dy=1
  const north = joystickStep(BEIJING, 0, 1, 10, 1);
  check("正北推进 10m", near(distanceBetween(BEIJING, north), 10, 0.1));
  check("正北纬度增加", north.latitude > BEIJING.latitude);

  // 正东：dx=1, dy=0
  const east = joystickStep(BEIJING, 1, 0, 10, 1);
  check("正东经度增加", east.longitude > BEIJING.longitude);
  check("正东纬度几乎不变", near(east.latitude, BEIJING.latitude, 1e-5));

  // 死区
  const idle = joystickStep(BEIJING, 0.01, 0.01, 10, 1);
  check("死区内不动", idle.latitude === BEIJING.latitude && idle.longitude === BEIJING.longitude);

  // 半程出力走一半距离
  const half = joystickStep(BEIJING, 0, 0.5, 10, 1);
  check("半程出力减半", near(distanceBetween(BEIJING, half), 5, 0.1));

  // 超出单位圆按满出力处理
  const over = joystickStep(BEIJING, 0, 2, 10, 1);
  check("出力上限为 1", near(distanceBetween(BEIJING, over), 10, 0.1));
}

console.log("\n[GPX]");
{
  const gpx = `<?xml version="1.0"?>
<gpx version="1.1" creator="test">
  <trk><name>晨跑</name><trkseg>
    <trkpt lat="39.904179" lon="116.407387"><ele>44</ele><time>2026-01-01T00:00:00Z</time></trkpt>
    <trkpt lat="39.905179" lon="116.407387"/>
    <trkpt lat="39.906179" lon="116.408387"></trkpt>
  </trkseg></trk>
</gpx>`;
  const track = parseGPX(gpx);
  check("解析出 3 个点", track.coordinates.length === 3, String(track.coordinates.length));
  check("读出轨迹名", track.name === "晨跑", String(track.name));
  check("首点正确", near(track.coordinates[0].latitude, 39.904179, 1e-9));

  // 属性顺序颠倒、带多余空格
  const reversed = parseGPX(`<gpx><rtept lon = "116.4" lat='39.9'/><rtept lat="39.91" lon="116.41"/></gpx>`);
  check("属性顺序任意", reversed.coordinates.length === 2);
  check("单引号与空格", near(reversed.coordinates[0].longitude, 116.4, 1e-9));

  // 重合点被跳过
  const duplicated = parseGPX(
    `<gpx><wpt lat="1" lon="1"/><wpt lat="1" lon="1"/><wpt lat="2" lon="2"/></gpx>`,
  );
  check("跳过重合点", duplicated.coordinates.length === 2, String(duplicated.coordinates.length));

  // 越界坐标被丢弃
  let rejected = false;
  try {
    parseGPX(`<gpx><trkpt lat="999" lon="116"/><trkpt lat="abc" lon="1"/></gpx>`);
  } catch {
    rejected = true;
  }
  check("越界/非法坐标导致点数不足而报错", rejected);

  let emptyRejected = false;
  try {
    parseGPX("<gpx></gpx>");
  } catch {
    emptyRejected = true;
  }
  check("空 GPX 报错", emptyRejected);
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
