// 设置页的共享控件。
//
// 设置项里重复最多的就是「一组单选」和「一行导航」，抽出来之前同一套结构在
// 主页和各子页里抄了七八遍——改一处漏三处。

import {
  HStack,
  VStack,
  Text,
  Button,
  Image,
  Spacer,
  DisclosureGroup,
  useState,
  type Color,
} from "scripting";

interface Option<T extends string> {
  id: T;
  label: string;
  detail?: string;
  systemImage?: string;
}

/**
 * 可折叠的单选组。
 *
 * 收起时标题右边显示当前选中项——一组里只有一行是选中的，其余都是噪音，
 * 没必要一直摊在那儿，但也得让人不展开就知道选的是什么。
 *
 * 自己管展开状态：交给父组件统管的话，每个用到的地方都要多传两个参数，
 * 而这些组互不相干，没有联动的必要。
 */
export function OptionGroup<T extends string>({
  options,
  selected,
  title,
  onPick,
}: {
  options: Option<T>[];
  selected: T;
  title: string;
  onPick: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const chosen = options.find((opt) => opt.id === selected);

  return (
    <DisclosureGroup
      label={
        <HStack frame={{ maxWidth: "infinity" }} spacing={8}>
          <Text foregroundStyle="label">{title}</Text>
          <Spacer />
          <Text font="caption" foregroundStyle="secondaryLabel">{chosen?.label ?? ""}</Text>
        </HStack>
      }
      isExpanded={open}
      onChanged={(value: boolean) => setOpen(value)}
    >
      {options.map((opt) => (
        // 必须 borderless，否则一行里的多个 Button 只有最后一个响应（见 SKILL 2.3）
        <Button key={`${title}-${opt.id}`} buttonStyle="borderless" action={() => onPick(opt.id)}>
          <HStack frame={{ maxWidth: "infinity" }} spacing={10} alignment="top">
            <Image
              systemName={
                opt.systemImage ??
                (selected === opt.id ? "largecircle.fill.circle" : "circle")
              }
              foregroundStyle={selected === opt.id ? "systemBlue" : "secondaryLabel"}
              frame={{ width: 22 }}
            />
            <VStack alignment="leading" spacing={2}>
              <Text foregroundStyle="label">{opt.label}</Text>
              {opt.detail ? (
                <Text font="caption2" foregroundStyle="secondaryLabel">{opt.detail}</Text>
              ) : null}
            </VStack>
            <Spacer />
            {selected === opt.id && opt.systemImage ? (
              <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
            ) : null}
          </HStack>
        </Button>
      ))}
    </DisclosureGroup>
  );
}

/**
 * 导航行：图标 + 标题 + 当前值摘要 + 箭头。右边那个摘要是重点——不点进去也知道现在是什么。
 *
 * @param chevron 自己画不画箭头。放在 `NavigationLink` 里要传 false——
 *                它本身就会画一个，两个叠在一起就成了「> >」。
 *                `Button` 不画，所以那种场景保持默认。
 */
export function NavRow({
  title,
  value,
  systemImage,
  tint = "systemBlue",
  chevron = true,
}: {
  title: string;
  value?: string;
  systemImage: string;
  tint?: Color;
  chevron?: boolean;
}) {
  return (
    <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
      <Image systemName={systemImage} foregroundStyle={tint} frame={{ width: 22 }} />
      <Text foregroundStyle="label">{title}</Text>
      <Spacer />
      {value ? (
        <Text font="caption" foregroundStyle="secondaryLabel">{value}</Text>
      ) : null}
      {chevron ? (
        <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" font="caption" />
      ) : null}
    </HStack>
  );
}

/** 平铺的单选行（带勾）。用在选项少、值得一眼看全的地方。 */
export function RadioRow({
  label,
  detail,
  systemImage,
  selected,
  onPick,
}: {
  label: string;
  detail?: string;
  systemImage: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <Button buttonStyle="borderless" action={onPick}>
      <HStack frame={{ maxWidth: "infinity" }} spacing={10} alignment="top">
        <Image
          systemName={systemImage}
          foregroundStyle={selected ? "systemBlue" : "secondaryLabel"}
          frame={{ width: 22 }}
        />
        <VStack alignment="leading" spacing={2}>
          <Text foregroundStyle="label">{label}</Text>
          {detail ? <Text font="caption2" foregroundStyle="secondaryLabel">{detail}</Text> : null}
        </VStack>
        <Spacer />
        {selected ? <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" /> : null}
      </HStack>
    </Button>
  );
}
