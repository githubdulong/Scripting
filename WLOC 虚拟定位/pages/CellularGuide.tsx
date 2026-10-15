// 蜂窝数据引导浮层。
//
// 配对服务靠 mDNS 公告自己，而蜂窝接口上没有本地链路，发现不了它——用 5G 时
// 开始模拟会直接失败。解法不是「必须连 WiFi」：临时打开飞行模式撤掉蜂窝接口，
// mDNS 就回到本地；会话建起来之后关掉飞行模式，模拟照常继续，因为 mDNS 只在
// 建立会话那一刻用得上。
//
// 做成三阶段而不是一句提示：切飞行模式要离开应用，回来时得有人告诉用户「成不成、
// 现在能不能关」。这套流程是原生那版验证过的，见 wloc for iOS 的
// MobileDataGuidanceView（仍在连接 / 打开飞行模式 / 关闭飞行模式）。

import { VStack, HStack, ZStack, Text, Button, Image, Spacer, Circle, ProgressView } from "scripting";

export type GuideStage =
  /** 发现失败，先问清是 WiFi 还是蜂窝——我们读不到网络类型，只能让用户自己说。 */
  | "help"
  /** 等用户打开飞行模式，期间后台每隔几秒重试一次发现。 */
  | "airplaneOn"
  /** 会话已就绪，可以把飞行模式关掉了。 */
  | "airplaneOff";

interface CellularGuideProps {
  stage: GuideStage;
  /** 「打开飞行模式」阶段已经重试了多少次，让用户看出它真的在试。 */
  attempts: number;
  onRetry: () => void;
  onUseCellular: () => void;
  onCancel: () => void;
  onDone: () => void;
}

export function CellularGuide({
  stage,
  attempts,
  onRetry,
  onUseCellular,
  onCancel,
  onDone,
}: CellularGuideProps) {
  const icon =
    stage === "help" ? "wifi.exclamationmark" : stage === "airplaneOn" ? "airplane" : "checkmark";
  const tint = stage === "airplaneOff" ? "systemGreen" : "systemBlue";

  return (
    <VStack
      spacing={16}
      padding={{ top: 22, bottom: 20, leading: 22, trailing: 22 }}
      frame={{ maxWidth: 360 }}
      glassEffect={{ type: "rect", cornerRadius: 28 }}
      clipShape={{ type: "rect", cornerRadius: 28 }}
    >
      <ZStack frame={{ width: 64, height: 64 }}>
        <Circle fill={tint} opacity={0.18} frame={{ width: 64, height: 64 }} />
        <Image systemName={icon} foregroundStyle={tint} font="largeTitle" />
      </ZStack>

      <Text font="headline" foregroundStyle="label">
        {stage === "help"
          ? "连不上这台设备"
          : stage === "airplaneOn"
            ? "开关一次飞行模式"
            : "连上了，可以恢复网络"}
      </Text>

      <Text font="caption" foregroundStyle="secondaryLabel" multilineTextAlignment="center">
        {stage === "help"
          ? "用 WiFi 的话，先确认隧道已连接再重试。\n确实在用 4G / 5G 时才选下面那个。"
          : stage === "airplaneOn"
            ? "控制中心打开飞行模式 → 等两三秒 → 再关掉。\n\n" +
              "飞行模式开着的时候连不上是正常的，隧道也被一起切断了。\n" +
              "关掉之后网络和隧道一起恢复，设备才会重新广播配对服务——脚本一直在重试，连上会自动继续。"
            : "位置模拟已经跑起来了，蜂窝照常用。本地网络只在起步那一刻需要，之后不受影响。"}
      </Text>

      {stage === "airplaneOn" ? (
        <HStack spacing={8}>
          <ProgressView progressViewStyle="circular" />
          <Text font="caption2" foregroundStyle="tertiaryLabel">
            正在重试…已试 {attempts} 次
          </Text>
        </HStack>
      ) : null}

      {stage === "help" ? (
        <VStack spacing={10} frame={{ maxWidth: "infinity" }}>
          <Button action={onRetry}>
            <Text font="body" fontWeight="semibold" foregroundStyle="systemBlue" frame={{ maxWidth: "infinity" }}>
              重试
            </Text>
          </Button>
          <Button action={onUseCellular}>
            <Text font="body" foregroundStyle="label" frame={{ maxWidth: "infinity" }}>
              我在用移动数据
            </Text>
          </Button>
          <Button action={onCancel}>
            <Text font="caption" foregroundStyle="secondaryLabel">取消</Text>
          </Button>
        </VStack>
      ) : stage === "airplaneOn" ? (
        <Button action={onCancel}>
          <Text font="caption" foregroundStyle="secondaryLabel">取消</Text>
        </Button>
      ) : (
        <Button action={onDone}>
          <Text font="body" fontWeight="semibold" foregroundStyle="systemGreen" frame={{ maxWidth: "infinity" }}>
            完成
          </Text>
        </Button>
      )}

      <Spacer minLength={0} />
    </VStack>
  );
}
