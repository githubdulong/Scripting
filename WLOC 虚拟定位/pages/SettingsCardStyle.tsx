// 设置子页：锁屏卡片与灵动岛的外观。
//
// 从设置主页拆出来的——这一节占了原来整页的三分之一，而它是「配好就不常动」
// 那一类，没必要一直挡在前面。

import {
  List,
  Section,
  HStack,
  Text,
  Button,
  Image,
  Spacer,
  TextField,
  ColorPicker,
  DisclosureGroup,
  useState,
  type Color,
} from "scripting";
import { OptionGroup } from "./SettingsControls";
import type { AppSettings } from "../types";
import { CARD_TITLE_OPTIONS, ISLAND_ICON_OPTIONS, ISLAND_TEXT_OPTIONS, ISLAND_TINT_OPTIONS } from "../constants";

/** 预览用的文字。没有进行中的会话，所以速度/进度一类给示例值。 */
function islandPreviewText(settings: AppSettings): string {
  switch (settings.islandText) {
    case "status":
      return "模拟中";
    case "place":
      return "东交民巷35号";
    case "coordinate":
      return "39.905, 116.408";
    case "speed":
      return "5.0";
    case "progress":
      return "42%";
    case "custom":
      return settings.islandCustomText.trim() || "（未填）";
    case "none":
      return "";
  }
}

export function SettingsCardStyle({
  current,
  update,
}: {
  current: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [tintOpen, setTintOpen] = useState(false);

  return (
    <List navigationTitle="锁屏与灵动岛" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section
        header={<Text>锁屏卡片</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            卡片最上面那行大字。坐标始终显示在它下面，所以这里选「坐标」时
            只会留一行，不会重复。
          </Text>
        }
      >
        <OptionGroup
          title="标题内容"
          options={CARD_TITLE_OPTIONS}
          selected={current.cardTitle}
          onPick={(id) => update({ cardTitle: id })}
        />
        {current.cardTitle === "custom" ? (
          <TextField
            title=""
            value={current.cardCustomTitle}
            onChanged={(value: string) => update({ cardCustomTitle: value })}
            prompt="想显示的标题"
          />
        ) : null}

        {/* 卡片底部那个「恢复真实位置」按钮的颜色 */}
        <ColorPicker
          title="恢复按钮颜色"
          value={current.restoreTint}
          onChanged={(value: Color) => update({ restoreTint: value })}
          supportsOpacity={false}
        />
      </Section>

      {/*
        灵动岛收起态只有很窄一条，装不下几个字，所以这里只调「图标 + 一句话」。
        锁屏展开后的完整卡片内容是固定的，不跟着这里变。
      */}
      <Section
        header={<Text>灵动岛</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            只影响灵动岛收起时那一条。暂停移动时颜色会强制转橙——
            一眼看出状态比好看要紧。
          </Text>
        }
      >
        {/*
          预览。
          灵动岛只有开着模拟时才看得到，改完没法当场确认——尤其是 Emoji，
          不先看一眼根本不知道填的字符能不能显示出来。
        */}
        <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
          <Text font="caption" foregroundStyle="secondaryLabel">预览</Text>
          <Spacer />
          <HStack
            spacing={6}
            padding={{ vertical: 6, leading: 12, trailing: 12 }}
            background={{ style: "black", shape: "capsule" }}
          >
            {current.islandIcon === "none" ? null : current.islandIcon === "emoji" ? (
              <Text font="caption">{current.islandEmoji.trim() || "📍"}</Text>
            ) : (
              <Image
                systemName={current.islandIcon === "mode" ? "figure.walk" : "location.fill"}
                foregroundStyle={current.islandTint}
              />
            )}
            <Text font="caption2" foregroundStyle={current.islandTint}>
              {islandPreviewText(current)}
            </Text>
          </HStack>
        </HStack>

        {/* 原生取色器，支持自定义颜色和不透明度 */}
        <ColorPicker
          title="主色"
          value={current.islandTint}
          onChanged={(value: Color) => update({ islandTint: value })}
          supportsOpacity={false}
        />
        {/* 色块得看着选，换成文字列表就没意义了，所以这组不走 OptionGroup。 */}
        <DisclosureGroup
          title="常用颜色"
          isExpanded={tintOpen}
          onChanged={(value: boolean) => setTintOpen(value)}
        >
          <HStack frame={{ maxWidth: "infinity" }} spacing={8}>
            <Spacer />
            {ISLAND_TINT_OPTIONS.map((opt) => (
              // 必须 borderless：List 的一行默认整行是一个点击目标，
              // 同一行里放多个 Button 的话只有最后一个会响应（之前就是只能选到白色）。
              <Button
                key={`tint-${opt.id}`}
                buttonStyle="borderless"
                action={() => update({ islandTint: opt.id })}
              >
                <Image
                  systemName={current.islandTint === opt.id ? "checkmark.circle.fill" : "circle.fill"}
                  foregroundStyle={opt.id}
                  font="title3"
                />
              </Button>
            ))}
            <Spacer />
          </HStack>
        </DisclosureGroup>

        <OptionGroup
          title="图标"
          options={ISLAND_ICON_OPTIONS}
          selected={current.islandIcon}
          onPick={(id) => update({ islandIcon: id })}
        />
        {current.islandIcon === "emoji" ? (
          <TextField
            title=""
            value={current.islandEmoji}
            onChanged={(value: string) => update({ islandEmoji: value })}
            prompt="📍 任意 Emoji 或文字"
          />
        ) : null}

        <OptionGroup
          title="文字"
          options={ISLAND_TEXT_OPTIONS}
          selected={current.islandText}
          onPick={(id) => update({ islandText: id })}
        />
        {current.islandText === "custom" ? (
          <TextField
            title=""
            value={current.islandCustomText}
            onChanged={(value: string) => update({ islandCustomText: value })}
            prompt="想显示的文字，短一点"
          />
        ) : null}
      </Section>
    </List>
  );
}
