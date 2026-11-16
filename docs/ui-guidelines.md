# 织念 UI 结构范式与全局组件指南

> 基准页面:**笔记编辑页**(`MarkdownStudio`,路由 `/notes/[id]`)。
> 本文档以该页面为唯一基准,拆解其布局结构、设计令牌与视觉模式,
> 给出可抽离的全局组件清单与既有页面的改造映射,**后续所有页面开发/改造必须遵循本范式**。
>
> 基准代码入口:
> - `src/app/(editor)/layout.tsx` — 沉浸式路由组(满屏、无全站导航)
> - `src/components/notes/note-editor-host.tsx` — 宿主(接 API、ESC 退出)
> - `src/components/studio/markdown-studio.tsx` — 工作台骨架与顶栏(本文核心)
> - `src/components/studio/outline-panel.tsx` — 左侧目录栏
> - `src/components/studio/editor-pane.tsx` — 中部正文区
> - `src/components/studio/ai-chat-panel.tsx` — 右侧 AI 面板

---

## 1. 基准页面结构总览

笔记编辑页是一套「**满屏工作台**」结构,自下而上的 z-index 分层:

```
┌─────────────────────────────────────────────────────────────┐
│ studio-root (h-full, data-preset, --studio-* 变量作用域)  z-│
│  ├─ z-0  背景层     .studio-bg-video / .studio-bg-layer     │
│  ├─ z-1  面板遮罩   .studio-surface-mask (base+alpha 混色)  │
│  ├─ z-2  顶栏保护   .studio-header-mask (毛玻璃)            │
│  ├─ z-3  顶栏       header h-14  ← 全站顶栏范式基准         │
│  ├─      移动端 Tab 条(md:hidden,目录/文档/AI 切换)        │
│  └─      三栏主体   flex min-h-0 flex-1(可拖拽换位+FLIP)   │
│       ├─ 左栏  OutlinePanel   w-56  可折叠                 │
│       ├─ 中栏  EditorPane     flex-1 split/focus 两态      │
│       └─ 右栏  AiChatPanel    380px ↔ 640px 可展开         │
└─────────────────────────────────────────────────────────────┘
```

顶栏内部遵循「**左-中-右**」三段式:

| 区段 | 内容 | 代码位置 |
|------|------|----------|
| 左 | 返回胶囊按钮 → 竖分隔线 → 行内可编辑标题 → AI 撤销按钮 | markdown-studio.tsx:611-658 |
| 中 | 绝对居中胶囊组:主题预设下拉 + 透明度滑条 + tab 切换组(目录/AI/编辑模式) | markdown-studio.tsx:661-709 |
| 右 | ghost 动作按钮(小指南/导出) + 保存状态指示器 | markdown-studio.tsx:738-756 |

三栏面板统一模式:**PanelGrip 拖拽把手(顶部居中) + 面板头(icon+标题+计数/操作) + 滚动主体 + 可选底部输入区**。

---

## 2. 设计令牌规范(必须使用,禁止硬编码)

### 2.1 颜色

所有颜色走 CSS 变量 + alpha 记法,禁止写死十六进制(兜底值除外):

| 用途 | 令牌 / 记法 | 示例 |
|------|-------------|------|
| 主色/主色前景 | `--primary` / `--primary-foreground` | `bg-primary text-primary-foreground` |
| 正文/弱化文字 | `--foreground` / `--muted-foreground` | `text-muted-foreground` |
| 半透明面 | `bg-foreground/[0.04]`、`bg-white/[0.02~0.06]` | 胶囊底、hover 底 |
| 半透明边框 | `border-foreground/10~15`、`border-white/[0.08]` | 分隔线、面板边框 |
| 主色浅底 | `bg-primary/10`、`border-primary/25~40` | 选中态、引用条 |
| 浮层底 | `bg-background/95` + `backdrop-blur` | 搜索栏、工具条 |
| 工作台主题 | `--studio-base/text/heading/link/border/code-*` | studio-theme.css:77-151 |
| 场景玻璃面 | `--surface-card/glass/nav/page-*` | globals.css:100-134 |

### 2.2 字号层级

| 层级 | 类 | 用途 |
|------|-----|------|
| 眉标 | `text-[10px] uppercase tracking-wider text-muted-foreground/60` | 分区标签(「场景」「纯色」) |
| 微标签 | `text-[10px]` / `text-[11px]` | 计数、时间、状态、tab |
| 辅助 | `text-xs` (12px) | 按钮文字、输入、说明 |
| 正文标题 | `text-[13px] font-semibold` | 面板标题 |
| 文档正文 | `text-sm` (14px) | 编辑器、气泡 |

### 2.3 圆角

| 场景 | 类 |
|------|-----|
| 胶囊(按钮/切换组/下拉触发) | `rounded-full` |
| 小按钮/图标按钮/浮层 | `rounded-lg` |
| 输入组合框/弹层面板 | `rounded-xl` |
| 消息气泡/空态图标容器 | `rounded-2xl` |

### 2.4 图标与动效

- 图标库统一 **@phosphor-icons/react**;尺寸 `size-3 ~ size-6`;激活/强调用 `weight="fill"`,空态装饰用 `duotone`。
- 过渡统一 `transition-colors/all duration-200~300 ease-out`;弹性位移用 `cubic-bezier(0.23,1,0.32,1)`。
- 面板宽度过渡 `width/transform 300ms ease-out`;重排动画用 FLIP(见 markdown-studio.tsx:524-546)。

### 2.5 滚动条

工作台内滚动统一挂 `.studio-scroll`(studio.css:141),AI 消息区可用 `.thin-scrollbar`;禁止浏览器默认粗滚动条出现在面板里。

---

## 3. 可抽离的全局组件清单

### 3.0 已存在、直接复用(勿重复造)

| 组件 | 位置 | 备注 |
|------|------|------|
| Tooltip / Dialog / DropdownMenu / Sheet / Select / Tabs / ScrollArea / Card / Button / Input / Textarea / Avatar / Badge / Separator / Skeleton / sonner | `src/components/ui/` | shadcn 原子件,继续作为最底层 |
| MessageBubble | `src/components/ai/message-bubble.tsx` | 已是全局气泡,所有 AI/聊天场景复用 |
| MarkdownRenderer | `src/components/ai/markdown-renderer.tsx` | 所有 markdown 渲染统一走它 |
| AccordionGallery | `src/components/studio/accordion-gallery.tsx` | 手风琴画廊,主题选择器在用 |

### 3.1 P0 — 工作台骨架(影响所有页面结构,优先抽离)

新目录建议:`src/components/workbench/`

| # | 组件 | 来源(基准实现) | 职责与 API 草案 |
|---|------|-----------------|------------------|
| 1 | `WorkbenchShell` | markdown-studio.tsx:580-605 | 满屏工作台容器:背景层(video/image)+ 面板遮罩 + 顶栏遮罩 + `children`。props: `bgType/bgSrc/preset/rootStyle` |
| 2 | `WorkbenchHeader` | markdown-studio.tsx:607-757 | `h-14` 三段式顶栏,slots: `left / center / right`。左区固定放返回+标题,右区固定放动作+状态 |
| 3 | `BackButton` | markdown-studio.tsx:611-618 | 胶囊返回按钮:`rounded-full border-2 border-primary-foreground bg-primary text-xs font-bold` + hover 位移投影 + `CaretLeft` 图标。props: `label/href/onClick` |
| 4 | `InlineEditableTitle` | markdown-studio.tsx:620-648 | 行内可编辑标题:文本态 hover 显 `PencilSimple`,编辑态 `border-b-2 border-primary` input,Enter 提交 / Esc 取消。props: `value/onChange/disabled` |
| 5 | `CapsuleToggleGroup` | markdown-studio.tsx:673-708 | 胶囊切换组:`rounded-full bg-foreground/[0.04] p-0.5` 容器;项激活 `bg-primary text-primary-foreground`,未激活 `text-muted-foreground hover:bg-foreground/[0.08]`。props: `items[{key,icon,label,active,onClick}]` |
| 6 | `GhostActionButton` | markdown-studio.tsx:738-755 | 顶栏右侧 ghost 动作:`rounded-lg border border-foreground/10 bg-foreground/[0.04] px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/20 hover:text-foreground`。props: `icon/label/onClick` |
| 7 | `StatusIndicator` | markdown-studio.tsx:1117-1148 | 状态指示器:`{state: saving|dirty|error|saved}` → Spinner/圆点/警告/勾 + 文案。后续可扩「同步中/离线」等 |

### 3.2 P1 — 面板与交互件

| # | 组件 | 来源 | 职责与要点 |
|---|------|------|------------|
| 8 | `SidePanel` | outline-panel.tsx:20-70 与 ai-chat-panel.tsx:296-445 的公共骨架 | 侧栏面板:`aside` + `border-l/r border-white/[0.08]` + slots `header/body(滚动)/footer`。目录栏与 AI 栏都应改为它的实例 |
| 9 | `PanelHeader` | ai-chat-panel.tsx:297-337 | `h-12 border-b` 面板头:`icon(text-primary) + 标题(13px semibold) + 副标(10px muted) + 右侧操作区` |
| 10 | `OutlineNav` | outline-panel.tsx:37-68 | 层级导航列表:`border-l-2` 激活项 `border-primary bg-primary/10 text-primary`,按 level 缩进 `12+(level-1)*14px`。适用目录、章节、任何树形跳转 |
| 11 | `ChatInput` | ai-chat-panel.tsx:405-441 | 输入组合框:`rounded-xl border border-white/10 bg-white/[0.04] focus-within:border-primary/40` + 自增高 textarea(`max-h-[90px]`) + `size-8 rounded-lg bg-primary` 发送/停止按钮。所有 AI 入口统一用它 |
| 12 | `QuoteBar` | ai-chat-panel.tsx:386-404 | 引用条:`rounded-lg border border-primary/25 bg-primary/[0.06]` + `Quotes` 图标 + line-clamp-2 + 清除按钮 |
| 13 | `EmptyStateGuide` | ai-chat-panel.tsx:344-374 | 空态:`size-12 rounded-2xl bg-primary/10` 图标容器 + 主文案(13px medium) + 副文案(xs muted) + 快捷按钮列表(`rounded-lg border border-white/[0.08] bg-white/[0.03] hover:border-primary/30`) |
| 14 | `FloatingToolbar` | editor-pane.tsx:640-697 | 浮层工具条范式:`rounded-lg border border-foreground/12 bg-background/95 shadow-xl backdrop-blur` + `size-6 rounded-md` 图标按钮。选区工具条、搜索栏、右键条都归它 |
| 15 | `PanelGrip` + `usePanelReorder` | markdown-studio.tsx:1105-1115、494-546 | 面板拖拽把手(顶居中 `bg-background/90 backdrop-blur`)+ pointer 拖拽换位 + FLIP 滑移动画。多栏工作台通用 |

### 3.3 P2 — 主题与设置件

| # | 组件 | 来源 | 职责 |
|---|------|------|------|
| 16 | `ThemePresetDropdown` | markdown-studio.tsx:917-1059 | 主题预设胶囊下拉:`h-[30px] rounded-full bg-foreground/[0.06]` 触发;面板=「场景」AccordionGallery + 「纯色」grid-cols-4 按钮组。全站换肤入口统一走它 |
| 17 | `OpacitySlider` | markdown-studio.tsx:1066-1103 | 透明度滑条(`--val` 渐变填充 + Tooltip),任何「背景透出度」调节复用 |
| 18 | `EyebrowLabel` | outline-panel.tsx:22、markdown-studio.tsx:967 | 眉标小标题(uppercase tracking-wider),分区统一使用 |
| 19 | `MobileTabBar` | markdown-studio.tsx:759-786 | 移动端整宽 tab 切换(`flex-1 py-2 text-xs`,激活 `bg-primary/12 text-primary`),多面板页移动态通用 |

> 命名与落位约定:骨架/面板类新组件放 `src/components/workbench/`;
> 与业务无关的纯原子件可下沉 `src/components/ui/`;
> 拖拽/主题类 hook 放 `src/hooks/`(如 `use-panel-reorder`、`use-studio-theme` 保持现有位置)。

---

## 4. 页面结构范式(二选一)

### 范式 A:沉浸式工作台页(基准,即笔记编辑页)

适用:文档/计划/画布等「重编辑、长停留」页面。

- 路由组 `(editor)`,**不挂全站 TopNav**,`h-[100dvh]` 满屏;
- 结构 = `WorkbenchShell` + `WorkbenchHeader` + 多栏 `SidePanel`(可拖拽换位);
- 顶栏左区必须有 `BackButton`(返回上一级列表)+ `InlineEditableTitle`;
- 顶栏右区必须有 `StatusIndicator`(保存/同步状态)+ `GhostActionButton` 组;
- 移动端降级为 `MobileTabBar` 单面板切换;
- 参考宿主写法:`note-editor-host.tsx`(ESC 退出、自动保存、AI context)。

### 范式 B:全站导航页(列表/设置/个人页)

适用:笔记库、个人主页、统计等「浏览为主」页面。

- 保留 `(dashboard)` 的 `TopNav`(其按钮/胶囊样式向范式 A 的 `BackButton/GhostActionButton/CapsuleToggleGroup` 靠拢,统一抽自同一组件);
- 页面主体 = 玻璃面板(`SidePanel` 或 `Card` + `--surface-*` 令牌)+ `PanelHeader` + 内容;
- 列表/导航项选中态统一 `border-primary bg-primary/10 text-primary`(同 `OutlineNav`);
- 弹层统一 `FloatingToolbar` 的容器样式(rounded-lg + bg-background/95 + backdrop-blur + shadow-xl)。

**两范式共享同一套令牌与组件**——差异只在是否挂全站导航,视觉语言必须无差别。

---

## 5. 既有页面改造映射

| 页面/组件 | 现状 | 应采用的全局组件 |
|-----------|------|------------------|
| `src/app/(dashboard)/notes` → `notes-library.tsx` | 自写列表与侧栏 | `SidePanel` + `OutlineNav`(分类导航)+ `GhostActionButton`(工具区)+ `EmptyStateGuide` |
| `src/app/(dashboard)/profile` | 自写卡片与表单 | `PanelHeader` + `ChatInput`(简介输入)+ `Card`/`--surface-card-*` |
| `src/components/layout/top-nav.tsx` | 独立胶囊样式 | 换用 `CapsuleToggleGroup`、`GhostActionButton`、`ThemePresetDropdown`(场景切换) |
| `src/components/agent`、`chatroom` | 各自聊天气泡/输入 | `MessageBubble` + `ChatInput` + `QuoteBar` + `EmptyStateGuide` |
| `src/components/plans`、`focus-room`、`island` | 面板结构不一 | 范式 A:`WorkbenchShell/Header` + `SidePanel`;范式 B:面板+`PanelHeader` |
| `src/components/settings`、`statistics` | 表单/图表容器 | `PanelHeader` + `EyebrowLabel` + `--surface-*` 玻璃面 + `StatusIndicator` |
| `src/components/studio/*`(基准自身) | 内联样式 | **先就地抽离**:markdown-studio 改为消费 `workbench/` 组件,作为首个迁移样板 |

改造顺序建议:
1. 从 `markdown-studio.tsx` 抽 P0 七件套到 `src/components/workbench/`(行为零变化,纯搬移);
2. `outline-panel` / `ai-chat-panel` 重构为 `SidePanel + PanelHeader` 实例,验证抽象;
3. 抽 P1 交互件,`agent/chatroom` 接入验证 `ChatInput/MessageBubble`;
4. 按第 5 节映射逐页改造,每页验收第 6 节清单。

---

## 6. 新页面 UI 验收清单

- [ ] 页面结构明确属于范式 A 或 B,骨架来自 `workbench/` 组件,无整段复制粘贴的顶栏/面板;
- [ ] 颜色全部走令牌(`--primary/--foreground/--surface-*/--studio-*` + alpha),无硬编码 hex/rgba;
- [ ] 字号只出现在 10/11/12/13/14px 层级;分区标题用 `EyebrowLabel`;
- [ ] 圆角只用 rounded-full / lg / xl / 2xl 四档,用途符合 2.3;
- [ ] 图标全部 Phosphor,尺寸与 weight 符合 2.4;
- [ ] 顶栏为左-中-右三段:返回+标题 / 切换组 / 动作+状态;
- [ ] 所有面板有 `PanelHeader`,选中态统一 `bg-primary/10 text-primary`;
- [ ] 浮层统一 `FloatingToolbar` 容器样式;滚动区无默认粗滚动条;
- [ ] 移动端:多面板降级 `MobileTabBar`,弹层宽度 ≤ `calc(100vw-2rem)`;
- [ ] 交互反馈:hover/active 均有过渡(200~300ms),破坏性操作走 `Dialog` 确认(参考「新对话」确认框)。

---

*维护约定:新增全局组件或调整令牌时,同步更新本文档并在 PR 中说明影响的范式;基准页面若改版,先更新本文档再改代码。*
