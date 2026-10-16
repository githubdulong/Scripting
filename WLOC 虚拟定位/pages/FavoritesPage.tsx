// 收藏与历史：收藏可左滑删除，历史自动记录最近选过的点。
// 参考项目历史管理器的 trailingSwipeActions + Dialog.actionSheet 模式。

import {
  NavigationStack,
  List,
  HStack,
  VStack,
  Text,
  Button,
  Section,
  Image,
  Spacer,
  ContentUnavailableView,
} from "scripting";
import type { Coordinate, FavoriteLocation, ActiveLocation } from "../types";


interface FavoritesPageProps {
  favorites: FavoriteLocation[];
  history: FavoriteLocation[];
  active: ActiveLocation | null;
  onPick: (coord: Coordinate, name: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClearHistory: () => void;
}

export function FavoritesPage({
  favorites,
  history,
  active,
  onPick,
  onDelete,
  onClearAll,
  onClearHistory,
}: FavoritesPageProps) {
  // 左滑删除确认（参考项目历史管理器 Dialog.actionSheet 模式）
  async function handleDeleteFav(fav: FavoriteLocation) {
    const index = await Dialog.actionSheet({
      title: "删除确认",
      message: `确定删除收藏「${fav.name}」？`,
      actions: [
        { label: "取消" },
        { label: "删除", destructive: true },
      ],
      cancelButton: false,
    });
    if (index === 1) {
      onDelete(fav.id);
    }
  }

  // 清空全部确认
  async function handleClearAll() {
    const index = await Dialog.actionSheet({
      title: "清空确认",
      message: `确定清空全部 ${favorites.length} 项收藏？此操作不可恢复。`,
      actions: [
        { label: "取消" },
        { label: "清空全部", destructive: true },
      ],
      cancelButton: false,
    });
    if (index === 1) {
      onClearAll();
    }
  }

  return (
    <NavigationStack>
      <List navigationTitle="收藏与历史" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
        {favorites.length === 0 ? (
          /*
            空状态交给系统组件，别手搓。

            原先是 Image + 两行 Text 自己叠的，字号、灰阶、间距全是写死的常量——
            换了动态字号或深色模式就得各自再调一遍。ContentUnavailableView 是
            系统为这个场景提供的标准件，这些它自己会处理。

            注意**不要**挂到 List 的 overlay 上（官方示例那种写法）：那会盖住整个
            列表，而这一页没有收藏时下面还有「历史」要显示。
          */
          <Section>
            <ContentUnavailableView
              title="暂无收藏"
              systemImage="star"
              description="在地图上选好位置后点击「收藏」"
            />
          </Section>
        ) : (
          <Section
            header={
              <HStack frame={{ maxWidth: "infinity" }}>
                <Text>{`共 ${favorites.length} 项`}</Text>
                <Spacer />
                <Button action={handleClearAll}>
                  <Text foregroundStyle="systemRed" font="subheadline">清空全部</Text>
                </Button>
              </HStack>
            }
          >
            {favorites.map((fav) => {
              const isActive =
                active != null &&
                Math.abs(fav.longitude - active.longitude) < 1e-6 &&
                Math.abs(fav.latitude - active.latitude) < 1e-6;
              return (
                <Button
                  key={fav.id}
                  action={() => onPick({ latitude: fav.latitude, longitude: fav.longitude }, fav.name)}
                  trailingSwipeActions={{
                    allowsFullSwipe: false,
                    actions: [
                      <Button
                        title="删除"
                        systemImage="trash"
                        tint="systemRed"
                        action={() => handleDeleteFav(fav)}
                      />
                    ],
                  }}
                >
                  <HStack spacing={20} padding={{ vertical: 4 }}>
                    <Image
                      systemName="star.fill"
                      foregroundStyle="systemYellow"
                      font={20}
                    />
                    <VStack alignment="leading" spacing={2}>
                      <Text foregroundStyle="label" font="body">{fav.name}</Text>
                      <Text font="caption" foregroundStyle="tertiaryLabel">
                        {fav.latitude.toFixed(6)}, {fav.longitude.toFixed(6)}
                      </Text>
                    </VStack>
                    {isActive ? (
                      <Spacer />
                    ) : null}
                    {isActive ? (
                      <HStack spacing={4}>
                        <Image systemName="checkmark.circle.fill" foregroundStyle="systemGreen" font="caption" />
                        <Text foregroundStyle="systemGreen" font="caption">生效中</Text>
                      </HStack>
                    ) : null}
                  </HStack>
                </Button>
              );
            })}
          </Section>
        )}

        {history.length > 0 ? (
          <Section
            header={
              <HStack frame={{ maxWidth: "infinity" }}>
                <Text>{`最近 ${history.length} 条`}</Text>
                <Spacer />
                <Button action={onClearHistory}>
                  <Text foregroundStyle="systemRed" font="subheadline">清空历史</Text>
                </Button>
              </HStack>
            }
            footer={
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                搜索、解析链接或在地图上选点都会记入历史，同一地点只留最新一条。
              </Text>
            }
          >
            {history.map((item) => (
              <Button
                key={item.id}
                action={() => onPick({ latitude: item.latitude, longitude: item.longitude }, item.name)}
              >
                <HStack spacing={20} padding={{ vertical: 4 }}>
                  <Image systemName="clock.arrow.circlepath" foregroundStyle="secondaryLabel" font={20} />
                  <VStack alignment="leading" spacing={2}>
                    <Text foregroundStyle="label" font="body">{item.name}</Text>
                    <Text font="caption" foregroundStyle="tertiaryLabel">
                      {item.latitude.toFixed(6)}, {item.longitude.toFixed(6)}
                    </Text>
                  </VStack>
                  <Spacer />
                </HStack>
              </Button>
            ))}
          </Section>
        ) : null}
      </List>
    </NavigationStack>
  );
}
