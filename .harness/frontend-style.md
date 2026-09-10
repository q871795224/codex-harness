# 前端样式约束

本文约束几个**固定 UI 区域**的样式写法。在这些区域新增元素时，必须复用既有结构、共用选择器组和主题变量，不要自行新起一套字号、padding、颜色或一次性微调。只记录稳定约定；具体视觉数值以 `src/styles.css` 为准，本文不复制数值。

## 总原则

- **同区域、同类型的元素进同一个共用选择器组**，不为新元素单独写一份重复规则。
- **深色主题必须成对覆盖**：改了 `background`/`border-color` 就必须同时确认 `color`（文字/图标）在深色下也被显式覆盖，不能让它回落到为浅色设计的基色。漏配 `color` 会导致深色背景叠近黑文字。
- **新颜色优先用已有的主题变量/色板**，不引入孤立色值。
- 区域专属样式集中在 `src/styles.css`；插件或独立页面（如通知中心页）的样式放在对应 `*.css`，但**跨区域的共享元素（侧栏、tab 栏）仍归 `src/styles.css` 管**。

## 侧边栏底部操作行（已归档 / 设置 / 通知中心）

这一类整行入口 + 可选右侧小图标按钮，统一用 **split 结构**：

- 结构：外层 `<div class="...-split">` 包一个主按钮（`...-toggle` / `notification-nav`）+ 可选的右侧小图标按钮（`...-button` / `plugins-toggle`）。右侧小按钮缺省时主按钮加 `solo` 类恢复整行圆角。
- 主按钮一律并入 `styles.css` 的共用组：基础 `display/height/padding/gap/color` 组、导航字号组（`calc(13px + var(--h-navigation-font-offset))`）、dark hover 组、dark color 组。**新增此类入口时把新类名加进这四组，而不是另写。**
- 右侧小图标按钮统一为 32px 方块、左侧 1px 分隔线、右圆角，复用同一组样式。
- 未读计数等角标用主按钮内的 `<b>`，颜色/形状沿用既有规则。

## 顶部主按钮（新会话 split-button）

- 「主按钮 + 右侧提供者切换」用 `new-chat-split` / `new-chat-button` / `new-chat-provider` 这套结构。
- 基色（浅色）与 dark 覆盖必须成对维护：dark 下既要改 `background`/`border-color`，也要显式设 `color`（含 `:hover`），不能只改背景漏掉文字。

## 会话 tab 栏（对话 / 待办 + 右侧工具区）

- 右侧工具（铃铛、连接状态等）放进 `.notification-tab-tools` 这个居中容器（`height:40px; align-items:center`），与左侧 `.thread-tabs`（撑满整行居中）对齐。
- 容器内子元素**不要再加 `margin-bottom` 之类的一次性垂直微调**；`connection-state` 自带的下外边距在该容器内已被归零。需要垂直定位时调整容器的 `align-items`，而不是给单个子元素补 margin。

## 新增区域时

如果要加一个上文没覆盖的新固定区域，先在本文件补一节约定（结构、共用组、主题要点），再写样式；不要让新区域成为下一个「各自实现」的特例。
