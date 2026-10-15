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
import { collectDiagnostics, probeTunnelTls, type DiagnosticItem } from "../core/session";
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

  /**
   * TLS-PSK 取证。
   *
   * 会消费掉一次性的隧道监听，跑完要重新配对握手才能开模拟——所以做成按钮，
   * 而且先问一句。只有排查「隧道建不起来」时才需要它。
   */
  async function runTlsProbe() {
    const record = loadPairing();
    if (!record) {
      setStatus("没有配对记录，无法探测");
      return;
    }
    const ok = await Dialog.confirm({
      title: "跑一次 TLS 取证？",
      message:
        "会向设备申请一个一次性的隧道监听并把它用掉。\n" +
        "跑完这次，本次会话要重新配对握手才能开始模拟。\n\n" +
        "只有在「建立加密隧道失败」时才需要它。",
      confirmLabel: "开始探测",
      cancelLabel: "取消",
    });
    if (!ok) return;

    setBusy(true);
    try {
      const settings = loadSettings();
      const detail = await probeTunnelTls(
        record,
        { host: settings.deviceHost, source: settings.tunnelSource },
        setStatus,
      );
      setStatus(`TLS 探测：${detail}`);
    } catch (error) {
      setStatus(`探测失败：${error instanceof Error ? error.message : String(error)}`);
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
          header={<Text font="caption" foregroundStyle="secondaryLabel">进阶取证</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              只在「建立加密隧道失败」时才需要。向设备要一个隧道监听并自己发一个
              TLS 1.2 ClientHello：回 ServerHello 说明设备侧是好的，问题在客户端；
              回 Alert 则带着设备的拒绝原因。
              {"\n\n"}
              会用掉那个一次性监听，跑完要重新配对握手才能开始模拟。
            </Text>
          }
        >
          <Button
            title={busy ? "进行中…" : "跑一次 TLS 取证"}
            systemImage="stethoscope.circle"
            disabled={busy}
            action={() => void runTlsProbe()}
          />
        </Section>

        <Section
          header={<Text font="caption" foregroundStyle="secondaryLabel">连不上时先看这几条</Text>}
        >
          <VStack alignment="leading" spacing={8}>
            <Text font="caption">① 开发者模式要开着（设置 → 隐私与安全性 → 开发者模式）</Text>
            <Text font="caption">② iPhone 重启后系统侧的配对授权会失效，去「配对」页重新配一次（不必重启脚本）</Text>
            <Text font="caption">③ iOS 同时只允许一条 VPN 生效，代理和 Scripting 自身的隧道会互相顶掉</Text>
            <Text font="caption">④ 选「代理工具提供」时，代理那边要把 tun 的 loopback-address 配成对端地址</Text>
          </VStack>
        </Section>
      </List>
    </NavigationStack>
  );
}
