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
  Spacer,
  Text,
  Image,
  Button,
  ProgressView,
  TimerIntervalLabel,
  type Color,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedBottom,
  LiveActivityUIExpandedCenter,
  LiveActivityUIExpandedLeading,
  LiveActivityUIExpandedTrailing,
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
  /** 「恢复真实位置」按钮的颜色 */
  restoreTint: Color;
}

function coordinateText(state: SimulationState): string {
  return `${state.latitude.toFixed(5)}, ${state.longitude.toFixed(5)}`;
}

/** 「移动中」「已暂停」「定点模拟」——一眼能看出当前在干什么。 */
function statusText(state: SimulationState): string {
  if (!state.mode) return "定点模拟";
  return state.paused ? "已暂停" : "移动中";
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

/** 速度与进度拼成一行副标题；没有的部分自动省略，不留空字段。 */
function detailText(state: SimulationState): string {
  const parts: string[] = [];
  if (state.mode) parts.push(state.mode);
  if (state.speedKmh > 0) parts.push(`${state.speedKmh.toFixed(1)} km/h`);
  if (state.total > 0) {
    parts.push(`${(state.travelled / 1000).toFixed(2)}/${(state.total / 1000).toFixed(2)} km`);
  }
  if (state.leg > 1) parts.push(`第 ${state.leg} 趟`);
  return parts.join(" · ");
}

function progress(state: SimulationState): number | null {
  if (state.total <= 0) return null;
  return Math.min(1, Math.max(0, state.travelled / state.total));
}

/**
 * 锁屏 / 通知中心里的完整卡片。
 *
 * 苹果没给「点卡片本体」的钩子（`LiveActivityOptions` 里没有 deeplink），
 * 能交互的只有 Button + AppIntent，所以恢复做成底部整行的按钮——
 * 挤在状态旁边的小按钮在锁屏上基本点不中。
 */
function ContentView(state: SimulationState) {
  const ratio = progress(state);
  return (
    <VStack
      alignment="leading"
      spacing={8}
      padding={{ vertical: 12, leading: 14, trailing: 14 }}
      activityBackgroundTint={{ light: "clear", dark: "clear" }}
    >
      <HStack spacing={10}>
        <Image
          systemName={state.modeIcon || "location.fill.viewfinder"}
          foregroundStyle={accent(state)}
          font="title2"
        />
        <VStack alignment="leading" spacing={2}>
          {/* 有地名就「地名 + 坐标」两行，没有就只留坐标，别让同一串出现两次 */}
          <Text font="subheadline" fontWeight="semibold">
            {state.place || coordinateText(state)}
          </Text>
          {state.place ? (
            <Text font="caption2" foregroundStyle="tertiaryLabel">{coordinateText(state)}</Text>
          ) : null}
        </VStack>
        <Spacer />
        <VStack alignment="trailing" spacing={2}>
          <Text font="caption" fontWeight="semibold" foregroundStyle={accent(state)}>
            {statusText(state)}
          </Text>
          {/* 计时由系统自己走，不用我们定时推更新 */}
          <TimerIntervalLabel
            from={new Date(state.startedAt)}
            to={new Date(state.startedAt + 24 * 3600 * 1000)}
            countsDown={false}
            font="caption2"
            foregroundStyle="tertiaryLabel"
            monospacedDigit
          />
        </VStack>
      </HStack>

      {detailText(state) ? (
        <Text font="caption2" foregroundStyle="secondaryLabel">{detailText(state)}</Text>
      ) : null}

      {ratio !== null ? <ProgressView value={ratio} total={1} tint={accent(state)} /> : null}

      <Button
        title="恢复真实位置"
        systemImage="location.slash.fill"
        tint={state.restoreTint || "systemRed"}
        buttonStyle="borderedProminent"
        frame={{ maxWidth: "infinity" }}
        intent={RestoreLocationIntent(undefined)}
      />
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

const simulationUI: LiveActivityUIBuilder<SimulationState> = (state) => (
  <LiveActivityUI
    content={<ContentView {...state} />}
    compactLeading={<CompactIcon {...state} />}
    compactTrailing={
      <Text
        font="caption2"
        foregroundStyle={accent(state)}
        /* 收起态空间极窄，限宽加单行，长文本不至于把岛撑变形 */
        lineLimit={1}
        frame={{ maxWidth: 62 }}
      >
        {/* 设成「不显示」时给空串，系统会把这一侧收起来 */}
        {state.compactText}
      </Text>
    }
    /* 极简态（同时有两个活动时）只有一个图标的位置，emoji 也能放 */
    minimal={<CompactIcon {...state} />}
  >
    <LiveActivityUIExpandedLeading>
      <VStack alignment="leading" spacing={2}>
        <Image
          systemName={state.modeIcon || "location.fill.viewfinder"}
          foregroundStyle={accent(state)}
          font="title2"
        />
        <Text font="caption2" foregroundStyle={accent(state)}>{statusText(state)}</Text>
      </VStack>
    </LiveActivityUIExpandedLeading>

    <LiveActivityUIExpandedTrailing>
      <VStack alignment="trailing" spacing={2}>
        {state.speedKmh > 0 ? (
          <Text font="caption" fontWeight="semibold" monospacedDigit>
            {state.speedKmh.toFixed(1)} km/h
          </Text>
        ) : null}
        <TimerIntervalLabel
          from={new Date(state.startedAt)}
          to={new Date(state.startedAt + 24 * 3600 * 1000)}
          countsDown={false}
          font="caption2"
          foregroundStyle="tertiaryLabel"
          monospacedDigit
        />
      </VStack>
    </LiveActivityUIExpandedTrailing>

    <LiveActivityUIExpandedCenter>
      <VStack alignment="leading" spacing={2}>
        <Text font="subheadline" fontWeight="semibold">
          {state.place || coordinateText(state)}
        </Text>
        {state.place ? (
          <Text font="caption2" foregroundStyle="tertiaryLabel">{coordinateText(state)}</Text>
        ) : null}
      </VStack>
    </LiveActivityUIExpandedCenter>

    <LiveActivityUIExpandedBottom>
      {progress(state) !== null ? (
        <VStack alignment="leading" spacing={4}>
          <ProgressView value={progress(state) ?? 0} total={1} tint={accent(state)} />
          <Text font="caption2" foregroundStyle="secondaryLabel">{detailText(state)}</Text>
        </VStack>
      ) : (
        <HStack spacing={8}>
          <Text font="caption2" foregroundStyle="systemOrange">用完请记得恢复真实位置</Text>
          <Spacer />
          <Button
            title="恢复真实位置"
            systemImage="location.slash.fill"
            tint={state.restoreTint || "systemRed"}
            controlSize="small"
            intent={RestoreLocationIntent(undefined)}
          />
        </HStack>
      )}
    </LiveActivityUIExpandedBottom>
  </LiveActivityUI>
);

const builder: LiveActivityUIBuilder<SimulationState> = (state) =>
  state.kind === "pairing" ? pairingUI(state) : simulationUI(state);

export const SimulationLiveActivity = LiveActivity.register("WlocSimulation", builder);
