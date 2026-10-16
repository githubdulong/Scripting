// 蜂窝数据引导浮层。
//
// 配对服务靠 mDNS 公告自己，而蜂窝接口上没有本地链路，发现不了它——用 5G 时
// 开始模拟会直接失败。解法是开关一次飞行模式：撤掉蜂窝接口再接回来，设备就会
// 重新广播配对服务；会话建起来之后蜂窝照常用，本地网络只在起步那一刻需要。
//
// 布局照搬原生那版（wloc for iOS 的 MobileDataGuidanceView）：大圆标 + 标题 +
// 说明 + 状态条 + 按钮堆。三阶段也一样——仍在连接 / 打开飞行模式 / 关闭飞行模式。
// 切飞行模式要离开应用，回来时得有人告诉用户「成没成、现在能不能关」，
// 光弹一句提示是不够的。

import {
  VStack,
  HStack,
  ZStack,
  Text,
  Button,
  Image,
  Circle,
  ProgressView,
  type Color,
} from "scripting";

export type GuideStage =
  /** 发现失败，先问清是 WiFi 还是蜂窝——我们读不到网络类型，只能让用户自己说。 */
  | "help"
  /** 等用户开关飞行模式，期间后台每隔几秒重试一次。 */
  | "airplaneOn"
  /** 会话已就绪，可以把飞行模式关掉了。 */
  | "airplaneOff";

interface CellularGuideProps {
  stage: GuideStage;
  /** 「打开飞行模式」阶段已经重试了多少次，让用户看出它真的在试。 */
  attempts: number;
  /** 第一阶段的「重试」：退出引导直接再连一次。 */
  onRetry: () => void;
  /** 第二阶段的「继续」：立刻多试一次，人留在引导里。 */
  onRetryNow: () => void;
  onUseCellular: () => void;
  onCancel: () => void;
  onDone: () => void;
}

/** 主按钮：实心胶囊，整行。 */
function PrimaryButton({ title, tint, action }: { title: string; tint: Color; action: () => void }) {
  return (
    <Button action={action} frame={{ maxWidth: "infinity" }}>
      <Text
        font="body"
        fontWeight="semibold"
        foregroundStyle="white"
        frame={{ maxWidth: "infinity" }}
        padding={{ vertical: 12 }}
        background={{ style: tint, shape: "capsule" }}
      >
        {title}
      </Text>
    </Button>
  );
}

/**
 * 次要按钮：暗底胶囊，**和主按钮一样整行**。
 *
 * 原先它是窄的（左右各留 22 的内边距、不占满），结果「我正在使用移动数据」的
 * 可点区域只有「重试」的一半多点。而这个浮层弹出来的时候，用的多半**就是**
 * 蜂窝——那才是最常走的那条路，却最难按。
 *
 * 颜色上仍然分主次（实心蓝 vs 暗底），但点击面积不该跟着分。
 */
function SecondaryButton({ title, action }: { title: string; action: () => void }) {
  return (
    <Button action={action} frame={{ maxWidth: "infinity" }}>
      <Text
        font="body"
        fontWeight="medium"
        foregroundStyle="label"
        frame={{ maxWidth: "infinity" }}
        padding={{ vertical: 12 }}
        background={{ style: "tertiarySystemFill", shape: "capsule" }}
      >
        {title}
      </Text>
    </Button>
  );
}

/**
 * 最轻的那一档：无底色，但**点击区域仍是整行**。
 *
 * 原先是裸的一行 `Text`，可点范围就只有那两个字那么大，在一堆整行胶囊中间
 * 显得特别难按。视觉轻重靠颜色和字号表达就够了，不必拿可点面积去表达。
 */
function TextButton({ title, action }: { title: string; action: () => void }) {
  return (
    <Button action={action} frame={{ maxWidth: "infinity" }}>
      <Text
        font="subheadline"
        foregroundStyle="secondaryLabel"
        frame={{ maxWidth: "infinity" }}
        padding={{ vertical: 8 }}
      >
        {title}
      </Text>
    </Button>
  );
}

/** 带图标的一行小字，用来解释下面那个按钮该什么时候按。 */
function HintLabel({ text, systemImage }: { text: string; systemImage: string }) {
  return (
    <HStack spacing={6} alignment="top">
      <Image systemName={systemImage} foregroundStyle="secondaryLabel" font="caption2" />
      <Text
        font="caption"
        foregroundStyle="secondaryLabel"
        multilineTextAlignment="leading"
        /*
          HStack 会把文字压成一行再截断，加上这个才肯竖着撑开换行。
          横向不固定、纵向固定——和 SwiftUI 里的
          fixedSize(horizontal: false, vertical: true) 是同一件事。
        */
        fixedSize={{ horizontal: false, vertical: true }}
      >
        {text}
      </Text>
    </HStack>
  );
}

export function CellularGuide({
  stage,
  attempts,
  onRetry,
  onRetryNow,
  onUseCellular,
  onCancel,
  onDone,
}: CellularGuideProps) {
  const icon = stage === "help" ? "lock.shield" : stage === "airplaneOn" ? "airplane" : "checkmark";
  /*
    圆标用渐变而不是平涂。

    纯色大圆块看着像占位图；斜向渐变是系统各处引导页的通用做法，同样一个圆，
    有了明暗就立体。完成那一步转绿，和前两步的蓝拉开，不用读字也知道成了。
  */
  const iconColors: Color[] =
    stage === "help"
      ? ["rgba(120,110,255,1)", "rgba(70,80,220,1)"]
      : stage === "airplaneOn"
        ? ["rgba(80,150,255,1)", "rgba(0,110,230,1)"]
        : ["rgba(70,215,150,1)", "rgba(20,165,130,1)"];

  const title =
    stage === "help" ? "连不上这台设备" : stage === "airplaneOn" ? "打开飞行模式" : "关闭飞行模式";

  const message =
    stage === "help"
      ? "用 WiFi 的话，先确认隧道已连接再重试。\n确实在用 4G / 5G 时，才选「我正在使用移动数据」。"
      : stage === "airplaneOn"
        ? "请先确认代理工具显示为已连接，再打开飞行模式，然后返回这里。\n" +
          "等隧道重新连上就可以关掉飞行模式了——越快越好，拖久了反而连不上。"
        : "现在关掉飞行模式恢复网络。\n" +
          "切换的那几秒连接会断一下，脚本会自己重连上——看到「已重新连上」就成了，不用再回来走一遍。";

  return (
    <VStack
      spacing={16}
      padding={{ top: 22, bottom: 18, leading: 22, trailing: 22 }}
      frame={{ maxWidth: 340 }}
      glassEffect={{ type: "rect", cornerRadius: 32 }}
      clipShape={{ type: "rect", cornerRadius: 32 }}
    >
      <ZStack frame={{ width: 66, height: 66 }}>
        <Circle
          fill={{
            colors: iconColors,
            startPoint: "topLeading",
            endPoint: "bottomTrailing",
          }}
          frame={{ width: 66, height: 66 }}
        />
        <Image systemName={icon} foregroundStyle="white" font="title" fontWeight="semibold" />
      </ZStack>

      <VStack spacing={8}>
        <Text font="title3" fontWeight="bold" foregroundStyle="label">{title}</Text>
        <Text font="subheadline" foregroundStyle="secondaryLabel" multilineTextAlignment="center">
          {message}
        </Text>
      </VStack>

      {stage === "help" ? (
        <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
          <HintLabel
            text="配对服务靠本地网络公告自己，蜂窝接口上没有本地链路，找不到它。"
            systemImage="lock.shield"
          />
          <PrimaryButton title="重试" tint="systemBlue" action={onRetry} />
          <SecondaryButton title="我正在使用移动数据" action={onUseCellular} />
          <TextButton title="取消" action={onCancel} />
        </VStack>
      ) : stage === "airplaneOn" ? (
        <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
          {/*
            检测中的状态条。

            切飞行模式要离开应用，回来时第一眼得看到「它还在试」——没有这条，
            用户只能盯着一个静止的弹窗猜现在到哪一步了。
          */}
          <HStack
            spacing={9}
            padding={{ vertical: 11, leading: 18, trailing: 18 }}
            background={{ style: "tertiarySystemFill", shape: "capsule" }}
          >
            <ProgressView progressViewStyle="circular" />
            <Text font="subheadline" fontWeight="semibold" foregroundStyle="label">
              正在检测这台 iPhone…
            </Text>
          </HStack>

          <HintLabel
            text={`应会自动继续，已试 ${attempts} 次。若没反应，请点按「继续」。`}
            systemImage="checkmark.seal.fill"
          />

          {/*
            「继续」不是摆设：4 秒一轮，万一正好错过隧道刚连上那个窗口就得干等
            下一轮，而这流程对时机敏感。按它立刻再试一次，人留在引导里。
          */}
          <PrimaryButton title="继续" tint="systemBlue" action={onRetryNow} />
          <TextButton title="取消" action={onCancel} />
        </VStack>
      ) : (
        <VStack spacing={14} frame={{ maxWidth: "infinity" }}>
          <HStack spacing={6}>
            <Image systemName="location.fill" foregroundStyle="systemGreen" font="subheadline" />
            <Text font="subheadline" fontWeight="semibold" foregroundStyle="systemGreen">
              位置模拟中
            </Text>
          </HStack>
          <PrimaryButton title="完成" tint="systemBlue" action={onDone} />
        </VStack>
      )}

    </VStack>
  );
}
