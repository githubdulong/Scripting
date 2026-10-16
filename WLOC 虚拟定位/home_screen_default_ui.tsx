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

// 首页 Tab 入口。
//
// Scripting 的「选择脚本」列表只列出带这个文件的脚本，文件名和位置都是约定死的：
// 必须叫 `home_screen_default_ui.tsx`、与 index.tsx 同级、默认导出一个函数组件。
// 少任何一条，脚本就不会出现在那个列表里。
//
// 这里只做一件事：把 index.tsx 里那个 App 原样挂上去。界面不必为 Tab 另写一份，
// 差异都收在 index.tsx 的 `IS_HOME_TAB` 分支里（不 present、不 exit、不画关闭键）。
//
// 几条和「运行一次」不同的规矩，改这个文件前先知道：
//   - **不要** `Navigation.present`：宿主已经把组件挂到 Tab 上了，再弹一层是多余的。
//   - **不要** `Script.exit()`：退出会终止实例，Tab 上会留一个不再响应的界面。
//   - 组件**常驻**：切到别的 Tab 再回来状态还在，顶层代码只在首次构建时跑一次。
//     改完代码不会热更新，要长按 tab bar 上的 Home 图标点 Reload。
//
// 常驻对这个脚本恰好是好事：定位模拟靠一条活连接和 4 秒一次的心跳维持，
// 以前从脚本列表进来、一退出就断，现在它能一直待在那儿。

import { App } from "./index";

export default function HomeScreenView() {
  return <App />;
}
