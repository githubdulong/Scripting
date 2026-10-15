// 设置页：隧道来源、对端地址、默认地图图层、位置扰动、后台心跳。
//
// 选中即保存，不设「保存」按钮——这一页的保存键原先在列表最底部，
// 加了新分节后更靠下，很容易改完没保存就把表单划走，改动静默丢失。

import {
  useState,
  NavigationStack,
  List,
  HStack,
  VStack,
  Text,
  Button,
  Section,
  Image,
  Spacer,
  TextField,
  ColorPicker,
  Navigation,
  type Color,
} from "scripting";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { AboutPage } from "./AboutPage";
import type { AppSettings, MapLayerId, TunnelSource } from "../types";
import {
  DEFAULT_DEVICE_HOST,
  DEFAULT_SETTINGS,
  ISLAND_ICON_OPTIONS,
  ISLAND_TEXT_OPTIONS,
  ISLAND_TINT_OPTIONS,
  JITTER_OPTIONS,
  LOOPBACK_MODULE_LOON,
  LOOPBACK_MODULE_SURGE,
  MAP_LAYER_OPTIONS,
  MENU_CORNER_OPTIONS,
  TUNNEL_SOURCE_OPTIONS,
  WORKER_SOURCE_URL,
} from "../constants";
import { DEFAULT_GLOBAL_ENDPOINT } from "../api/searchApi";

interface SettingsPageProps {
  settings: AppSettings;
  /** 任一项变更后立即调用，由调用方落盘。 */
  onChange: (settings: AppSettings) => void;
  onDone: () => void;
}

export function SettingsPage({ settings, onChange, onDone }: SettingsPageProps) {
  const [current, setCurrent] = useState<AppSettings>(settings);

  function update(patch: Partial<AppSettings>) {
    const next = { ...current, ...patch };
    setCurrent(next);
    onChange(next);
  }

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

  /** 外链行：点一下用 Safari 打开。 */
  function link(title: string, url: string, systemImage: string) {
    return (
      <Button action={() => void Safari.openURL(url)}>
        <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
          <Image systemName={systemImage} foregroundStyle="systemBlue" frame={{ width: 22 }} />
          <Text foregroundStyle="label">{title}</Text>
          <Spacer />
          <Image systemName="arrow.up.right.square" foregroundStyle="tertiaryLabel" font="caption" />
        </HStack>
      </Button>
    );
  }

  function handleReset() {
    setCurrent(DEFAULT_SETTINGS);
    onChange(DEFAULT_SETTINGS);
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="设置"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
        toolbar={{ confirmationAction: <Button title="完成" action={onDone} /> }}
      >
        <Section header={<Text>设备</Text>}>
          <Button action={() => void Navigation.present({ element: <DiagnosticsPage /> })}>
            <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
              <Image systemName="stethoscope" foregroundStyle="systemBlue" frame={{ width: 22 }} />
              <Text foregroundStyle="label">连接状态</Text>
              <Spacer />
              <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" font="caption" />
            </HStack>
          </Button>
        </Section>

        <Section
          header={<Text>隧道来源</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              改定位要通过系统的开发者通道下发坐标，而那个通道只听本机地址，所以需要一条把流量在设备内部闭合的回环隧道。
              iOS 同时只允许一条 VPN 生效：用 Scripting 自身会顶掉正在跑的代理工具。
            </Text>
          }
        >
          {TUNNEL_SOURCE_OPTIONS.map((opt) => (
            <Button key={opt.id} action={() => update({ tunnelSource: opt.id })}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10} alignment="top">
                <Image
                  systemName={
                    opt.id === "builtIn"
                      ? "network.badge.shield.half.filled"
                      : "app.connected.to.app.below.fill"
                  }
                  foregroundStyle={current.tunnelSource === opt.id ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 22 }}
                />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label">{opt.label}</Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{opt.detail}</Text>
                </VStack>
                <Spacer />
                {current.tunnelSource === opt.id ? (
                  <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
                ) : null}
              </HStack>
            </Button>
          ))}
        </Section>

        <Section
          header={<Text>对端地址</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              设备配对服务所在的回环地址，需与隧道提供方的配置一致。
              默认 {DEFAULT_DEVICE_HOST}，与 LocalDevVPN 的约定相同；
              代理工具这边把 tun 的 loopback-address 配成同一个值即可。
            </Text>
          }
        >
          <TextField
            title=""
            value={current.deviceHost}
            onChanged={(value: string) => update({ deviceHost: value })}
            prompt={DEFAULT_DEVICE_HOST}
            keyboardType="numbersAndPunctuation"
          />
        </Section>

        {/*
          代理工具侧的回环配置。
          自己照着文档写一遍很容易漏掉 IPv6 那一项（关蜂窝后接口没地址会被判成
          无网络，隧道直接暂停），所以直接给现成模块。
        */}
        <Section
          header={<Text>代理工具的回环模块</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              隧道来源选「代理工具提供」时，需要让代理工具把 {DEFAULT_DEVICE_HOST} 的流量
              反射回本机。上面两个是现成模块，装上即可。
              {"\n\n"}
              Egern 也支持同样的能力，写法见它自己的文档。
              Quantumult X 据称也可以，但具体写法未经验证，这里不提供模块。
              {"\n\n"}
              自己写的话要点有两个：把 {DEFAULT_DEVICE_HOST}/32 划进 TUN 的包含路由，
              再把该地址设为 reflect（回环到本机）。
            </Text>
          }
        >
          {link("Loon 模块（.lpx）", LOOPBACK_MODULE_LOON, "l.circle")}
          {link("Surge 模块（.sgmodule）", LOOPBACK_MODULE_SURGE, "s.circle")}
        </Section>

        {/*
          灵动岛收起态只有很窄一条，装不下几个字，所以这里只调「图标 + 一句话」。
          锁屏展开后的完整卡片内容是固定的，不跟着这里变。
        */}
        <Section
          header={<Text>灵动岛样式</Text>}
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
          <HStack frame={{ maxWidth: "infinity" }} spacing={8}>
            <Text font="caption2" foregroundStyle="tertiaryLabel">常用</Text>
            <Spacer />
            {ISLAND_TINT_OPTIONS.map((opt) => (
              <Button key={opt.id} action={() => update({ islandTint: opt.id })}>
                <Image
                  systemName={
                    current.islandTint === opt.id ? "checkmark.circle.fill" : "circle.fill"
                  }
                  foregroundStyle={opt.id}
                  font="title3"
                />
              </Button>
            ))}
          </HStack>

          {ISLAND_ICON_OPTIONS.map((opt) => (
            <Button key={opt.id} action={() => update({ islandIcon: opt.id })}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10} alignment="top">
                <Image
                  systemName={current.islandIcon === opt.id ? "largecircle.fill.circle" : "circle"}
                  foregroundStyle={current.islandIcon === opt.id ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 22 }}
                />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label">{opt.label}</Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{opt.detail}</Text>
                </VStack>
                <Spacer />
              </HStack>
            </Button>
          ))}
          {current.islandIcon === "emoji" ? (
            <TextField
              title=""
              value={current.islandEmoji}
              onChanged={(value: string) => update({ islandEmoji: value })}
              prompt="📍 任意 Emoji 或文字"
            />
          ) : null}

          {ISLAND_TEXT_OPTIONS.map((opt) => (
            <Button key={opt.id} action={() => update({ islandText: opt.id })}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10} alignment="top">
                <Image
                  systemName={current.islandText === opt.id ? "largecircle.fill.circle" : "circle"}
                  foregroundStyle={current.islandText === opt.id ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 22 }}
                />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label">{opt.label}</Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{opt.detail}</Text>
                </VStack>
                <Spacer />
              </HStack>
            </Button>
          ))}
          {current.islandText === "custom" ? (
            <TextField
              title=""
              value={current.islandCustomText}
              onChanged={(value: string) => update({ islandCustomText: value })}
              prompt="想显示的文字，短一点"
            />
          ) : null}
        </Section>

        <Section
          header={<Text>菜单位置</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              首页那组功能按钮落在哪个角，按惯用手选。切换后立即生效。
              右上角是地图自带控件（定位、3D 视角、指南针）的固定位置，让给它们。
            </Text>
          }
        >
          {MENU_CORNER_OPTIONS.map((opt) => (
            <Button key={opt.id} action={() => update({ menuCorner: opt.id })}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10} alignment="top">
                <Image
                  systemName={opt.systemImage}
                  foregroundStyle={current.menuCorner === opt.id ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 22 }}
                />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label">{opt.label}</Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{opt.detail}</Text>
                </VStack>
                <Spacer />
                {current.menuCorner === opt.id ? (
                  <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
                ) : null}
              </HStack>
            </Button>
          ))}
        </Section>

        <Section header={<Text>默认地图图层</Text>}>
          {MAP_LAYER_OPTIONS.map((opt) => (
            <Button key={opt.id} action={() => update({ defaultLayer: opt.id as MapLayerId })}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
                <Image
                  systemName={
                    opt.id === "imagery"
                      ? "globe.europe.africa.fill"
                      : opt.id === "hybrid"
                        ? "map.fill"
                        : "map"
                  }
                  foregroundStyle={current.defaultLayer === opt.id ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 22 }}
                />
                <Text foregroundStyle="label">{opt.label}</Text>
                <Spacer />
                {current.defaultLayer === opt.id ? (
                  <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
                ) : null}
              </HStack>
            </Button>
          ))}
        </Section>

        <Section
          header={<Text>位置扰动</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              开启后坐标会在该半径内随机漂移，让静止时的轨迹更接近真机。需要精确落点时保持关闭。
            </Text>
          }
        >
          {JITTER_OPTIONS.map((radius) => (
            <Button key={String(radius)} action={() => update({ jitterRadius: radius })}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
                <Image
                  systemName={radius === 0 ? "scope" : "dot.radiowaves.left.and.right"}
                  foregroundStyle={current.jitterRadius === radius ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 22 }}
                />
                <Text foregroundStyle="label">{radius === 0 ? "关闭" : `${radius} 米`}</Text>
                <Spacer />
                {current.jitterRadius === radius ? (
                  <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
                ) : null}
              </HStack>
            </Button>
          ))}
        </Section>

        <Section
          header={<Text>会话心跳</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              模拟位置靠一条到设备的活连接维持，心跳每 4 秒重发一次坐标。关掉可能会让设备在一段时间后自行恢复真实定位。
            </Text>
          }
        >
          <Button action={() => update({ keepAlive: !current.keepAlive })}>
            <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
              <Image
                systemName={current.keepAlive ? "checkmark.circle.fill" : "circle"}
                foregroundStyle={current.keepAlive ? "systemGreen" : "secondaryLabel"}
                frame={{ width: 22 }}
              />
              <Text foregroundStyle="label">持续下发坐标</Text>
              <Spacer />
            </HStack>
          </Button>
        </Section>

        <Section
          header={<Text>全球搜索服务</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              搜索境外地点（搜索页的「全球」开关）默认走内置服务，上方灰字即默认地址。
              若搜索频繁失败或请求受限，可照下方链接里的说明自己部署 Worker，
              再把它的 /api/search 地址填在这里；留空即恢复内置默认。
            </Text>
          }
        >
          <TextField
            title=""
            value={current.globalSearchEndpoint}
            onChanged={(value: string) => update({ globalSearchEndpoint: value })}
            prompt={DEFAULT_GLOBAL_ENDPOINT}
            keyboardType="URL"
          />
          <Button
            title="Worker 源码与部署教程"
            systemImage="chevron.left.forwardslash.chevron.right"
            action={() => void Safari.openURL(WORKER_SOURCE_URL)}
          />
          {current.globalSearchEndpoint.trim() ? (
            <Button
              title="恢复默认地址"
              systemImage="arrow.counterclockwise"
              action={() => update({ globalSearchEndpoint: "" })}
            />
          ) : null}
        </Section>

        <Section header={<Text>关于</Text>}>
          <Button action={() => void Navigation.present({ element: <AboutPage /> })}>
            <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
              <Image systemName="info.circle" foregroundStyle="systemBlue" frame={{ width: 22 }} />
              <Text foregroundStyle="label">关于 WLOC 虚拟定位</Text>
              <Spacer />
              <Image systemName="chevron.right" foregroundStyle="tertiaryLabel" font="caption" />
            </HStack>
          </Button>
        </Section>

        <Section footer={<Text foregroundStyle="tertiaryLabel">改动即时保存，无需额外确认。</Text>}>
          <Button title="恢复默认" systemImage="arrow.counterclockwise" action={handleReset} />
        </Section>
      </List>
    </NavigationStack>
  );
}
