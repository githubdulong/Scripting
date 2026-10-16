// 提示、错误与确认的半屏浮层。
//
// 这里原先是系统 alert / confirm。它们的正文是不滚动的：行数一多系统就自己压字号、
// 再多就直接截断，而本项目最需要说清楚的恰恰是最长的那几段——「配对服务只绑在
// 回环地址上」带着四步操作指引，配对说明带着「设置 → 隐私与安全性 → 开发者 → 配对」
// 这条路径，都是十几行，在 alert 里根本读不完。
//
// 半屏 sheet（presentationDetents）解决的就是这个：正文可滚动，长短都放得下，
// 下拉即关，不像 alert 那样非得伸手去够按钮。布局沿用 CellularGuide 那套
// 渐变圆标 + 标题 + 说明，几个浮层看起来才像一家的。
//
// 通知和确认共用这一个组件：视觉完全一样，差别只在多不多一个主按钮。

import {
  VStack,
  ScrollView,
  Spacer,
  Text,
  Button,
  Image,
  Circle,
  ZStack,
  type Color,
  type PresentationDetent,
} from "scripting";

/** 图标与配色。通知用警示橙，中性的说明/确认用蓝。 */
export type MessageTone = "warning" | "info";

/** 浮层上的主按钮。 */
export interface MessageAction {
  label: string;
  run: () => void;
}

interface MessageSheetProps {
  /** 整段原文。第一行当标题，其余作正文——见 splitMessage。 */
  message: string;
  tone?: MessageTone;
  /**
   * 传了就是确认框：底部变成「主按钮 + 取消」两颗。
   * 不传就是单按钮通知。
   */
  confirm?: { label: string; onConfirm: () => void };
  /** 次要按钮的字。通知态默认「好」，确认态默认「取消」。 */
  dismissLabel?: string;
  onDismiss: () => void;
}

/**
 * 把一段提示拆成标题和正文。
 *
 * 诊断文案本来就是「一句结论 + 若干行详情」的结构（见 session.ts 里那几个
 * describe\* 函数），第一行单独拎出来放大，剩下的留作正文，比一整块小字好读得多。
 * 只有一行的短提示就只有标题，正文为空。
 */
function splitMessage(message: string): { headline: string; body: string } {
  const lines = message.split("\n");
  return { headline: lines[0].trim(), body: lines.slice(1).join("\n").trim() };
}

export function MessageSheet({
  message,
  tone = "warning",
  confirm,
  dismissLabel,
  onDismiss,
}: MessageSheetProps) {
  const { headline, body } = splitMessage(message);
  // 橙色承载的几乎都是「没成功」，但不是崩溃，用警示而非错误红；
  // 蓝色给中性的说明和确认，别把「接下来要做什么」也染成警告。
  const iconColors: Color[] =
    tone === "warning"
      ? ["rgba(255,175,70,1)", "rgba(240,130,20,1)"]
      : ["rgba(90,160,255,1)", "rgba(10,110,235,1)"];
  const icon = tone === "warning" ? "exclamationmark.triangle.fill" : "info.circle.fill";

  /*
    高度跟着内容走，别一律半屏。

    调用点里既有「请先在地图上选择目标位置」这种一行字，也有「只绑在回环地址上」
    那种带四步操作指引的十几行。统统给 medium 的话，前者就是一个圆标加一行字
    吊在半块屏幕中间，空得发慌。
    有正文才给 medium，并允许往上拉到 large 读全文；只有标题时压到 0.3，
    刚好托住圆标、标题和按钮。
  */
  const detents: PresentationDetent[] = body ? ["medium", "large"] : [0.3];

  return (
    <VStack
      spacing={14}
      padding={{ top: 26, bottom: 18, leading: 22, trailing: 22 }}
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      presentationDetents={detents}
      // 让人一眼看出能下拉关掉，不用非去找按钮
      presentationDragIndicator="visible"
    >
      <ZStack frame={{ width: 60, height: 60 }}>
        <Circle
          fill={{ colors: iconColors, startPoint: "topLeading", endPoint: "bottomTrailing" }}
          frame={{ width: 60, height: 60 }}
        />
        <Image systemName={icon} foregroundStyle="white" font="title2" fontWeight="semibold" />
      </ZStack>

      <Text
        font="headline"
        foregroundStyle="label"
        multilineTextAlignment="center"
        // 横向不固定、纵向固定：允许换行，别压成一行再截断
        fixedSize={{ horizontal: false, vertical: true }}
      >
        {headline}
      </Text>

      {/*
        正文走 ScrollView——这是换成 sheet 的全部意义。
        短提示时它只占内容那么高，不会撑出一片空白。
      */}
      {body ? (
        <ScrollView frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
          <Text
            font="subheadline"
            foregroundStyle="secondaryLabel"
            multilineTextAlignment="leading"
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            {body}
          </Text>
        </ScrollView>
      ) : (
        <Spacer />
      )}

      {/*
        确认态把主按钮放在上面、取消放下面。

        系统 alert 把两颗按钮摆成上取消下确认（见改之前的配对说明弹窗），
        手指自然落点在下面那颗——于是最该谨慎的「开始」反而最好按。
        这里反过来：主操作在上，取消在下且只是一行文字，不抢视线。
      */}
      {confirm ? (
        <Button action={confirm.onConfirm} frame={{ maxWidth: "infinity" }}>
          <Text
            font="body"
            fontWeight="semibold"
            foregroundStyle="white"
            frame={{ maxWidth: "infinity" }}
            padding={{ vertical: 12 }}
            background={{ style: "systemBlue", shape: "capsule" }}
          >
            {confirm.label}
          </Text>
        </Button>
      ) : null}

      <Button action={onDismiss} frame={{ maxWidth: "infinity" }}>
        {confirm ? (
          <Text font="body" foregroundStyle="secondaryLabel" padding={{ vertical: 8 }}>
            {dismissLabel ?? "取消"}
          </Text>
        ) : (
          <Text
            font="body"
            fontWeight="semibold"
            foregroundStyle="white"
            frame={{ maxWidth: "infinity" }}
            padding={{ vertical: 12 }}
            background={{ style: "systemBlue", shape: "capsule" }}
          >
            {dismissLabel ?? "好"}
          </Text>
        )}
      </Button>
    </VStack>
  );
}
