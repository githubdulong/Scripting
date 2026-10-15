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
}

function coordinateText(state: SimulationState): string {
  return `${state.latitude.toFixed(5)}, ${state.longitude.toFixed(5)}`;
}

/** 「移动中」「已暂停」「定点模拟」——一眼能看出当前在干什么。 */
function statusText(state: SimulationState): string {
  if (!state.mode) return "定点模拟";
  return state.paused ? "已暂停" : "移动中";
}

function accent(state: SimulationState): Color {
  return state.paused ? "systemOrange" : "systemGreen";
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

function ContentView(state: SimulationState) {
  const ratio = progress(state);
  return (
    <VStack
      alignment="leading"
      spacing={6}
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
          {/* 有地名就「地名 + 坐标」两行，没有就只留坐标——
              别让同一串坐标在卡片上出现两次 */}
          <Text font="subheadline" fontWeight="semibold">
            {state.place || coordinateText(state)}
          </Text>
          {state.place ? (
            <Text font="caption2" foregroundStyle="tertiaryLabel">{coordinateText(state)}</Text>
          ) : null}
        </VStack>
        <Spacer />
        {/* 锁屏上一键收尾：卡片本来就是来提醒「位置是假的」，顺手给个出口 */}
        <Button
          title="恢复"
          systemImage="location.slash.fill"
          tint="systemRed"
          buttonStyle="borderedProminent"
          controlSize="small"
          intent={RestoreLocationIntent(undefined)}
        />
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
      ) : (
        <Text font="caption2" foregroundStyle="systemOrange">用完请记得恢复真实位置</Text>
      )}

      {ratio !== null ? (
        <ProgressView value={ratio} total={1} tint={accent(state)} />
      ) : null}
    </VStack>
  );
}

const builder: LiveActivityUIBuilder<SimulationState> = (state) => (
  <LiveActivityUI
    content={<ContentView {...state} />}
    compactLeading={
      <Image
        systemName={state.modeIcon || "location.fill"}
        foregroundStyle={accent(state)}
      />
    }
    compactTrailing={
      <Text font="caption2" foregroundStyle={accent(state)}>
        {/* 收起态只有一丁点宽度：有进度就给百分比，否则给状态 */}
        {progress(state) !== null
          ? `${Math.round((progress(state) ?? 0) * 100)}%`
          : statusText(state)}
      </Text>
    }
    minimal={
      <Image systemName={state.modeIcon || "location.fill"} foregroundStyle={accent(state)} />
    }
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
            tint="systemRed"
            controlSize="small"
            intent={RestoreLocationIntent(undefined)}
          />
        </HStack>
      )}
    </LiveActivityUIExpandedBottom>
  </LiveActivityUI>
);

export const SimulationLiveActivity = LiveActivity.register("WlocSimulation", builder);
