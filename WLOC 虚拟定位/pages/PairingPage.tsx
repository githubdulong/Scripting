// 配对记录管理页。
//
// 两条路：
//   1. 「配对这台设备」——脚本自己起一个 TCP 监听、用 Bonjour 广播成可配对主机，
//      系统设置里就会出现它，输入这里显示的 PIN 完成 SRP 握手。
//   2. 「导入配对记录」——用 wloc 导出的 .mobiledevicepairing（或等价的 plist / JSON）。
//
// 新记录要先独立跑通一次 pair-verify 才会覆盖钥匙串里的旧记录：配对途中任何一步
// 出错都可能留下一份连不上的记录，直接覆盖会把原本能用的那份弄丢。

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
import { createHostIdentity, createPIN, pairThisDevice } from "../core/pair_setup";
import { verifyPairingRecord } from "../core/session";
import { loadSettings } from "../utils/storage";

export function PairingPage() {
  const dismiss = Navigation.useDismiss();
  const [pairing, setPairing] = useState<PairingRecord | null>(() => loadPairing());
  const [status, setStatus] = useState("");
  const [isError, setIsError] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [pin, setPin] = useState("");
  const [pairingInProgress, setPairingInProgress] = useState(false);

  /**
   * 在本机直接配对。
   *
   * 广播期间要切到「设置」去输 PIN，脚本会被切到后台——所以整段流程
   * 需要后台保活撑着，否则一离开应用监听就断了。
   */
  async function startDevicePairing() {
    setPairingInProgress(true);
    setIsError(false);
    let lease = false;
    try {
      const host = await createHostIdentity();
      const code = createPIN();
      setPin(code);
      setStatus("正在启动配对广播…");

      try {
        await BackgroundKeeper.keepAlive();
        lease = true;
      } catch {
        // 没有后台保活也能试，只是切走后更容易被系统回收。
      }

      const record = await pairThisDevice(host, code, setStatus);

      // 独立验证一次：这一步过了才算这份记录真的能用。
      setStatus("验证新配对记录…");
      const current = loadSettings();
      await verifyPairingRecord(
        record,
        { host: current.deviceHost, source: current.tunnelSource },
        setStatus,
      );

      savePairing(record);
      setPairing(record);
      setStatus("✓ 配对完成");
    } catch (error) {
      setStatus(`配对失败：${error instanceof Error ? error.message : String(error)}`);
      setIsError(true);
    } finally {
      if (lease) await BackgroundKeeper.stopKeepAlive().catch(() => undefined);
      setPin("");
      setPairingInProgress(false);
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
          header={<Text font="caption" foregroundStyle="secondaryLabel">配对这台设备</Text>}
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              不经 wloc，直接在这台设备上配对。点下去后会生成一个六位 PIN 并把本机
              广播成可配对主机，然后前往
              {"「设置 → 隐私与安全 → 开发者 → 配对」"}
              ，在列表里选 Scripting WLOC 并输入 PIN。
              {"\n\n"}
              离开应用期间靠后台保活维持广播，广播三分钟后自动结束。
              新记录只有独立验证通过后才会覆盖已有记录。
            </Text>
          }
        >
          {pin ? (
            <VStack alignment="leading" spacing={6} padding={{ vertical: 4 }}>
              <Text font="caption" foregroundStyle="secondaryLabel">配对 PIN</Text>
              <Text font="largeTitle" fontWeight="bold" fontDesign="monospaced" foregroundStyle="systemBlue">
                {pin}
              </Text>
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                记下它，去设置里输入。离开这一页 PIN 就没了，要重新开始。
              </Text>
            </VStack>
          ) : null}
          <Button
            title={pairingInProgress ? "等待在设置中输入 PIN…" : "配对这台设备"}
            systemImage="personalhotspot"
            action={startDevicePairing}
            disabled={pairingInProgress}
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
