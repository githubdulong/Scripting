// 移动模拟：移动方式与速度档位、沿路径行进、摇杆推进。
//
// 这一层是纯计算，不碰设备也不碰界面：由界面按固定间隔调用 `advance(秒)`，
// 拿到新坐标后再交给会话下发。好处是能脱机自测，也便于把定点/路线/摇杆
// 三种来源统一成同一个「给我下一个坐标」的接口。

import { cumulativeDistances, destination, pointAtDistance, totalLength } from "./geo";
import type { Coordinate } from "../types";

export type MovementMode = "walking" | "running" | "cycling" | "driving";

export interface MovementSpeed {
  title: string;
  metresPerSecond: number;
}

export interface MovementModeInfo {
  key: MovementMode;
  label: string;
  systemImage: string;
  /** MapKit 规划路线时用的交通方式 */
  transportType: "walking" | "automobile";
  speeds: MovementSpeed[];
}

/** 档位与 wloc（iOS）保持一致，便于两边对照。 */
export const MOVEMENT_MODES: MovementModeInfo[] = [
  {
    key: "walking",
    label: "步行",
    systemImage: "figure.walk",
    transportType: "walking",
    speeds: [
      { title: "悠闲", metresPerSecond: 1.0 },
      { title: "正常", metresPerSecond: 1.4 },
      { title: "快走", metresPerSecond: 1.8 },
    ],
  },
  {
    key: "running",
    label: "跑步",
    systemImage: "figure.run",
    transportType: "walking",
    speeds: [
      { title: "慢跑", metresPerSecond: 2.5 },
      { title: "正常", metresPerSecond: 3.3 },
      { title: "快跑", metresPerSecond: 4.2 },
    ],
  },
  {
    key: "cycling",
    label: "骑行",
    systemImage: "figure.outdoor.cycle",
    transportType: "walking",
    speeds: [
      { title: "休闲", metresPerSecond: 4.2 },
      { title: "正常", metresPerSecond: 5.6 },
      { title: "快骑", metresPerSecond: 8.3 },
    ],
  },
  {
    key: "driving",
    label: "驾车",
    systemImage: "car.fill",
    transportType: "automobile",
    speeds: [
      { title: "市区", metresPerSecond: 8.3 },
      { title: "郊区", metresPerSecond: 16.7 },
      { title: "高速", metresPerSecond: 25.0 },
    ],
  },
];

export function modeInfo(mode: MovementMode): MovementModeInfo {
  return MOVEMENT_MODES.find((item) => item.key === mode) ?? MOVEMENT_MODES[0];
}

/** 默认取中间那档。 */
export function defaultSpeed(mode: MovementMode): MovementSpeed {
  const speeds = modeInfo(mode).speeds;
  return speeds[Math.min(1, speeds.length - 1)];
}

export const CUSTOM_SPEED_TITLE = "自定义";

export function isCustomSpeed(speed: MovementSpeed): boolean {
  return speed.title === CUSTOM_SPEED_TITLE;
}

/**
 * 自定义速度的可选范围（km/h）。
 *
 * 按方式各给一段：步行档位拉到 200 没有意义，驾车档位从 1 起步同理。
 * 上下限留得比预设档位宽，但不至于离谱。
 */
export function customSpeedRange(mode: MovementMode): { min: number; max: number; step: number } {
  switch (mode) {
    case "walking":
      return { min: 0.5, max: 12, step: 0.1 };
    case "running":
      return { min: 4, max: 30, step: 0.1 };
    case "cycling":
      return { min: 5, max: 60, step: 0.5 };
    case "driving":
      return { min: 10, max: 200, step: 1 };
  }
}

/** 由 km/h 造一个自定义档位。 */
export function customSpeed(kmh: number): MovementSpeed {
  return { title: CUSTOM_SPEED_TITLE, metresPerSecond: kmh / 3.6 };
}

/**
 * 往返计划。
 *
 * MapKit 规划的是单向路线，要重复只能折返——直接把位置传送回起点会产生坐标跳变，
 * 既不自然也容易被识破。
 */
export type LapPlan = "oneWay" | "round1" | "round2" | "round3" | "endless";

export const LAP_OPTIONS: { id: LapPlan; label: string }[] = [
  { id: "oneWay", label: "单程" },
  { id: "round1", label: "往返 1 次" },
  { id: "round2", label: "往返 2 次" },
  { id: "round3", label: "往返 3 次" },
  { id: "endless", label: "不限" },
];

/** 一趟 = 一个单程。往返 N 次 = 2N 趟。 */
function legsFor(plan: LapPlan): number {
  switch (plan) {
    case "oneWay":
      return 1;
    case "round1":
      return 2;
    case "round2":
      return 4;
    case "round3":
      return 6;
    case "endless":
      return Number.POSITIVE_INFINITY;
  }
}

export interface WalkState {
  coordinate: Coordinate;
  /** 已走完的趟数（从 0 开始），界面用来显示「第几趟」 */
  leg: number;
  /** 当前这趟已走的距离（米） */
  travelled: number;
  /** 单程总长（米） */
  total: number;
  finished: boolean;
  paused: boolean;
}

/**
 * 沿一条固定路径行进。
 *
 * 用「已走距离」而不是「当前下标」记录进度：路径点疏密不均时，
 * 按下标推进会忽快忽慢，按距离推进才是匀速。
 */
export class PathWalker {
  private readonly cumulative: number[];
  private readonly length: number;
  private travelled = 0;
  private leg = 0;
  private finished = false;
  private paused = false;

  constructor(
    private readonly path: Coordinate[],
    private speedMps: number,
    private readonly plan: LapPlan = "oneWay",
  ) {
    if (path.length < 2) throw new Error("路径至少需要两个点");
    this.cumulative = cumulativeDistances(path);
    this.length = totalLength(this.cumulative);
    if (this.length <= 0) throw new Error("路径长度为零");
  }

  get state(): WalkState {
    return {
      coordinate: this.currentCoordinate(),
      leg: this.leg,
      travelled: this.travelled,
      total: this.length,
      finished: this.finished,
      paused: this.paused,
    };
  }

  /**
   * 暂停 / 继续。
   *
   * 暂停做在推进器里而不是「停掉定时器」：定时器照常走，只是不推进距离，
   * 这样心跳仍在下发当前坐标，设备不会因为久不收坐标而把会话收掉。
   */
  setPaused(value: boolean): void {
    this.paused = value;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 单程全长（米）。 */
  get singleLegLength(): number {
    return this.length;
  }

  setSpeed(metresPerSecond: number): void {
    if (metresPerSecond > 0) this.speedMps = metresPerSecond;
  }

  /** 立即调头，当前位置不变。 */
  reverse(): void {
    this.travelled = this.length - this.travelled;
    this.leg += 1;
  }

  private currentCoordinate(): Coordinate {
    // 奇数趟是返程，按反方向取点。
    const distance = this.leg % 2 === 0 ? this.travelled : this.length - this.travelled;
    return pointAtDistance(this.path, this.cumulative, distance);
  }

  /** 推进若干秒，返回新的状态。到达终点且没有下一趟时 `finished` 为 true。 */
  advance(seconds: number): WalkState {
    if (this.finished || this.paused || seconds <= 0) return this.state;

    this.travelled += this.speedMps * seconds;

    while (this.travelled >= this.length) {
      const legs = legsFor(this.plan);
      if (this.leg + 1 >= legs) {
        this.travelled = this.length;
        this.finished = true;
        break;
      }
      // 折返：把超出的部分带进下一趟，避免每趟开头卡一下。
      this.travelled -= this.length;
      this.leg += 1;
    }

    return this.state;
  }
}

/**
 * 摇杆推进一步。
 *
 * `dx` / `dy` 是摇杆的归一化位移（右为 +x、上为 +y），模长决定出力大小，
 * 小于死区时原地不动。
 */
export function joystickStep(
  from: Coordinate,
  dx: number,
  dy: number,
  speedMps: number,
  seconds: number,
  deadZone = 0.05,
): Coordinate {
  const magnitude = Math.sqrt(dx * dx + dy * dy);
  if (magnitude < deadZone) return from;

  // atan2(东, 北) 得到以正北为 0、顺时针的方位角。
  const bearing = Math.atan2(dx, dy);
  const metres = speedMps * seconds * Math.min(magnitude, 1);
  return destination(from, bearing, metres);
}
