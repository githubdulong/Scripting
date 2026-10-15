// 摇杆浮层：按住朝任意方向实时移动，松手即停。
//
// 做成盖在地图上的浮层而不是面板里的控件——推着摇杆走时要能看见自己的位置，
// 面板会把整张地图盖住。

import { HStack, VStack, ZStack, Text, Image, Button, Circle, Spacer } from "scripting";

/** 摇杆半径（点），拖动位移除以它得到归一化出力。 */
const PAD_RADIUS = 52;
const KNOB_SIZE = 46;

interface JoystickPadProps {
  /** 归一化方向：右为 +x、上为 +y，模长即出力。 */
  vector: Observable<{ dx: number; dy: number }>;
  speedLabel: string;
  onStop: () => void;
}

export function JoystickPad({ vector, speedLabel, onStop }: JoystickPadProps) {
  const current = vector.value;
  // 屏幕 y 轴向下，取负才是「上为正北」。
  const knobX = current.dx * PAD_RADIUS;
  const knobY = -current.dy * PAD_RADIUS;

  // translation 是 Size（width/height），不是 Point。
  function handleDrag(translation: { width: number; height: number }) {
    let dx = translation.width / PAD_RADIUS;
    let dy = -translation.height / PAD_RADIUS;
    const magnitude = Math.sqrt(dx * dx + dy * dy);
    // 超出摇杆范围时按满出力处理，方向不变。
    if (magnitude > 1) {
      dx /= magnitude;
      dy /= magnitude;
    }
    vector.setValue({ dx, dy });
  }

  return (
    <VStack
      spacing={10}
      padding={12}
      glassEffect={{ type: "rect", cornerRadius: 22 }}
      clipShape={{ type: "rect", cornerRadius: 22 }}
    >
      <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
        <Image systemName="dpad.fill" foregroundStyle="systemBlue" font="caption" />
        <Text font="caption" foregroundStyle="secondaryLabel">{speedLabel}</Text>
        <Spacer />
        <Button action={onStop}>
          <Image systemName="stop.circle.fill" foregroundStyle="systemRed" font="title3" />
        </Button>
      </HStack>

      <ZStack
        frame={{ width: PAD_RADIUS * 2, height: PAD_RADIUS * 2 }}
        onDragGesture={{
          minDistance: 0,
          onChanged: (details) => handleDrag(details.translation),
          onEnded: () => vector.setValue({ dx: 0, dy: 0 }),
        }}
      >
        <Circle fill="rgba(120,120,128,0.18)" frame={{ width: PAD_RADIUS * 2, height: PAD_RADIUS * 2 }} />
        <Circle
          fill="systemBlue"
          frame={{ width: KNOB_SIZE, height: KNOB_SIZE }}
          offset={{ x: knobX, y: knobY }}
        />
      </ZStack>
    </VStack>
  );
}
