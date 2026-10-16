// 移动面板：选移动方式与速度，规划路线、导入 GPX、启动摇杆。
//
// 路线与 GPX 最终都归成同一样东西——一串坐标，交给 PathWalker 匀速推进；
// 摇杆则没有预设路径，由手指实时给方向。

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
  Slider,
  useState,
  Navigation,
} from "scripting";
import {
  LAP_OPTIONS,
  MOVEMENT_MODES,
  customSpeed,
  customSpeedRange,
  defaultSpeed,
  isCustomSpeed,
  modeInfo,
  type LapPlan,
  type MovementMode,
  type MovementSpeed,
} from "../core/movement";

export interface MovementSelection {
  mode: MovementMode;
  speed: MovementSpeed;
  lapPlan: LapPlan;
}

interface MovementPanelProps {
  initial: MovementSelection;
  /** 已规划出的方案，空数组表示还没规划。 */
  routes: { label: string; detail: string }[];
  selectedRouteIndex: number;
  onSelectRoute: (index: number) => void;
  hasDestination: boolean;
  /** 起点说明：未手动指定时显示「当前真实位置」。 */
  startLabel: string;
  /** 手绘路径已选的点数。 */
  drawnCount: number;
  onPlanRoute: (selection: MovementSelection) => Promise<void>;
  onStartRoute: (selection: MovementSelection) => void;
  onImportGPX: (selection: MovementSelection) => Promise<void>;
  onStartJoystick: (selection: MovementSelection) => void;
  onUseSelectionAsStart: () => void;
  onResetStart: () => void;
  /** 进入手绘模式：面板收起，之后点地图就是落点。 */
  onBeginDrawing: () => void;
  onAddDrawnPoint: () => void;
  onUndoDrawnPoint: () => void;
  onClearDrawnPath: () => void;
  onStartDrawnPath: (selection: MovementSelection) => void;
}

export function MovementPanel({
  initial,
  routes,
  selectedRouteIndex,
  onSelectRoute,
  hasDestination,
  startLabel,
  drawnCount,
  onPlanRoute,
  onStartRoute,
  onImportGPX,
  onStartJoystick,
  onUseSelectionAsStart,
  onResetStart,
  onBeginDrawing,
  onAddDrawnPoint,
  onUndoDrawnPoint,
  onClearDrawnPath,
  onStartDrawnPath,
}: MovementPanelProps) {
  const dismiss = Navigation.useDismiss();
  const [mode, setMode] = useState<MovementMode>(initial.mode);
  const [speed, setSpeed] = useState<MovementSpeed>(initial.speed);
  const [lapPlan, setLapPlan] = useState<LapPlan>(initial.lapPlan);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const selection = (): MovementSelection => ({ mode, speed, lapPlan });

  /**
   * 换方式时速度要跟着换——各方式的档位不通用。
   *
   * 自定义速度则保留，但夹进新方式的范围：从驾车 120 km/h 切到步行，
   * 不夹的话就成了「步行 120 km/h」。
   */
  function handleMode(next: MovementMode) {
    setMode(next);
    if (isCustomSpeed(speed)) {
      const range = customSpeedRange(next);
      const kmh = Math.min(range.max, Math.max(range.min, speed.metresPerSecond * 3.6));
      setSpeed(customSpeed(kmh));
    } else {
      setSpeed(defaultSpeed(next));
    }
  }

  async function run(task: () => Promise<void>, label: string) {
    setBusy(true);
    setStatus(label);
    try {
      await task();
      setStatus("");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      /*
        失败必须弹窗。

        状态条渲染在 List 最底部，而触发按钮分散在中间——面板一长，
        用户点完根本看不到那行红字，体感就是「点了没反应」。

        这里保留系统 alert，没跟着主界面换成 MessageSheet：这个面板自己就活在
        一个 sheet 里，再叠一层 sheet 会把它整个盖住，反而更难读。
      */
      await Dialog.alert({ title: "操作失败", message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="移动"
        navigationBarTitleDisplayMode="inline"
        toolbar={{ cancellationAction: <Button title="关闭" action={() => dismiss()} /> }}
      >
        <Section header={<Text>移动方式</Text>}>
          {MOVEMENT_MODES.map((item) => (
            <Button key={item.key} action={() => handleMode(item.key)}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
                <Image
                  systemName={item.systemImage}
                  foregroundStyle={mode === item.key ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 24 }}
                />
                <Text foregroundStyle="label">{item.label}</Text>
                <Spacer />
                {mode === item.key ? (
                  <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
                ) : null}
              </HStack>
            </Button>
          ))}
        </Section>

        <Section header={<Text>速度</Text>}>
          {modeInfo(mode).speeds.map((item) => (
            <Button key={item.title} action={() => setSpeed(item)}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
                <Image
                  systemName="speedometer"
                  foregroundStyle={speed.metresPerSecond === item.metresPerSecond ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 24 }}
                />
                <Text foregroundStyle="label">{item.title}</Text>
                <Spacer />
                <Text font="caption" foregroundStyle="secondaryLabel">
                  {(item.metresPerSecond * 3.6).toFixed(1)} km/h
                </Text>
                {speed.metresPerSecond === item.metresPerSecond ? (
                  <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
                ) : null}
              </HStack>
            </Button>
          ))}
        </Section>

        <Section
          header={<Text>自定义速度</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              拖动即切换到自定义。范围按移动方式各不相同——步行拉到 200 km/h 没有意义。
            </Text>
          }
        >
          <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
            <Image
              systemName="slider.horizontal.3"
              foregroundStyle={isCustomSpeed(speed) ? "systemBlue" : "secondaryLabel"}
              frame={{ width: 24 }}
            />
            <Text foregroundStyle="label">自定义</Text>
            <Spacer />
            <Text
              font="caption"
              fontWeight={isCustomSpeed(speed) ? "semibold" : "regular"}
              foregroundStyle={isCustomSpeed(speed) ? "systemBlue" : "secondaryLabel"}
            >
              {(speed.metresPerSecond * 3.6).toFixed(1)} km/h
            </Text>
            {isCustomSpeed(speed) ? (
              <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
            ) : null}
          </HStack>
          <Slider
            value={Math.min(
              customSpeedRange(mode).max,
              Math.max(customSpeedRange(mode).min, speed.metresPerSecond * 3.6),
            )}
            min={customSpeedRange(mode).min}
            max={customSpeedRange(mode).max}
            step={customSpeedRange(mode).step}
            onChanged={(value: number) => setSpeed(customSpeed(value))}
            label={<Text>速度</Text>}
            minValueLabel={
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                {customSpeedRange(mode).min}
              </Text>
            }
            maxValueLabel={
              <Text font="caption2" foregroundStyle="tertiaryLabel">
                {customSpeedRange(mode).max}
              </Text>
            }
          />
        </Section>

        <Section
          header={<Text>往返</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              到达终点后原路折返。路线是单向的，重复只能折返——直接把位置传送回起点会产生坐标跳变。
            </Text>
          }
        >
          {LAP_OPTIONS.map((item) => (
            <Button key={item.id} action={() => setLapPlan(item.id)}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
                <Image
                  systemName="arrow.triangle.2.circlepath"
                  foregroundStyle={lapPlan === item.id ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 24 }}
                />
                <Text foregroundStyle="label">{item.label}</Text>
                <Spacer />
                {lapPlan === item.id ? (
                  <Image systemName="checkmark" foregroundStyle="systemBlue" font="body" />
                ) : null}
              </HStack>
            </Button>
          ))}
        </Section>

        <Section
          header={<Text>沿路线移动</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              终点取地图上选中的点。起点默认是当前真实位置，也可以把选中的点设成起点——
              需要模拟「从甲地走到乙地」时用得上。
              {routes.length > 1 ? "\n规划出多条方案时可任选一条，地图上浅色的是备选。" : ""}
            </Text>
          }
        >
          <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
            <Image systemName="smallcircle.filled.circle" foregroundStyle="systemGreen" frame={{ width: 24 }} />
            <Text foregroundStyle="label">起点</Text>
            <Spacer />
            <Text font="caption" foregroundStyle="secondaryLabel">{startLabel}</Text>
          </HStack>
          <Button
            title="把选中的点设为起点"
            systemImage="mappin.and.ellipse"
            disabled={!hasDestination}
            action={onUseSelectionAsStart}
          />
          <Button title="起点改回当前位置" systemImage="location" action={onResetStart} />
          <Button
            title={busy ? "规划中…" : "规划路线"}
            systemImage="point.topleft.down.to.point.bottomright.curvepath"
            disabled={busy || !hasDestination}
            action={() => void run(() => onPlanRoute(selection()), "规划路线中…")}
          />
          {routes.map((item, index) => (
            <Button key={`${item.label}-${index}`} action={() => onSelectRoute(index)}>
              <HStack frame={{ maxWidth: "infinity" }} spacing={10}>
                <Image
                  systemName={index === selectedRouteIndex ? "checkmark.circle.fill" : "circle"}
                  foregroundStyle={index === selectedRouteIndex ? "systemBlue" : "secondaryLabel"}
                  frame={{ width: 24 }}
                />
                <VStack alignment="leading" spacing={2}>
                  <Text foregroundStyle="label">{item.label}</Text>
                  <Text font="caption2" foregroundStyle="secondaryLabel">{item.detail}</Text>
                </VStack>
                <Spacer />
              </HStack>
            </Button>
          ))}
          {routes.length > 0 ? (
            <Button
              title="沿这条路线移动"
              systemImage="play.fill"
              disabled={busy}
              action={() => {
                onStartRoute(selection());
                dismiss();
              }}
            />
          ) : null}
        </Section>

        <Section
          header={<Text>其他方式</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              GPX 轨迹按所选速度重走，不跟文件里记录的原速。摇杆以当前选中的坐标为起点。
            </Text>
          }
        >
          <Button
            title={busy ? "读取中…" : "导入 GPX 轨迹"}
            systemImage="point.topleft.filled.down.to.point.bottomright.curvepath"
            disabled={busy}
            action={() => void run(async () => {
              await onImportGPX(selection());
              dismiss();
            }, "读取 GPX…")}
          />
          <Button
            title="启动摇杆"
            systemImage="dpad"
            disabled={busy}
            action={() => {
              onStartJoystick(selection());
              dismiss();
            }}
          />
        </Section>

        <Section
          header={<Text>手绘路径</Text>}
          footer={
            <Text foregroundStyle="tertiaryLabel">
              自己点一条路线出来，走法不受道路限制——拉直线穿楼、绕圈都行。
              点「在地图上取点」后面板收起，之后在地图上点一下就落一个点，
              按顺序标号连成折线；地图上那条操作条可以撤销、清空和收笔。
              已有 {drawnCount} 个点，至少两个才能开始。
            </Text>
          }
        >
          <Button
            title="在地图上取点"
            systemImage="scribble.variable"
            disabled={busy}
            action={() => {
              onBeginDrawing();
              dismiss();
            }}
          />
          <Button
            title="添加选中的点"
            systemImage="plus.circle"
            disabled={busy}
            action={onAddDrawnPoint}
          />
          {drawnCount > 0 ? (
            <Button title="撤销上一个点" systemImage="arrow.uturn.backward" action={onUndoDrawnPoint} />
          ) : null}
          {drawnCount > 0 ? (
            <Button title="清空手绘路径" systemImage="trash" foregroundStyle="red" action={onClearDrawnPath} />
          ) : null}
          {drawnCount >= 2 ? (
            <Button
              title="沿手绘路径移动"
              systemImage="play.fill"
              disabled={busy}
              action={() => {
                onStartDrawnPath(selection());
                dismiss();
              }}
            />
          ) : null}
        </Section>

        {!!status && (
          <Section>
            <Text font="caption" foregroundStyle="systemOrange">{status}</Text>
          </Section>
        )}
      </List>
    </NavigationStack>
  );
}
