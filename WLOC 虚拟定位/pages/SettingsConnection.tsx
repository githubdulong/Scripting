// 设置子页：对端地址与代理工具的回环模块。
//
// 和主页上的「隧道来源」是一套——来源选定之后，这两项才有意义，而且装好就不再动。
// 放主页只会让每次进设置的人都滚过它们。

import { List, Section, HStack, Text, Button, Image, Spacer, TextField, DisclosureGroup, useState } from "scripting";
import type { AppSettings } from "../types";
import { DEFAULT_DEVICE_HOST, LOOPBACK_MODULE_LOON, LOOPBACK_MODULE_SURGE } from "../constants";

export function SettingsConnection({
  current,
  update,
}: {
  current: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}) {
  const [moduleOpen, setModuleOpen] = useState(false);
  /** 复制成功后的一行提示，显示在模块那一节的 footer 里。 */
  const [copied, setCopied] = useState("");

  /**
   * 复制行：点一下把地址放进剪贴板。
   *
   * 模块地址是给代理工具用的，在 Safari 里打开只会看到一堆配置文本，
   * 还得自己全选复制——直接复制才是想要的那个动作。
   */
  function copyRow(title: string, url: string, systemImage: string) {
    return (
      <Button
        action={() => {
          Pasteboard.setString(url);
          setCopied(`✓ 已复制 ${title} 的地址，去代理工具里新建模块粘贴即可`);
        }}
      >
        <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
          <Image systemName={systemImage} foregroundStyle="systemBlue" frame={{ width: 22 }} />
          <Text foregroundStyle="label">{title}</Text>
          <Spacer />
          <Image systemName="doc.on.doc" foregroundStyle="tertiaryLabel" font="caption" />
        </HStack>
      </Button>
    );
  }

  return (
    <List navigationTitle="连接设置" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
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
            {copied ? `\n\n${copied}` : ""}
          </Text>
        }
      >
        <DisclosureGroup
          title="模块地址"
          isExpanded={moduleOpen}
          onChanged={(value: boolean) => setModuleOpen(value)}
        >
          {copyRow("Loon 模块（.lpx）", LOOPBACK_MODULE_LOON, "l.circle")}
          {copyRow("Surge 模块（.sgmodule）", LOOPBACK_MODULE_SURGE, "s.circle")}
        </DisclosureGroup>
      </Section>
    </List>
  );
}
