// 关于：原理、限制、致谢、责任声明。

import {
  NavigationStack,
  List,
  Section,
  VStack,
  HStack,
  Spacer,
  Text,
  Button,
  Image,
  Navigation,
} from "scripting";
import { WORKER_SOURCE_URL } from "../constants";

/** 界面基座：本脚本的 UI 是在这份脚本上改出来的。 */
const UI_BASE_URL = "https://github.com/BlackCCCat/Scripting-Scripts";
const WLOC_URL = "https://github.com/ios151/wloc";
const IDEVICE_URL = "https://github.com/jkcoxson/idevice";
const PMD3_URL = "https://github.com/doronz88/pymobiledevice3";

export function AboutPage() {
  const dismiss = Navigation.useDismiss();

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

  return (
    <NavigationStack>
      <List
        navigationTitle="关于"
        navigationBarTitleDisplayMode="inline"
        toolbar={{ cancellationAction: <Button title="关闭" action={() => dismiss()} /> }}
      >
        <Section header={<Text>工作原理</Text>}>
          <VStack alignment="leading" spacing={8}>
            <Text font="caption">
              用苹果官方的开发者接口模拟本机定位，与 Xcode 的 Simulate Location 走同一套机制，
              不涉及证书、代理改写或系统文件。
            </Text>
            <Text font="caption2" foregroundStyle="secondaryLabel">
              本机自配对（RemotePairing）→ 经回环隧道连到自己 → TLS-PSK 加密隧道 →
              RSD 查服务 → DVT 的位置模拟服务下发坐标
            </Text>
            <Text font="caption2" foregroundStyle="secondaryLabel">
              改定位要通过系统的开发者通道，而那个通道只听本机地址，所以需要一条把流量在设备内部
              闭合的回环隧道——它由 Scripting 自身或代理工具提供。
            </Text>
          </VStack>
        </Section>

        <Section header={<Text>已知限制</Text>}>
          <VStack alignment="leading" spacing={10}>
            <VStack alignment="leading" spacing={2}>
              <Text font="caption" fontWeight="semibold">金融类应用无法改位置</Text>
              <Text font="caption2" foregroundStyle="secondaryLabel">
                系统会给模拟位置打 isSimulatedBySoftware 标记，银行、保险等据此拒绝；
                加上开发者模式本身即是风控信号。这属于系统机制，本项目不绕过。
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={2}>
              <Text font="caption" fontWeight="semibold">首次配对要去系统设置输 PIN</Text>
              <Text font="caption2" foregroundStyle="secondaryLabel">
                脚本会把本机广播成可配对主机，但 PIN 只能在
                「设置 → 隐私与安全 → 开发者 → 配对」里输入，这一步系统不允许代劳。
                也可以继续用 wloc 导出的记录。
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={2}>
              <Text font="caption" fontWeight="semibold">重启后需要重新配对</Text>
              <Text font="caption2" foregroundStyle="secondaryLabel">
                iOS 的配对授权是内存态，iPhone 重启后即失效。此时本地记录还在、握手也能过，
                但建隧道会失败——重新配一次即可。
              </Text>
            </VStack>
            <VStack alignment="leading" spacing={2}>
              <Text font="caption" fontWeight="semibold">同时只能有一条 VPN</Text>
              <Text font="caption2" foregroundStyle="secondaryLabel">
                用 Scripting 自身的隧道会顶掉正在跑的代理工具；反过来也一样。
                可在设置里切换隧道来源。
              </Text>
            </VStack>
          </VStack>
        </Section>

        <Section
          header={<Text>致谢与来源</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              界面沿用 BlackCCCat 的同名 Scripting 脚本；协议层按 wloc for iOS 重写，
              去掉了原先的证书代理那一套。
            </Text>
          }
        >
          {link("BlackCCCat（界面基座）", UI_BASE_URL, "paintbrush.pointed.fill")}
          {link("wloc for iOS", WLOC_URL, "location.fill")}
          {link("idevice（协议参考）", IDEVICE_URL, "chevron.left.forwardslash.chevron.right")}
          {link("pymobiledevice3（协议参考）", PMD3_URL, "chevron.left.forwardslash.chevron.right")}
          {link("全球搜索 Worker", WORKER_SOURCE_URL, "globe")}
        </Section>

        <Section
          header={<Text>责任声明</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              脚本只在你自己拥有并控制的设备上运行，不上传任何位置、搜索或配对数据。
              配对记录存于钥匙串，仅本机可读。
            </Text>
          }
        >
          <VStack alignment="leading" spacing={8}>
            <Text font="caption">
              位置模拟会影响所有依赖系统定位的应用。使用导航、紧急呼叫、交通出行或位置共享之前，
              请务必先恢复真实位置。
            </Text>
            <Text font="caption" foregroundStyle="systemOrange">
              请勿用于误导他人、伪造证据、获取无权使用的服务，或违反任何第三方服务的规则。
            </Text>
          </VStack>
        </Section>
      </List>
    </NavigationStack>
  );
}
