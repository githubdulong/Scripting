// 摇杆浮层：按住朝任意方向实时移动，松手即停。
//
// 做成盖在地图上的浮层而不是面板里的控件——推着摇杆走时要能看见自己的位置，
// 面板会把整张地图盖住。挡住视线就拖开，不必关掉再开。
//
// 这个文件里好几处写法是为了「拖起来不掉帧」，动之前先看注释里的理由——
// 原生那版（wloc for iOS）踩过同样的坑。

import {
  HStack,
  VStack,
  ZStack,
  Text,
  Image,
  Button,
  Circle,
  Capsule,
  RoundedRectangle,
  Spacer,
  useState,
  type Point,
} from "scripting";

/** 底盘半径（点）。触点到中心的距离除以它得到归一化出力。 */
const PAD_RADIUS = 58;
/** 摇杆帽半径。 */
const KNOB_RADIUS = 23;
/** 方向刻度所在的半径。 */
const TICK_RADIUS = 47;
/**
 * 卡片固定宽度。
 *
 * 不固定的话，底下那行读数在「推底盘移动…」和「东北 · 5.0 km/h」之间切换时
 * 宽度会跳一下——正拖着的时候这就是一次可见的抖动。
 */
const CARD_WIDTH = 160;
/**
 * 死区。
 *
 * 手指搭在摇杆上难免有十几个点的抖动，不留死区就会「没推也在走」——
 * 停下来对位置的时候尤其烦人。
 */
const DEAD_ZONE = 0.14;

/** 正北为 0°，顺时针八个方位。索引同时用作刻度高亮和触感反馈的触发值。 */
const COMPASS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];

export interface CardOffset {
  x: number;
  y: number;
}

interface JoystickPadProps {
  /** 归一化方向：右为 +x、上为 +y，模长即出力（推得越远走得越快）。 */
  vector: Observable<{ dx: number; dy: number }>;
  /** 卡片相对默认位置的偏移。拖把手改写，双击把手复位。 */
  cardOffset: Observable<CardOffset>;
  /** 方式名，例如「步行」。 */
  modeLabel: string;
  /** 推到底时的速度（km/h）。出力不满时按比例折算显示。 */
  maxKmh: number;
  /** 把镜头拉回当前位置。推着走时镜头不自动跟，走出视野就点这个。 */
  onRecenter: () => void;
  onStop: () => void;
}

export function JoystickPad({
  vector,
  cardOffset,
  modeLabel,
  maxKmh,
  onRecenter,
  onStop,
}: JoystickPadProps) {
  const current = vector.value;
  const magnitude = Math.min(1, Math.hypot(current.dx, current.dy));
  const pushing = magnitude > 0;

  // 屏幕 y 轴向下，取负才是「上为正北」。
  // 乘的是 PAD_RADIUS - KNOB_RADIUS，这样推到底时帽子正好贴着底盘内缘，不会探出去。
  const reach = PAD_RADIUS - KNOB_RADIUS;
  const knobX = current.dx * reach;
  const knobY = -current.dy * reach;

  // atan2(东, 北) 得到的就是从正北起算的顺时针角度，正好对上 COMPASS 的顺序。
  const dirIndex = pushing
    ? Math.round(((Math.atan2(current.dx, current.dy) * 180) / Math.PI + 360) % 360 / 45) % 8
    : -1;

  /**
   * 跟手。
   *
   * 用触点相对底盘中心的位置，而不是 translation（相对按下点的位移）：
   * 后者在底盘边缘按下时，帽子从中心开始跑，手指和帽子立刻分家，
   * 推到一半才发现方向不对。
   */
  function handleDrag(location: Point) {
    const rawX = (location.x - PAD_RADIUS) / PAD_RADIUS;
    const rawY = -(location.y - PAD_RADIUS) / PAD_RADIUS;
    const m = Math.hypot(rawX, rawY);
    if (m < DEAD_ZONE) {
      vector.setValue({ dx: 0, dy: 0 });
      return;
    }
    /*
      出力在死区之外重新铺开到 0→1。

      直接用 m 的话，一越过死区速度就从 0 跳到 14%，手感是「一推就窜」；
      重铺之后刚出死区几乎不动，推到底才是满速，中间连续可调。
      推出底盘之外按满出力处理，方向不变——手指滑到卡片外面也不会突然断力。
    */
    const power = Math.min(1, (m - DEAD_ZONE) / (1 - DEAD_ZONE));
    vector.setValue({ dx: (rawX / m) * power, dy: (rawY / m) * power });
  }

  /*
    本次拖动的临时位移，松手才并入 cardOffset。

    拖动过程中不写外部 observable：那个 observable 的订阅者不止这一处，
    每帧写一次就等于每帧把它们全叫醒。只动自己的 state，重绘限制在本组件内。
  */
  const [dragDelta, setDragDelta] = useState<CardOffset>({ x: 0, y: 0 });
  /*
    是否正在拖。

    唯一的用处是拖动期间把毛玻璃换成不透明底：毛玻璃要实时采样背后的内容
    再做模糊，而背后是 MapKit 的地图——卡片每动一帧就得跨这层边界重采样，
    拖起来一帧一跳。但静止时毛玻璃是对的，地图上其他浮层都是这个质感，
    单独做成不透明的深灰块在一堆玻璃里很突兀。
    所以只在拖的那几百毫秒降级，松手就换回来。
  */
  const [dragging, setDragging] = useState(false);
  const committed = cardOffset.value;

  function commitDrag(translation: { width: number; height: number }) {
    // 拖动中不夹、松手才夹：拖的时候卡片跟着手指走最跟手，
    // 真拖出屏幕了松手自己弹回来，不至于再也抓不着。
    const limitX = Device.screen.width * 0.42;
    const limitY = Device.screen.height * 0.42;
    cardOffset.setValue({
      x: Math.max(-limitX, Math.min(limitX, committed.x + translation.width)),
      y: Math.max(-limitY, Math.min(limitY, committed.y + translation.height)),
    });
    setDragDelta({ x: 0, y: 0 });
  }

  return (
    <VStack
      spacing={8}
      padding={{ top: 6, bottom: 12, leading: 12, trailing: 12 }}
      frame={{ width: CARD_WIDTH }}
      // 静止时和地图上其他浮层一样是毛玻璃；拖动时降级成不透明底，见 dragging 的注释。
      glassEffect={dragging ? undefined : { type: "rect", cornerRadius: 24 }}
      background={
        dragging ? (
          <RoundedRectangle cornerRadius={24} style="continuous" fill="rgba(28,28,32,0.9)" />
        ) : undefined
      }
      clipShape={{ type: "rect", cornerRadius: 24 }}
      offset={{ x: committed.x + dragDelta.x, y: committed.y + dragDelta.y }}
      // 方向每跨一格「咔」一下，不用盯着屏幕也知道自己在转向。
      sensoryFeedback={{ trigger: dirIndex, feedback: "selection" }}
    >
      {/*
        把手。

        只有这根横条能拖，标题行不参与：整块都能拖的话，手指落在底盘上
        就分不清是要推摇杆还是要挪卡片。横条上没有点按行为，minDistance 取 0
        才跟手——默认 10 点意味着手指要先划过一段卡片才开始动。

        coordinateSpace 必须是 global。默认的 local 是手势所在视图的坐标系，
        而这根横条随卡片一起移动：卡片一动参考系跟着动，translation 的基准被
        不断改写，位移被吃掉一部分（跟不上手指），误差还逐帧累积（抖）。
        钉在全局坐标系上，起点才是固定的。
      */}
      <ZStack
        frame={{ maxWidth: "infinity", height: 20 }}
        // 可拖的是整条顶部区域，不是那根 36 点宽的横条——横条只是视觉提示。
        contentShape="rect"
        onDragGesture={{
          minDistance: 0,
          coordinateSpace: "global",
          onChanged: (details) => {
            if (!dragging) setDragging(true);
            setDragDelta({ x: details.translation.width, y: details.translation.height });
          },
          onEnded: (details) => {
            commitDrag(details.translation);
            setDragging(false);
          },
        }}
        onTapGesture={{
          count: 2,
          perform: () => {
            cardOffset.setValue({ x: 0, y: 0 });
            setDragDelta({ x: 0, y: 0 });
          },
        }}
      >
        <Capsule fill="rgba(255,255,255,0.35)" frame={{ width: 36, height: 5 }} />
      </ZStack>

      <HStack spacing={8}>
        <Image systemName="dpad.fill" foregroundStyle="systemBlue" font="caption2" />
        <Text font="caption2" foregroundStyle="secondaryLabel">{modeLabel}</Text>
        <Spacer minLength={4} />
        {/* 镜头不自动跟，走出视野点这个拉回来——保留当前缩放。 */}
        <Button buttonStyle="borderless" action={onRecenter}>
          <Image systemName="scope" foregroundStyle="systemBlue" font="title3" />
        </Button>
        <Button buttonStyle="borderless" action={onStop}>
          <Image systemName="stop.circle.fill" foregroundStyle="systemRed" font="title3" />
        </Button>
      </HStack>

      <ZStack
        frame={{ width: PAD_RADIUS * 2, height: PAD_RADIUS * 2 }}
        onDragGesture={{
          minDistance: 0,
          onChanged: (details) => handleDrag(details.location),
          onEnded: () => vector.setValue({ dx: 0, dy: 0 }),
        }}
      >
        {/* 底盘。中心深、边缘浅，做出往下凹的感觉，帽子才像是坐在里面。 */}
        <Circle
          fill={{
            colors: ["rgba(0,0,0,0.42)", "rgba(120,120,130,0.16)"],
            center: "center",
            startRadius: 0,
            endRadius: PAD_RADIUS,
          }}
          frame={{ width: PAD_RADIUS * 2, height: PAD_RADIUS * 2 }}
        />

        {/*
          出力环。
          推得越满越亮越粗——这是唯一能看出「到底推到头没有」的指示，
          不然半力和满力在屏幕上长得一模一样。
        */}
        <Circle
          stroke={{
            shapeStyle: pushing ? "systemBlue" : "rgba(255,255,255,0.16)",
            strokeStyle: { lineWidth: 1 + magnitude * 2.5 },
          }}
          frame={{ width: PAD_RADIUS * 2 - 3, height: PAD_RADIUS * 2 - 3 }}
          opacity={pushing ? 0.35 + magnitude * 0.65 : 1}
        />

        {/* 八向刻度，当前方向那颗变亮变大。 */}
        {COMPASS.map((_, i) => {
          const rad = (i * 45 * Math.PI) / 180;
          const on = i === dirIndex;
          const size = on ? 7 : 4;
          return (
            <Circle
              key={`tick-${i}`}
              fill={on ? "systemBlue" : "rgba(255,255,255,0.28)"}
              frame={{ width: size, height: size }}
              offset={{ x: Math.sin(rad) * TICK_RADIUS, y: -Math.cos(rad) * TICK_RADIUS }}
            />
          );
        })}

        {/*
          摇杆帽。左上高光 + 投影，推到哪儿跟到哪儿。
          阴影半径压到 3：半径越大，帽子每动一帧要重算的范围越大。
        */}
        <Circle
          fill={{
            colors: ["rgba(98,178,255,1)", "rgba(0,122,255,1)"],
            center: { x: 0.34, y: 0.28 },
            startRadius: 1,
            endRadius: KNOB_RADIUS * 2,
          }}
          frame={{ width: KNOB_RADIUS * 2, height: KNOB_RADIUS * 2 }}
          offset={{ x: knobX, y: knobY }}
          shadow={{ color: "rgba(0,0,0,0.4)", radius: 3, x: 0, y: 2 }}
        />
      </ZStack>

      {/*
        读数。
        出力是连续的，光看帽子位置估不出速度——把方位和折算后的实际速度直接写出来。
        等宽字体是为了数字跳动时宽度不变，免得整张卡片跟着抖。
      */}
      <Text
        font="caption2"
        monospaced
        lineLimit={1}
        foregroundStyle={pushing ? "label" : "tertiaryLabel"}
      >
        {pushing ? `${COMPASS[dirIndex]} · ${(maxKmh * magnitude).toFixed(1)} km/h` : "拖横条可挪位置"}
      </Text>
    </VStack>
  );
}
