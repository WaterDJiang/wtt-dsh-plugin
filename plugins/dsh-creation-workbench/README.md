# WTT 创作工作台

**WTT 创作工作台**（`@wtt/dsh-creation-workbench`）是面向 DeepSeek Harness（DSH）的通用创作插件：用自由画布管理素材与文件，卡片化组织文本、PPT、图片、视频与文档，AI 创作流可接入本机任意 Skill。

- **旗舰工作流：课程制作**——大纲 → 分镜 → 可编辑课件 → 逐字稿/练习/讲师手册的完整闭环，并支持课件源稿的 AI 迭代编辑
- **同样适合**：营销方案、视频脚本与分镜、调研整理、任意 Skill 驱动的创作场景

## 功能总览

- **自由画布**：拖动、平移缩放、多选编组、连线、撤销重做、小地图；卡片按文本／PPT／图片／视频／文档分型展示，主题跟随 DSH 手动明暗设置
- **AI 创作**：卡旁创作框选择 DSH 已配置的提供商、模型和推理等级；文本任务用 `/Skill名称` 调用本机任意 Skill，按所选 Skill 原有确认流程推进；图片／视频接本机即梦服务生成，真实格式与 hash 核验后成为产物卡
- **文件与项目**：左侧文件树管理项目目录，支持行内新建、删除与回收站恢复；导入电脑资料自动提取正文（PDF／DOCX／PPTX），原件保留
- **文档编辑**：文本卡双击富文本编辑；Word／PDF／CSV 右栏预览并通过本机应用修改工作副本，保存新版本才归档
- **PPT 编辑**：页内改字、讲师备注、整页／选段交 AI 出候选差异预览；SVG 源稿支持整页重绘、引用换图与分栏对话，确认后保存同卡新版本
- **成果管理**：正式文件按「需求／版本／任务」目录组织，同卡多版本、下载绑定具体文件与 SHA-256 校验，旧版本不覆盖
- **Skill 发现**：自动读取本机常见技能目录（`~/.codex/skills`、`~/.agents/skills`、`~/.claude/skills`），常用技能点星收藏、中文改名

## 安装

前提：已安装 DSH 宿主 `0.2.1-rc.5`；源码构建另需 Node ≥ 24。

### 方式一：npm 成品包（推荐，无需本地构建）

npm 包内含已构建的 `dist/` 前端与业务服务：

```sh
npm pack @wtt/dsh-creation-workbench
dsh plugin --profile web add "$PWD/wtt-dsh-creation-workbench-0.51.0.tgz"
```

### 方式二：从源码构建

```sh
git clone https://github.com/WaterDJiang/wtt-dsh-plugin.git
cd wtt-dsh-plugin/plugins/dsh-creation-workbench
npm install
npm run build
npm pack
dsh plugin --profile web add "$PWD/wtt-dsh-creation-workbench-0.51.0.tgz"
```

Node ≥ 24 推荐按下文「构建与检查」先安装隔离运行时，避免污染系统 Node。

### 安装后启动

```sh
WTT_COURSE_WORKSPACE=/path/to/workspace dsh web
```

进入 DSH 左侧「WTT 创作工作台」即可使用；之后可直接从工作目录运行 `dsh web`，工作区在前端切换并记忆。

仓库还自带启动器 `./scripts/wtt-dsh --workspace /path/to/workspace`：使用项目内 Node 24 与 DSH，在隔离 profile 自动安装插件，首次安装后复用；停止用 `Ctrl+C`。

## 构建与检查

本插件要求 Node ≥ 24。推荐先安装隔离运行时与 DSH 宿主（不污染系统 Node）：

```sh
npm install --prefix .runtime/node node@24.11.0 --registry=https://registry.npmjs.org
PATH="$PWD/.runtime/node/node_modules/node/bin:$PATH" npm ci --registry=https://registry.npmjs.org
PATH="$PWD/.runtime/node/node_modules/node/bin:$PATH" npm install --prefix .runtime/host @deepseek-ai/dsh@0.2.1-rc.5 --registry=https://registry.npmjs.org
PATH="$PWD/.runtime/node/node_modules/node/bin:$PATH" npm run build
PATH="$PWD/.runtime/node/node_modules/node/bin:$PATH" npm test
```

`npm run build` 产出 `dist/` 前端与业务服务，并生成 `dist/third-party-notices.txt`（前端依赖许可声明）。`npm test` 覆盖画布与会话恢复、冻结引用、素材路径与状态、失败回滚、文件登记核验、PPT 原生可编辑性等离线检查；模型调用不在离线测试中模拟为真实成功。

## 运行前提（自备）

本仓库只包含插件本体（前端、Host 业务服务与内部工作台协议）。课程类等复杂创作工作流由你自己的本机 Skill 驱动，插件不附带任何课程技能；Skill 缺失或不可调用时界面如实提示，不伪装可用。

建议把复杂创作拆成多个步骤，每步在文本／PPT 创作框中选择对应的本机 Skill 推进。以课程制作为例：

1. **大纲**——导入资料与背景，用你的大纲类 Skill 生成课程大纲，确认后保存版本
2. **分镜**——从大纲进入分镜类 Skill，逐段确认教学安排与页面设计
3. **课件**——用课件类 Skill 生成可编辑 PPT；插件在登记时会重新验证真实 PPTX 与原生可编辑性
4. **练习与逐字稿**——分别用练习类、逐字稿类 Skill 产出正式文件（PDF／CSV、Markdown／DOCX 等）

环境依赖按需自备，缺失时如实提示：

- Python 3 与文档／课件依赖（版本见 `resources/course-python-requirements.txt`；PPT 分页渲染需 LibreOffice）
- MP4／WebM 视频预览需要本机 `ffprobe`；图片／视频生成需本机即梦 API 与账号
- 本仓库**不包含**任何课程技能、私有知识库、企业品牌模板或账号凭据；模型账号在 DSH 界面配置

## 文件组织

```text
所选工作文件夹/
  .wtt-workbench/
    workbench.sqlite
  courses/
    <需求 ID>/
      v001/outline.md
      v001/outline.docx
      v002/outline.md
      v002/outline.docx
      materials/<素材 ID>.md
      imports/<导入操作 ID>/<原文件名>
      tasks/<任务 ID>/
        …                     # 分镜、机器交接、清单和预览等中间文件
        delivery/<正式文件>   # 文本 MD/TXT/DOCX/PDF/CSV；PPTX；练习、逐字稿、生成图片与视频
```

需求、任务、布局、分组、连线、素材、版本来源与文件登记以 SQLite 为准，正式文件保存在同一项目目录。大纲和 Word 位于 `vNNN/`；通用文本、PPT、练习、逐字稿和生成媒体使用各自 `tasks/<任务 ID>/`，正式文件只放 `delivery/`。电脑原件复制到 `imports/<导入操作 ID>/`，正文或未解析说明另存 `materials/`；记录原名称、大小、格式、hash 和提取状态，用户原文件保留。旧版本与已登记文件不覆盖，同卡生成的新版本使用新任务和新路径。外部修改已登记文件后，导出／下载会拒绝沿用旧登记。备份前停止应用，再复制整个工作文件夹（包括隐藏元数据目录）。

最近项目与最后选择保存在 `$DSH_HOME/wtt-course-workbench/projects.json`；额外 Skill 目录与常用名称保存到 `$DSH_HOME/wtt-course-workbench/skill-settings.json`，与各项目业务文件分开。插件不复制或修改 Skill 原件；目录适配复用官方 peer `@deepseek-ai/dsh-skill-filesystem@0.2.1-rc.5`。

## 开源使用须知

- 本插件是面向 DSH 的独立第三方项目，与 DeepSeek 无隶属关系
- 按许可证「按原样」提供，不含任何担保
- 插件不收集、不上传任何数据；所有项目数据保存在用户本机工作目录
- 模型账号、本机技能、Python 依赖与外部工具需自行配置，插件对缺失能力如实报错，不伪装可用

## 许可证

MIT © 2026 Wattter (WTT)
