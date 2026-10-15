// 设置页：主页只留「随时可能改」的那几项，配一次就忘的收进子页。
//
// 选中即保存，不设「保存」按钮——这一页的保存键原先在列表最底部，
// 加了新分节后更靠下，很容易改完没保存就把表单划走，改动静默丢失。
//
// 排序按「多久动一次」：出问题要找的状态排最前，外观次之，连接配置再次，
// 高级和关于垫底。原先 12 个分节平铺 390 行，常调的「菜单位置」和一辈子不动的
// 「会话心跳」并排站着，找什么都得滚一遍。

import {
  useState,
  NavigationStack,
  NavigationLink,
  List,
  HStack,
  VStack,
  Text,
  Button,
  Section,
  Image,
  Spacer,
  Navigation,
} from "scripting";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { AboutPage } from "./AboutPage";
import { SettingsCardStyle } from "./SettingsCardStyle";
import { SettingsConnection } from "./SettingsConnection";
import { SettingsAdvanced } from "./SettingsAdvanced";
import { OptionGroup, NavRow } from "./SettingsControls";
import { exportDebugLog } from "../utils/logExport";
import { debugLogCount } from "../core/debug";
import type { AppSettings } from "../types";
import {
  DEFAULT_SETTINGS,
  MAP_LAYER_OPTIONS,
  MENU_CORNER_OPTIONS,
  TUNNEL_SOURCE_OPTIONS,
} from "../constants";

interface SettingsPageProps {
  settings: AppSettings;
  /** 任一项变更后立即调用，由调用方落盘。 */
  onChange: (settings: AppSettings) => void;
  onDone: () => void;
}

export function SettingsPage({ settings, onChange, onDone }: SettingsPageProps) {
  const [current, setCurrent] = useState<AppSettings>(settings);
  /** 导出日志后的一行提示。 */
  const [status, setStatus] = useState("");

  function update(patch: Partial<AppSettings>) {
    const next = { ...current, ...patch };
    setCurrent(next);
    onChange(next);
  }

  function handleReset() {
    setCurrent(DEFAULT_SETTINGS);
    onChange(DEFAULT_SETTINGS);
  }

  async function handleExport() {
    try {
      setStatus(await exportDebugLog());
    } catch (error) {
      setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="设置"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
        toolbar={{ confirmationAction: <Button title="完成" action={onDone} /> }}
      >
        {/*
          状态。
          连不上是最常见的问题，排查要的两样东西都摆在第一屏——
          导出日志原先埋在「连接状态 → 运行日志 → 导出」三层底下，反馈时没人找得到。
        */}
        <Section
          header={<Text>状态</Text>}
          footer={
            <VStack alignment="leading" spacing={4}>
              {status ? <Text foregroundStyle="secondaryLabel">{status}</Text> : null}
              <Text foregroundStyle="tertiaryLabel">
                日志只在内存里，记最近 600 条，脚本一关就没了，导出时会自动脱敏。
                要清空或改用复制，去「连接状态」页。
              </Text>
            </VStack>
          }
        >
          <Button action={() => void Navigation.present({ element: <DiagnosticsPage /> })}>
            <NavRow title="连接状态" systemImage="stethoscope" />
          </Button>
          <Button action={() => void handleExport()}>
            <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
              <Image systemName="square.and.arrow.up" foregroundStyle="systemBlue" frame={{ width: 22 }} />
              <Text foregroundStyle="label">导出日志</Text>
              <Spacer />
              <Text font="caption" foregroundStyle="secondaryLabel">{debugLogCount()} 条</Text>
            </HStack>
          </Button>
        </Section>

        {/* 外观。这三项是真会反复调的，留在主页一步到位。 */}
        <Section
          header={<Text>外观</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              菜单位置按惯用手选，切换后立即生效。右上角是地图自带控件
              （定位、3D 视角、指南针）的固定位置，让给它们。
            </Text>
          }
        >
          <OptionGroup
            title="地图图层"
            options={MAP_LAYER_OPTIONS}
            selected={current.defaultLayer}
            onPick={(id) => update({ defaultLayer: id })}
          />
          <OptionGroup
            title="菜单位置"
            options={MENU_CORNER_OPTIONS}
            selected={current.menuCorner}
            onPick={(id) => update({ menuCorner: id })}
          />
          <NavigationLink
            destination={<SettingsCardStyle current={current} update={update} />}
          >
            <NavRow title="锁屏与灵动岛" systemImage="platter.filled.top.iphone" />
          </NavigationLink>
        </Section>

        <Section
          header={<Text>连接</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              改定位要通过系统的开发者通道下发坐标，而那个通道只听本机地址，所以需要一条把流量在设备内部闭合的回环隧道。
              iOS 同时只允许一条 VPN 生效：用 Scripting 自身会顶掉正在跑的代理工具。
            </Text>
          }
        >
          <OptionGroup
            title="隧道来源"
            options={TUNNEL_SOURCE_OPTIONS.map((opt) => ({
              ...opt,
              systemImage:
                opt.id === "builtIn"
                  ? "network.badge.shield.half.filled"
                  : "app.connected.to.app.below.fill",
            }))}
            selected={current.tunnelSource}
            onPick={(id) => update({ tunnelSource: id })}
          />
          <NavigationLink destination={<SettingsConnection current={current} update={update} />}>
            <NavRow title="连接设置" value={current.deviceHost} systemImage="point.3.connected.trianglepath.dotted" />
          </NavigationLink>
        </Section>

        <Section footer={<Text foregroundStyle="tertiaryLabel">改动即时保存，无需额外确认。</Text>}>
          <NavigationLink destination={<SettingsAdvanced current={current} update={update} />}>
            <NavRow title="高级" systemImage="gearshape.2" />
          </NavigationLink>
          <Button action={() => void Navigation.present({ element: <AboutPage /> })}>
            <NavRow title="关于 WLOC 虚拟定位" systemImage="info.circle" />
          </Button>
          <Button title="恢复默认" systemImage="arrow.counterclockwise" action={handleReset} />
        </Section>
      </List>
    </NavigationStack>
  );
}
