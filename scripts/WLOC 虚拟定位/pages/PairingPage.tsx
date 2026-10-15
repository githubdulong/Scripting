// 配对记录管理页。
//
// 记录只能由 wloc（iOS）生成：那一步要用 Bonjour 广播一个可配对主机，
// 让系统设置里出现「与 wloc 配对」，Scripting 没有这个接口。
// 所以这里只负责导入 wloc 导出的 .mobiledevicepairing（或等价的 plist / JSON）。

import {
  NavigationStack,
  VStack,
  HStack,
  Spacer,
  Text,
  Button,
  TextField,
  List,
  Section,
  Image,
  useState,
  Navigation,
} from "scripting";
import { toHex, utf8 } from "../core/bytes";
import { deletePairing, loadPairing, parsePairingFile, savePairing, type PairingRecord } from "../core/pairing";
import { probePairSetup } from "../core/session";
import { loadSettings } from "../utils/storage";

export function PairingPage() {
  const dismiss = Navigation.useDismiss();
  const [pairing, setPairing] = useState<PairingRecord | null>(() => loadPairing());
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [probing, setProbing] = useState(false);
  // 每次打开配对页都重读，保证显示的是设置页刚改过的值。
  const [settings, setSettings] = useState(() => loadSettings());

  async function runPairSetupProbe() {
    const current = loadSettings();
    setSettings(current);
    setProbing(true);
    setStatus(
      current.tunnelSource === "builtIn"
        ? "将启用 Scripting 自身的 VPN…"
        : `经代理工具连接 ${current.deviceHost}…`,
    );
    setIsError(false);
    try {
      const summary = await probePairSetup(
        { host: current.deviceHost, source: current.tunnelSource },
        setStatus,
      );
      setStatus(summary);
      setIsError(summary.includes("拒绝"));
    } catch (error) {
      setStatus(`探测失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    } finally {
      setProbing(false);
    }
  }

  function importBytes(bytes: Uint8Array) {
    try {
      const record = parsePairingFile(bytes);
      savePairing(record);
      setPairing(record);
      setStatus(`✓ 已导入：${record.deviceName || record.identifier}`);
      setIsError(false);
      setShowPaste(false);
      setPasteText("");
    } catch (error) {
      setStatus(`解析失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    }
  }

  async function importFromFile() {
    try {
      const files = await DocumentPicker.pickFiles({
        types: ["public.data", "public.item"],
      });
      if (!files || files.length === 0) return;
      // 二进制 plist 也要能读，所以按字节读而不是按字符串。
      importBytes(FileManager.readAsBytesSync(files[0]));
    } catch (error) {
      setStatus(`读取文件失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    }
  }

  async function importFromClipboard() {
    const text = await Pasteboard.getString();
    if (!text) {
      setStatus("剪贴板为空");
      setIsError(true);
      return;
    }
    importBytes(utf8(text));
  }

  function remove() {
    deletePairing();
    setPairing(null);
    setStatus("已删除配对记录");
    setIsError(false);
  }

  const statusColor = isError ? "systemRed" : status.startsWith("✓") ? "systemGreen" : "systemOrange";

  return (
    <NavigationStack>
      <List
        navigationTitle="配对管理"
        navigationBarTitleDisplayMode="inline"
        toolbar={{
          cancellationAction: <Button title="关闭" action={() => dismiss()} />,
        }}
      >
        <Section header={<Text font="caption" foregroundStyle="secondaryLabel">配对状态</Text>}>
          {pairing ? (
            <VStack alignment="leading" spacing={6}>
              <HStack>
                <Text foregroundStyle="systemGreen" font="caption">● 已配对</Text>
                <Spacer />
                <Button title="删除" action={remove} foregroundStyle="red" />
              </HStack>
              {!!pairing.deviceName && (
                <Text font="subheadline" fontWeight="semibold">{pairing.deviceName}</Text>
              )}
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                标识：{pairing.identifier}
              </Text>
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                公钥：{pairing.publicKey.length > 0 ? `${toHex(pairing.publicKey).slice(0, 16)}…` : "（未包含，不影响使用）"}
              </Text>
            </VStack>
          ) : (
            <VStack alignment="leading" spacing={4}>
              <Text foregroundStyle="systemOrange">● 未配对</Text>
              <Text font="caption" foregroundStyle="secondaryLabel">
                请先在 wloc 里完成配对，再用它的「导出配对文件」把记录导进来。
              </Text>
            </VStack>
          )}
        </Section>

        <Section
          header={<Text font="caption" foregroundStyle="secondaryLabel">在本机直接配对（实验）</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              不经 wloc、直接在这台设备上发起配对。点下去后留意屏幕上的「信任」弹窗。
              目前只验证设备允不允许，成功后才会继续实现完整的 SRP 握手。
              {"\n\n"}
              隧道来源在「设置」里改。选「Scripting 自身」会启用它的 VPN，
              从而顶掉正在运行的代理工具；选「代理工具提供」则不碰 VPN 开关。
            </Text>
          }
        >
          <HStack frame={{ maxWidth: "infinity" }} spacing={8}>
            <Image
              systemName={settings.tunnelSource === "builtIn" ? "network.badge.shield.half.filled" : "app.connected.to.app.below.fill"}
              foregroundStyle="secondaryLabel"
              frame={{ width: 20 }}
            />
            <Text font="caption" foregroundStyle="secondaryLabel">
              隧道来源：{settings.tunnelSource === "builtIn" ? "Scripting 自身" : "代理工具提供"}
            </Text>
            <Spacer />
            <Text font="caption2" foregroundStyle="tertiaryLabel">{settings.deviceHost}</Text>
          </HStack>
          <Button
            title={probing ? "探测中…" : "探测是否可直接配对"}
            action={runPairSetupProbe}
            disabled={probing}
          />
        </Section>

        <Section header={<Text font="caption" foregroundStyle="secondaryLabel">导入配对记录</Text>}>
          <Button title="从文件导入…" action={importFromFile} />
          <Button title="从剪贴板粘贴" action={importFromClipboard} />
          <Button
            title={showPaste ? "收起" : "手动粘贴文本"}
            action={() => {
              setShowPaste((value) => !value);
              setStatus("");
              setIsError(false);
            }}
          />
        </Section>

        {showPaste && (
          <Section header={<Text font="caption" foregroundStyle="secondaryLabel">粘贴内容（plist XML 或 JSON）</Text>}>
            <TextField title="" value={pasteText} onChanged={setPasteText} prompt="粘贴内容…" axis="vertical" />
            <Button title="确认导入" action={() => importBytes(utf8(pasteText))} />
          </Section>
        )}

        {!!status && (
          <Section>
            <Text font="caption" foregroundStyle={statusColor}>{status}</Text>
          </Section>
        )}

        <Section
          header={<Text font="caption" foregroundStyle="secondaryLabel">怎么拿到配对记录</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              文件里含私钥，等同于这台设备的调试授权，请勿外传。重启 iPhone 后系统侧的配对授权会失效，需要在 wloc 里重新配对并重新导出。
            </Text>
          }
        >
          <VStack alignment="leading" spacing={8}>
            <Text font="caption">1. 在 wloc 里完成「配对这台 iPhone」</Text>
            <Text font="caption">2. 配对页点「导出配对文件」，存成 wloc-pairing.mobiledevicepairing</Text>
            <Text font="caption">3. 回到这里「从文件导入」选中它</Text>
            <Text font="caption2" foregroundStyle="secondaryLabel">
              支持二进制 plist、XML plist，以及旧版脚本的 JSON 格式。
            </Text>
          </VStack>
        </Section>
      </List>
    </NavigationStack>
  );
}
