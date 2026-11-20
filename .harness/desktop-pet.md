# 桌面宠物与大肥鱼开发约定

桌宠是 macOS 核心能力，使用独立透明窗口；大肥鱼是默认的内置宠物。使用、素材格式和下载入口见 [桌面宠物](../docs/desktop-pet.md)，助理产品范围见 [Harness 助理](../docs/harness-assistant.md)。本文件记录改动前需要知道的实现边界。

## 模块与窗口

| 模块 | 职责 | 源码 |
| --- | --- | --- |
| 主窗口 `main` | 持有会话、通知、助理执行服务，向桌宠发布活动快照，处理导航和已读 | [App.tsx](../src/App.tsx)、[活动归并](../src/core/desktop-pet/activity.ts)、[助理宿主](../src/features/desktop-pet/desktopAssistantHost.ts) |
| 桌宠 `desktop-pet` | 角色、角标、点击、长按拖动、右键菜单 | [PetWindow.tsx](../src/features/desktop-pet/PetWindow.tsx)、[desktop_pet.rs](../src-tauri/src/desktop_pet.rs) |
| 助理 `desktop-assistant` | 复用主窗口的助理会话和操作服务，关闭时隐藏，执行继续 | [DesktopAssistantWindow.tsx](../src/features/desktop-pet/DesktopAssistantWindow.tsx)、[desktop_assistant.rs](../src-tauri/src/desktop_assistant.rs) |
| 素材与原画 | 图集导入、内置资源、受限视频下载和读取 | [pets/dafeiyu](../src-tauri/pets/dafeiyu)、[desktop_pet_hd.rs](../src-tauri/src/desktop_pet_hd.rs) |

`src/main.tsx` 按 URL 参数分别加载桌宠、独立助理与主界面，避免桌宠启动整套 App。前端原生调用仍统一经过 `bridge.ts`；独立窗口不能自行连接 App Server 或创建另一套会话、通知服务。

每个窗口有独立的 Tauri [capability](../src-tauri/capabilities/)；Rust 的 `allows_command` 和 `lib.rs` invoke handler 另做命令白名单校验。新增 IPC 时同时核对调用窗口身份、bridge 类型与测试，不能把主窗口权限整体开放给桌宠或助理。

## 窗口与交互

- 桌宠透明、置顶、跨工作区显示，首次显示不抢焦点，也不能成为 key/main window。AppKit 在主线程设置 `Transient | IgnoresCycle`、排除 Windows 菜单，并声明 `AXFloatingWindow` 子角色，供系统窗口轮换及 AltTab 识别为辅助浮窗。保留已有的跨 Space 属性；不改变整个应用的 activation policy。主窗口与可输入的助理窗口仍是普通窗口。
- 桌宠可见时，关闭主窗口只隐藏它；React 服务继续采集状态。点击 Dock 或桌宠“查看通知”可恢复主窗口。隐藏桌宠同时收起独立助理；完全退出 Harness 才结束所有窗口。
- 单击角色打开独立助理；长按 320 ms 后拖动。拖动统一使用 AppKit 屏幕逻辑点和按下偏移，在同一坐标空间读写，避免混合 DPI 显示器间跳位。位置按移动事件防抖保存。
- 通用宠物通过透明像素采样得到交互范围，透明留白允许鼠标穿透；拖动期间保持事件归属直到松开。大肥鱼使用固定裁剪窗口，不逐帧采样、不逐帧重设原生窗口大小。
- 角标优先级为待回应、失败、关注会话的新结果；没有这些事项时才显示运行或空闲状态。同一会话只计一次。动画阶段与角标状态分别维护。

## 大肥鱼布局与播放

[layout.json](../src-tauri/pets/dafeiyu/layout.json) 是前端裁剪与 Rust 窗口尺寸的共同来源。100% 大小时静态窗口为 72 × 90、视频窗口为 48 × 54 个逻辑像素；支持 20%–400% 缩放。更换布局需同时核对角色、点击区、角标及原生窗口；会话活动或视频帧变化不改变窗口和角标位置。

[DafeiyuVideo.tsx](../src/features/desktop-pet/DafeiyuVideo.tsx) 在可见时按“衔接待机 → 随机动作 → 衔接待机”连续播放，候选来自 [movies.json](../src-tauri/pets/dafeiyu/movies.json) 与 [播放选择逻辑](../src/features/desktop-pet/dafeiyuPlaylist.ts)。状态变化只插播一次状态动作，随后恢复轮播；相同状态的重复快照不能重置播放。每段按原时长播放，下一段加载时保留上一段末帧，旧 Blob URL 及时释放。

没有原画包或开启系统减少动态效果时使用静态图。其他宠物的随机动作仍按空闲 60 秒的既有规则执行，不套用大肥鱼轮播策略。

## 素材和持久化

| 来源 | 位置 | 写入边界 |
| --- | --- | --- |
| 内置素材 | App resource 的 `pets/`；开发模式回退到 `src-tauri/pets/` | 随应用发布，授权见 [NOTICE.md](../src-tauri/pets/dafeiyu/NOTICE.md) |
| Codex 宠物 | 实际 `CODEX_HOME/pets/` | 只读，不修改用户原包 |
| 用户导入 | `~/.codex-harness/pets/` | 校验格式、大小和包内路径后导入 |
| 大肥鱼原画 | `~/.codex-harness/pet-media/dafeiyu-original-v1/` | 显式下载固定上游包；验证精确字节数、SHA-256 和白名单文件，临时目录完成后原子安装 |

`desktopPet.selected`、`desktopPet.visible`、`desktopPet.scalePercent`、`desktopPet.position` 保存为 Harness app state；素材正文不写 SQLite。下载约 139 MiB，不在测试中访问真实用户目录或自动下载。换上游包时同步核对固定 URL、哈希、体积、视频清单与授权，不提供任意 URL 下载或任意路径读取入口。

## 验证入口

自动化范围与人工检查见 [test.md](test.md#桌面宠物与助理窗口)。其中 AltTab、系统窗口轮换、跨屏拖动和首次点击需要 macOS 图形会话验收；纯逻辑测试通过后仍需记录这部分是否实际执行。
