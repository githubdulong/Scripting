// WLOC 虚拟定位 —— Scripting 应用上的本机定位模拟脚本
// Copyright (C) 2026 ios151
//
// 本程序是自由软件：你可以依据自由软件基金会发布的 GNU 通用公共许可证
// （第 3 版或任何后续版本）条款重新分发和/或修改它。
//
// 分发本程序是希望它能派上用场，但不提供任何担保；甚至不包含适销性或
// 特定用途适用性的默示担保。详见 GNU 通用公共许可证。
//
// 你应当已随本程序收到一份 GNU 通用公共许可证副本（见 LICENSE）；
// 如果没有，请见 <https://www.gnu.org/licenses/>。

// 分享表单 / 快捷指令入口。
//
// 在地图 App 里共享一个地点，选中本脚本，就从这里开始跑——**不是 index.tsx**。
// 要出现在那张分享表单里，两样缺一不可：
//
//   1. `script.json` 里声明 `intentInputTypes`（这里是 ["URLs", "Text"]）
//   2. 本文件存在，文件名必须是 `intent.tsx`，与 index.tsx 同级
//
// 只声明不建文件，脚本照样不会被列出来。
//
// 系统递过来的东西放在 `Intent.urlsParameter` / `Intent.textsParameter` 里：
// 苹果地图共享位置给的是 maps.apple.com 链接，有些 App 给的是一段带坐标的文本，
// 所以两样都收。解析复用「粘贴地图链接」那条路，苹果 / Google / 高德 / 百度的
// 链接和裸坐标都认，境内外坐标系换算也在里面。

import { Intent, Navigation, Script } from "scripting";
import { App } from "./index";
import { parseAndConvert } from "./utils/coords";

/** 取第一个有内容的输入。一次分享多个地点没有意义，只认头一个。 */
function sharedInput(): string {
  return Intent.urlsParameter?.[0]?.trim() || Intent.textsParameter?.[0]?.trim() || "";
}

async function run() {
  const raw = sharedInput();
  if (!raw) {
    // 带文字退出：快捷指令那边能拿到这句，分享表单上则是一闪而过。
    Script.exit(Intent.text("没有收到可识别的内容。请从地图共享一个位置，或分享一段含经纬度的文本。"));
    return;
  }

  let shared: { latitude: number; longitude: number; name?: string };
  try {
    const result = await parseAndConvert(raw);
    shared = { latitude: result.latitude, longitude: result.longitude, name: result.name };
  } catch (error) {
    Script.exit(
      Intent.text(`没能从分享内容里找到坐标：${error instanceof Error ? error.message : String(error)}`),
    );
    return;
  }

  /*
    解析成功才打开完整界面，并把落点带进去。

    不在这里直接开始模拟：那是个有后果的动作（要连设备、要改系统定位），
    分享过来的点也未必就是用户想立刻生效的那个。摆到地图上、让他确认一眼
    再按「开始位置模拟」，和手动选点的路径保持一致。
  */
  await Navigation.present({
    element: <App shared={shared} />,
    modalPresentationStyle: "fullScreen",
  });
  Script.exit();
}

void run();
