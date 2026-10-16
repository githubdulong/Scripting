// WLOC 虚拟定位 —— Scripting 应用上的本机定位模拟脚本
// Copyright (C) 2026 ios151
//
// 本程序是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证
// （第 3 版或任何后续版本）条款重新分发和/或修改它。
//
// 分发本程序是希望它能派上用场，但不提供任何担保；甚至不包含适销性或
// 特定用途适用性的默示担保。详见 GNU 通用公共许可证。
//
// 你应当已随本程序收到一份 GNU 通用公共许可证副本（见 LICENSE）；
// 如果没有，请见 <https://www.gnu.org/licenses/>。

// 锁屏与灵动岛的实时活动。
//
// 位置模拟最容易忘的就是「用完恢复」——把 App 划掉后界面就没了，
// 而设备那头还在模拟。这张卡片独立于脚本生命周期，脚本结束它照样留着，
// 提醒你当前位置是假的。
//
// 按系统要求，注册代码必须单独成文件。

import {
  HStack,
  VStack,
  ZStack,
  Circle,
  Rectangle,
  Spacer,
  Text,
  Image,
  Button,
  ProgressView,
  TimerIntervalLabel,
  type Color,
  type Font,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedBottom,
  LiveActivityUIExpandedCenter,
  LiveActivityUIExpandedLeading,
  type LiveActivityUIBuilder,
} from "scripting";
import { RestoreLocationIntent } from "./app_intents";

export interface SimulationState {
  /**
   * 这张卡片在干什么。
   *
   * 一个脚本只注册一个 Live Activity——注册两个的话应用分不清该用哪个 builder，
   * 灵动岛上会直接显示「错误」。所以配对 PIN 和定位模拟共用这一个类型，
   * 靠这个字段分流。
   */
  kind?: "simulation" | "pairing";
  /** kind 为 pairing 时显示的六位 PIN */
  pin?: string;
  /** 大标题的自定义文案；为空表示跟着状态自动生成 */
  title: string;
  /** 地点名；点空地且反查不到时为空字符串，此时卡片只显示坐标 */
  place: string;
  latitude: number;
  longitude: number;
  /** 移动方式名称（步行/跑步/骑行/驾车/摇杆），定点模拟时为空 */
  mode: string;
  /** 移动方式对应的 SF Symbol，定点模拟时为空 */
  modeIcon: string;
  /** 速度，km/h；0 表示定点不动 */
  speedKmh: number;
  /** 沿路线/手绘路径移动时的已走与总长（米）；非路线模式为 0 */
  travelled: number;
  total: number;
  /** 第几趟（往返时 > 1） */
  leg: number;
  paused: boolean;
  /** 会话开始时间，卡片上显示已持续多久 */
  startedAt: number;

  // ── 灵动岛收起态的外观，全部由设置页决定 ──
  /** 主色。暂停时一律转橙，提醒优先于好看。 */
  tint: Color;
  /** 收起态的图标：SF Symbol 名；为空表示不显示图标 */
  compactIcon: string;
  /** compactIcon 是 Emoji 而不是 SF Symbol —— 两者渲染方式不同 */
  compactIconIsEmoji: boolean;
  /** 收起态右侧文字，已由界面层算好；为空表示不显示 */
  compactText: string;
  /** 收起态右侧改放「已持续」计时（设置里选了「计时」）；为 true 时忽略 compactText */
  compactTimer: boolean;
  /** 「恢复真实位置」按钮的颜色 */
  restoreTint: Color;
}

/** 计时器的终点。TimerIntervalLabel 必须给区间，一天足够覆盖任何一次会话。 */
const TIMER_SPAN_MS = 24 * 3600 * 1000;

function coordinateText(state: SimulationState): string {
  return `${state.latitude.toFixed(5)}, ${state.longitude.toFixed(5)}`;
}

/**
 * 卡片标题：它正在干什么。
 *
 * 标题放状态、副标题放地名——这条岛上「它在干什么」比「在哪儿」更该先读到，
 * 位置在副标题和底行里都有。
 */
function titleText(state: SimulationState): string {
  /*
    暂停压过自定义文案。

    自定义的是「正常跑着的时候显示什么」，而暂停是个需要立刻看见的状态——
    让一句固定的「我在北京」盖住它，用户会以为还在走。
  */
  if (state.paused) return "已暂停";
  if (state.title) return state.title;
  return state.mode ? `${state.mode}中` : "位置模拟中";
}

/**
 * 底行左侧那一句。
 *
 * 定点时放精确坐标，补足副标题里的地名；地名为空时副标题已经是坐标，这里留空，
 * 别让同一串出现两次。移动时坐标每秒都在变、读不出意义，换成速度和里程——
 * 方式名已经在标题里了，这里不再重复。
 */
function footnoteText(state: SimulationState): string {
  if (!state.mode) return state.place ? coordinateText(state) : "";
  const parts: string[] = [];
  if (state.speedKmh > 0) parts.push(`${state.speedKmh.toFixed(1)} km/h`);
  if (state.total > 0) {
    parts.push(`${(state.travelled / 1000).toFixed(2)}/${(state.total / 1000).toFixed(2)} km`);
  }
  if (state.leg > 1) parts.push(`第 ${state.leg} 趟`);
  return parts.join(" · ");
}

/**
 * 卡片主色。
 *
 * 用户选的颜色优先，但**暂停时强制转橙**——这张卡片的首要职责是让你一眼看出
 * 当前状态，好看要给辨识度让路。
 */
function accent(state: SimulationState): Color {
  if (state.paused) return "systemOrange";
  return state.tint || "systemGreen";
}

function progress(state: SimulationState): number | null {
  if (state.total <= 0) return null;
  return Math.min(1, Math.max(0, state.travelled / state.total));
}

/**
 * 收起态的图标。
 *
 * Emoji 要走 Text，SF Symbol 才走 Image——`Image systemName` 只认符号名。
 * 设置成「不显示」时给一个空白 Text 占位：这几个槽位不接受 null。
 */
function CompactIcon(state: SimulationState) {
  if (!state.compactIcon) return <Text font="caption2"> </Text>;
  if (state.compactIconIsEmoji) return <Text font="caption">{state.compactIcon}</Text>;
  return <Image systemName={state.compactIcon} foregroundStyle={accent(state)} />;
}

/**
 * 会话已持续多久。
 *
 * 交给系统自己跑，不用我们定时推更新——Live Activity 的更新是有配额的，
 * 为了一个秒表去烧配额不划算。
 *
 * 计时文本会吃掉给它的全部宽度，数字再靠左排，放进 HStack 就会贴到摄像头那边去。
 * 所以给固定宽度、数字靠右：宽度按「10:02:15」八个字符留。
 */
function Elapsed({ startedAt, font, width }: { startedAt: number; font: Font; width: number }) {
  return (
    <TimerIntervalLabel
      from={new Date(startedAt)}
      to={new Date(startedAt + TIMER_SPAN_MS)}
      countsDown={false}
      font={font}
      multilineTextAlignment="trailing"
      frame={{ width, alignment: "trailing" }}
    />
  );
}

/**
 * 收起态右侧。
 *
 * 那一侧只有六十来点宽，地名、坐标放进去多半被截断；计时宽度固定、永远排得下，
 * 所以是默认项。其余选项照设置走，设置页里的选择不能被这里悄悄吞掉。
 */
function CompactTrailing(state: SimulationState) {
  if (state.compactTimer) {
    return <Elapsed startedAt={state.startedAt} font="footnote" width={54} />;
  }
  if (!state.compactText) return <Text font="caption2"> </Text>;
  return (
    <Text font="caption" fontWeight="medium" foregroundStyle={accent(state)} lineLimit={1} minScaleFactor={0.6}>
      {state.compactText}
    </Text>
  );
}

/** 实心圆底 + 白图标。淡色底配彩图标在黑岛上糊成一团，实心才立得住。 */
function RoundIcon({ systemName, fill }: { systemName: string; fill: Color }) {
  return (
    <ZStack frame={{ width: 36, height: 36 }}>
      <Circle fill={fill} frame={{ width: 36, height: 36 }} />
      <Image systemName={systemName} foregroundStyle="white" font="subheadline" />
    </ZStack>
  );
}

/**
 * 卡片本体：方案 E（`scripts/wloc_dynamic_island_variants.html`）。
 *
 *   [图标] 标题 / 地名                  [恢复]
 *   ────────────────────────────────────────  ← 走路线时换成进度条
 *   坐标或速度里程                已持续 1:02:15
 *
 * 锁屏和灵动岛展开态共用这一份。颜色全用语义色（label / secondaryLabel / separator），
 * 灵动岛恒为深色、锁屏跟随系统，两边都不用单独配。
 *
 * 苹果没给「点卡片本体」的钩子（`LiveActivityOptions` 里没有 deeplink），
 * 能交互的只有 Button + AppIntent，所以恢复按钮是独立的圆形命中区，
 * 不夹在文字中间，锁屏上也点得中。
 */
function SimulationCard(state: SimulationState) {
  const ratio = progress(state);
  return (
    <VStack alignment="leading" spacing={10} frame={{ maxWidth: "infinity" }}>
      <HStack spacing={10}>
        <RoundIcon systemName={state.modeIcon || "mappin.and.ellipse"} fill={accent(state)} />
        <VStack alignment="leading" spacing={1}>
          <Text font="subheadline" fontWeight="semibold" lineLimit={1}>
            {titleText(state)}
          </Text>
          <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>
            {state.place || coordinateText(state)}
          </Text>
        </VStack>
        <Spacer minLength={8} />
        <Button intent={RestoreLocationIntent(undefined)} buttonStyle="plain">
          <RoundIcon systemName="location.slash.fill" fill={state.restoreTint || "systemRed"} />
        </Button>
      </HStack>

      {/* 走路线时进度条顶替分隔线：同一道横线多带一份信息，岛也不会因此变高 */}
      {ratio !== null ? (
        <ProgressView value={ratio} total={1} tint={accent(state)} />
      ) : (
        <Rectangle fill="separator" frame={{ maxWidth: "infinity", height: 0.5 }} />
      )}

      {/* 左右各缩 4pt，让底行两端比上面的圆形图标略往里收，视觉上更稳 */}
      <HStack spacing={4} padding={{ horizontal: 4 }}>
        <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>
          {footnoteText(state)}
        </Text>
        <Spacer minLength={8} />
        <Text font="caption" foregroundStyle="secondaryLabel">已持续</Text>
        <Elapsed startedAt={state.startedAt} font="caption" width={52} />
      </HStack>
    </VStack>
  );
}

/** 配对期间的卡片：只有一件事要说——PIN 是多少、去哪儿输。 */
function pairingUI(state: SimulationState) {
  const pin = state.pin ?? "";
  return (
    <LiveActivityUI
      content={
        <VStack
          alignment="leading"
          spacing={6}
          padding={{ vertical: 12, leading: 14, trailing: 14 }}
          activityBackgroundTint={{ light: "clear", dark: "clear" }}
        >
          <HStack spacing={10}>
            <Image systemName="personalhotspot" foregroundStyle="systemBlue" font="title2" />
            <VStack alignment="leading" spacing={2}>
              <Text font="caption" foregroundStyle="secondaryLabel">配对 PIN</Text>
              <Text font="title2" fontWeight="bold" fontDesign="monospaced">{pin}</Text>
            </VStack>
            <Spacer />
          </HStack>
          <Text font="caption2" foregroundStyle="secondaryLabel">
            设置 → 隐私与安全性 → 开发者 → 配对 → Scripting WLOC
          </Text>
        </VStack>
      }
      compactLeading={<Image systemName="personalhotspot" foregroundStyle="systemBlue" />}
      compactTrailing={
        <Text font="caption2" fontDesign="monospaced" foregroundStyle="systemBlue">{pin}</Text>
      }
      minimal={<Image systemName="personalhotspot" foregroundStyle="systemBlue" />}
    >
      <LiveActivityUIExpandedLeading>
        <Image systemName="personalhotspot" foregroundStyle="systemBlue" font="title2" />
      </LiveActivityUIExpandedLeading>
      <LiveActivityUIExpandedCenter>
        <VStack alignment="leading" spacing={2}>
          <Text font="caption2" foregroundStyle="secondaryLabel">配对 PIN</Text>
          <Text font="title3" fontWeight="bold" fontDesign="monospaced">{pin}</Text>
        </VStack>
      </LiveActivityUIExpandedCenter>
      <LiveActivityUIExpandedBottom>
        <Text font="caption2" foregroundStyle="secondaryLabel">
          设置 → 隐私与安全性 → 开发者 → 配对 → Scripting WLOC
        </Text>
      </LiveActivityUIExpandedBottom>
    </LiveActivityUI>
  );
}

/*
  展开态整张卡片放进 ExpandedBottom，leading / center / trailing 都不用。

  上一版把图标放 leading、标题放 center、按钮放 trailing——但 leading/trailing
  贴在摄像头两侧，center 在摄像头**下方**，图标和标题因此上下错开一截，
  排不成方案 E 那样的一行。leading 那一侧又只有一百来点宽，图标加标题塞不下。
  整块放 bottom 代价是摄像头那一行空着，换来的是版式完全可控、和锁屏一模一样。
*/
const simulationUI: LiveActivityUIBuilder<SimulationState> = (state) => (
  <LiveActivityUI
    keylineTint={accent(state)}
    dynamicIslandContentMargins={{ expanded: { horizontal: 20, bottom: 16 } }}
    content={
      <VStack
        padding={{ vertical: 14, horizontal: 16 }}
        activityBackgroundTint={{ light: "clear", dark: "clear" }}
      >
        <SimulationCard {...state} />
      </VStack>
    }
    compactLeading={<CompactIcon {...state} />}
    compactTrailing={<CompactTrailing {...state} />}
    minimal={<CompactIcon {...state} />}
  >
    {/*
      底部垫 8pt。

      展开态内容区的裁切范围是圆角矩形，底部两个角的弧（半径约 17pt）正好压在
      最后一行上：真机上坐标首位「3」上端完好、下端左笔头被削，计时末位「5」
      右下的弧被削——越往下、越靠边被吃得越多。整行左右缩进治不了，得把它
      抬离圆弧。锁屏没有这层裁切，不用垫。
    */}
    <LiveActivityUIExpandedBottom>
      <VStack padding={{ bottom: 8 }}>
        <SimulationCard {...state} />
      </VStack>
    </LiveActivityUIExpandedBottom>
  </LiveActivityUI>
);

const builder: LiveActivityUIBuilder<SimulationState> = (state) =>
  state.kind === "pairing" ? pairingUI(state) : simulationUI(state);

export const SimulationLiveActivity = LiveActivity.register("WlocSimulation", builder);
