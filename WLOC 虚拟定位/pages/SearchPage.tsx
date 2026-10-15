// 地点搜索：国内走 MapKit，开「全球」则走中转服务搜境外地点。
//
// 国内模式边打边搜；全球模式要点「搜索」才发请求——中转服务有频率限制，
// 每敲一个字就发一次会很快撞上限。

import {
  NavigationStack,
  List,
  Section,
  VStack,
  HStack,
  Spacer,
  Text,
  Button,
  TextField,
  Image,
  Toggle,
  useState,
  Navigation,
} from "scripting";
import { searchGlobalPlaces, searchPlaces, translateForSearch, type SearchResult } from "../api/searchApi";
import type { Coordinate } from "../types";

interface SearchPageProps {
  globalEndpoint: string;
  onPick: (coordinate: Coordinate, name: string) => void;
}

export function SearchPage({ globalEndpoint, onPick }: SearchPageProps) {
  const dismiss = Navigation.useDismiss();
  const [query, setQuery] = useState("");
  const [global, setGlobal] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function runSearch(text: string, useGlobal: boolean) {
    const trimmed = text.trim();
    if (!trimmed) {
      setResults([]);
      setStatus("");
      return;
    }

    setBusy(true);
    try {
      let found: SearchResult[];
      if (useGlobal) {
        // 中文搜境外几乎搜不到，先翻成英文。
        const { text, translated } = await translateForSearch(trimmed);
        if (translated) setStatus(`已翻译为「${text}」`);
        found = await searchGlobalPlaces(text, globalEndpoint);
      } else {
        found = await searchPlaces(trimmed);
      }
      setResults(found);
      setStatus(found.length === 0 ? "没有找到匹配的地点" : "");
    } catch (error) {
      setResults([]);
      setStatus(`搜索失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function handleChanged(text: string) {
    setQuery(text);
    // 全球模式交给「搜索」按钮，省请求。
    if (!global) void runSearch(text, false);
  }

  function handleToggleGlobal(value: boolean) {
    setGlobal(value);
    setResults([]);
    setStatus(value ? "输入后点「搜索」" : "");
    if (!value && query.trim()) void runSearch(query, false);
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="搜索地点"
        navigationBarTitleDisplayMode="inline"
        toolbar={{ cancellationAction: <Button title="关闭" action={() => dismiss()} /> }}
      >
        <Section
          footer={
            <Text font="caption2" foregroundStyle="tertiaryLabel">
              国内 iPhone 的地图数据源是高德，搜不到境外地点；开「全球」会改用中转服务查询
              OpenStreetMap，适合搜国外的地名。
            </Text>
          }
        >
          <TextField
            title=""
            value={query}
            onChanged={handleChanged}
            prompt={global ? "输入境外地点，如 Eiffel Tower" : "输入地点名称"}
            onSubmit={() => void runSearch(query, global)}
          />
          <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
            <Image systemName="globe" foregroundStyle={global ? "systemBlue" : "secondaryLabel"} frame={{ width: 22 }} />
            <Text foregroundStyle="label">全球</Text>
            <Spacer />
            <Toggle title="" value={global} toggleStyle="switch" onChanged={handleToggleGlobal} />
          </HStack>
          {global ? (
            <Button
              title={busy ? "搜索中…" : "搜索"}
              systemImage="magnifyingglass"
              disabled={busy || query.trim().length < 2}
              action={() => void runSearch(query, true)}
            />
          ) : null}
        </Section>

        {!!status && (
          <Section>
            <Text font="caption" foregroundStyle="secondaryLabel">{status}</Text>
          </Section>
        )}

        {results.length > 0 && (
          <Section header={<Text font="caption" foregroundStyle="secondaryLabel">搜索结果</Text>}>
            {results.map((item, index) => (
              <Button
                key={`${item.name}-${index}`}
                action={() => {
                  onPick(item.coordinate, item.name);
                  dismiss();
                }}
              >
                <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
                  <Image systemName="mappin.circle.fill" foregroundStyle="systemRed" frame={{ width: 22 }} />
                  <VStack alignment="leading" spacing={2}>
                    <Text foregroundStyle="label">{item.name || "未命名地点"}</Text>
                    {!!item.address && (
                      <Text font="caption2" foregroundStyle="secondaryLabel">{item.address}</Text>
                    )}
                  </VStack>
                  <Spacer />
                </HStack>
              </Button>
            ))}
          </Section>
        )}
      </List>
    </NavigationStack>
  );
}
