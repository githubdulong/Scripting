// 设置子页：位置扰动、会话心跳、全球搜索服务。
//
// 共同点是「设一次就忘」，而且改错了后果不轻（关掉心跳会掉线、搜索地址填错
// 境外搜索直接不工作）。收进来一层，既不挡路，也不至于手滑碰到。

import { List, Section, Text, Button, TextField } from "scripting";
import { RadioRow } from "./SettingsControls";
import type { AppSettings } from "../types";
import { JITTER_OPTIONS, WORKER_SOURCE_URL } from "../constants";
import { DEFAULT_GLOBAL_ENDPOINT } from "../api/searchApi";

export function SettingsAdvanced({
  current,
  update,
}: {
  current: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  return (
    <List navigationTitle="高级" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section
        header={<Text>位置扰动</Text>}
        footer={
          <Text foregroundStyle="tertiaryLabel">
            开启后坐标会在该半径内随机漂移，让静止时的轨迹更接近真机。需要精确落点时保持关闭。
          </Text>
        }
      >
        {JITTER_OPTIONS.map((radius) => (
          <RadioRow
            key={String(radius)}
            label={radius === 0 ? "关闭" : `${radius} 米`}
            systemImage={radius === 0 ? "scope" : "dot.radiowaves.left.and.right"}
            selected={current.jitterRadius === radius}
            onPick={() => update({ jitterRadius: radius })}
          />
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
        <RadioRow
          label="持续下发坐标"
          systemImage={current.keepAlive ? "checkmark.circle.fill" : "circle"}
          selected={current.keepAlive}
          onPick={() => update({ keepAlive: !current.keepAlive })}
        />
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
    </List>
  );
}
