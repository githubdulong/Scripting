// 配对期间的实时活动：把 PIN 显示在灵动岛上。
//
// 为什么需要它：输 PIN 必须切到「设置」App，这时脚本界面已经看不见了。
// 用户要么事先背下六位数、要么来回切，两种都很烦。挂一张卡片，切到哪儿都能看见。
//
// 按系统要求，注册代码必须单独成文件——所以没有和 live_activity.tsx 合并。

import {
  HStack,
  VStack,
  Spacer,
  Text,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedBottom,
  LiveActivityUIExpandedCenter,
  LiveActivityUIExpandedLeading,
  type LiveActivityUIBuilder,
} from "scripting";

export interface PairingPinState {
  /** 六位 PIN */
  pin: string;
  /** 广播结束的时刻，卡片上倒计时用 */
  expiresAt: number;
}

const builder: LiveActivityUIBuilder<PairingPinState> = (state) => (
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
            <Text font="title2" fontWeight="bold" fontDesign="monospaced" monospacedDigit>
              {state.pin}
            </Text>
          </VStack>
          <Spacer />
        </HStack>
        <Text font="caption2" foregroundStyle="secondaryLabel">
          设置 → 隐私与安全性 → 开发者 → 配对 → Scripting WLOC
        </Text>
      </VStack>
    }
    /* 收起态就那么点宽度，放 PIN 本身最有用——这张卡片存在的全部意义就是它 */
    compactLeading={<Image systemName="personalhotspot" foregroundStyle="systemBlue" />}
    compactTrailing={
      <Text font="caption2" fontDesign="monospaced" foregroundStyle="systemBlue" monospacedDigit>
        {state.pin}
      </Text>
    }
    minimal={<Image systemName="personalhotspot" foregroundStyle="systemBlue" />}
  >
    <LiveActivityUIExpandedLeading>
      <Image systemName="personalhotspot" foregroundStyle="systemBlue" font="title2" />
    </LiveActivityUIExpandedLeading>
    <LiveActivityUIExpandedCenter>
      <VStack alignment="leading" spacing={2}>
        <Text font="caption2" foregroundStyle="secondaryLabel">配对 PIN</Text>
        <Text font="title3" fontWeight="bold" fontDesign="monospaced" monospacedDigit>
          {state.pin}
        </Text>
      </VStack>
    </LiveActivityUIExpandedCenter>
    <LiveActivityUIExpandedBottom>
      <Text font="caption2" foregroundStyle="secondaryLabel">
        设置 → 隐私与安全性 → 开发者 → 配对 → Scripting WLOC
      </Text>
    </LiveActivityUIExpandedBottom>
  </LiveActivityUI>
);

export const PairingPinLiveActivity = LiveActivity.register("WlocPairingPin", builder);
