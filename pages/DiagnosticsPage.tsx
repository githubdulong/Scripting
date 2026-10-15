// 连接状态：逐项体检，定位「连不上」卡在哪一环。
//
// 只做到与设备握手为止，不跑 pair-verify、也不建隧道——那两步慢且有副作用
// （会在设备上开一次性监听）。

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
  useState,
  useEffect,
  Navigation,
} from "scripting";
import { collectDiagnostics, type DiagnosticItem } from "../core/session";
import { loadPairing } from "../core/pairing";
import { loadSettings } from "../utils/storage";

export function DiagnosticsPage() {
  const dismiss = Navigation.useDismiss();
  const [items, setItems] = useState<DiagnosticItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function run() {
    setBusy(true);
    setItems([]);
    try {
      const settings = loadSettings();
      const result = await collectDiagnostics({
        endpoint: { host: settings.deviceHost, source: settings.tunnelSource },
        record: loadPairing(),
        onStatus: setStatus,
      });
      setItems(result);
      setStatus("");
    } catch (error) {
      setStatus(`诊断失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void run();
  }, []);

  const failed = items.filter((item) => item.ok === false);

  return (
    <NavigationStack>
      <List
        navigationTitle="连接状态"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="关闭" action={() => dismiss()} />,
          confirmationAction: <Button title={busy ? "检测中…" : "重新检测"} disabled={busy} action={() => void run()} />,
        }}
      >
        {!!status && (
          <Section>
            <HStack spacing={8}>
              <Image systemName="hourglass" foregroundStyle="secondaryLabel" />
              <Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>
            </HStack>
          </Section>
        )}

        {items.length > 0 && (
          <Section
            header={<Text font="caption" foregroundStyle="secondaryLabel">检测结果</Text>}
            footer={
              failed.length === 0 ? (
                <Text font="caption2" foregroundStyle="tertiaryLabel">
                  各项正常。若仍连不上，多半卡在隧道握手那一步，详见 scripting-cli 终端里的日志。
                </Text>
              ) : (
                <Text font="caption2" foregroundStyle="systemOrange">
                  有 {failed.length} 项异常，从上往下第一个红叉就是断点所在。
                </Text>
              )
            }
          >
            {items.map((item, index) => (
              <HStack key={`${item.label}-${index}`} frame={{ maxWidth: "infinity" }} spacing={10}>
                <Image
                  systemName={
                    item.ok === null
                      ? "info.circle"
                      : item.ok
                        ? "checkmark.circle.fill"
                        : "xmark.circle.fill"
                  }
                  foregroundStyle={item.ok === null ? "secondaryLabel" : item.ok ? "systemGreen" : "systemRed"}
                  frame={{ width: 22 }}
                />
                <VStack alignment="leading" spacing={2}>
                  <Text font="subheadline" foregroundStyle="label">{item.label}</Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{item.value}</Text>
                </VStack>
                <Spacer />
              </HStack>
            ))}
          </Section>
        )}

        <Section
          header={<Text font="caption" foregroundStyle="secondaryLabel">连不上时先看这几条</Text>}
        >
          <VStack alignment="leading" spacing={8}>
            <Text font="caption">① 开发者模式要开着（设置 → 隐私与安全性 → 开发者模式）</Text>
            <Text font="caption">② iPhone 重启后系统侧的配对授权会失效，要在 wloc 里重新配对并重新导出</Text>
            <Text font="caption">③ iOS 同时只允许一条 VPN 生效，代理和 Scripting 自身的隧道会互相顶掉</Text>
            <Text font="caption">④ 选「代理工具提供」时，代理那边要把 tun 的 loopback-address 配成对端地址</Text>
          </VStack>
        </Section>
      </List>
    </NavigationStack>
  );
}
