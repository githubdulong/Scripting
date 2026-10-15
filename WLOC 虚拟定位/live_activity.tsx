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
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedCenter,
  LiveActivityUIExpandedLeading,
  LiveActivityUIExpandedTrailing,
  type LiveActivityUIBuilder,
} from "scripting";

export interface SimulationState {
  /** 地点名或坐标文本 */
  place: string;
  /** 移动方式说明，定点模拟时为空 */
  movement: string;
  latitude: number;
  longitude: number;
}

function coordinateText(state: SimulationState): string {
  return `${state.latitude.toFixed(5)}, ${state.longitude.toFixed(5)}`;
}

function ContentView(state: SimulationState) {
  return (
    <HStack
      spacing={12}
      padding={{ vertical: 10, leading: 14, trailing: 14 }}
      activityBackgroundTint={{ light: "clear", dark: "clear" }}
    >
      <Image systemName="location.fill.viewfinder" foregroundStyle="systemGreen" font="title2" />
      <VStack alignment="leading" spacing={2}>
        <Text font="subheadline" fontWeight="semibold">正在模拟位置</Text>
        <Text font="caption" foregroundStyle="secondaryLabel">{state.place}</Text>
        {state.movement ? (
          <Text font="caption2" foregroundStyle="tertiaryLabel">{state.movement}</Text>
        ) : (
          <Text font="caption2" foregroundStyle="tertiaryLabel">{coordinateText(state)}</Text>
        )}
      </VStack>
      <Spacer />
    </HStack>
  );
}

const builder: LiveActivityUIBuilder<SimulationState> = (state) => (
  <LiveActivityUI
    content={<ContentView {...state} />}
    compactLeading={<Image systemName="location.fill" foregroundStyle="systemGreen" />}
    compactTrailing={
      <Text font="caption2" foregroundStyle="systemGreen">
        {state.movement ? "移动中" : "模拟中"}
      </Text>
    }
    minimal={<Image systemName="location.fill" foregroundStyle="systemGreen" />}
  >
    <LiveActivityUIExpandedLeading>
      <Image systemName="location.fill.viewfinder" foregroundStyle="systemGreen" font="title2" />
    </LiveActivityUIExpandedLeading>
    <LiveActivityUIExpandedTrailing>
      <Text font="caption2" foregroundStyle="secondaryLabel">{coordinateText(state)}</Text>
    </LiveActivityUIExpandedTrailing>
    <LiveActivityUIExpandedCenter>
      <VStack alignment="leading" spacing={2}>
        <Text font="subheadline" fontWeight="semibold">{state.place}</Text>
        <Text font="caption2" foregroundStyle="tertiaryLabel">
          {state.movement || "定点模拟 · 用完请恢复真实位置"}
        </Text>
      </VStack>
    </LiveActivityUIExpandedCenter>
  </LiveActivityUI>
);

export const SimulationLiveActivity = LiveActivity.register("WlocSimulation", builder);
