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

## 从案例上手

[从需求、大纲和分镜做到可编辑课件](../../examples/course-workflow.md)。案例也说明如何从卡片继续创作、核对引用，以及怎么在画布里审阅和修改课件。

## 安装

前提为兼容的 DSH 宿主。包的兼容范围是 `>=0.2.1-rc.5 || >=0.2.2-rc.0`，源码构建另需 Node ≥ 24。

### 在 DSH 中安装

打开 **插件 → 添加插件 → 安装第三方插件**，粘贴下面的 Git 安装串：

```text
github:WaterDJiang/wtt-dsh-plugin#path:/plugins/dsh-creation-workbench
```

安装串使用 GitHub 默认分支和插件子目录。要安装指定版本，在 `#` 后加上 [WTT 插件索引](../../market/index.json) 对应版本的 `source.commit`，再加 `&path:/plugins/dsh-creation-workbench`。

### 通过「发现」安装

在 DSH 的实验性插件中启用「自定义插件索引」（部分版本称「自定义插件市场」），进入「发现 → 添加索引源」，粘贴：

```text
https://raw.githubusercontent.com/WaterDJiang/wtt-dsh-plugin/main/market/index.json
```

搜索「WTT 创作工作台」，选择兼容版本安装。索引中的每个版本固定到一个 Git 提交。[DSH 官方插件索引说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)

### 在命令行安装或从源码打包

如果使用 Web profile，可以直接安装：

```sh
dsh plugin --profile web add 'github:WaterDJiang/wtt-dsh-plugin#path:/plugins/dsh-creation-workbench'
```

需要修改源码时，可以自行构建安装：

```sh
git clone https://github.com/WaterDJiang/wtt-dsh-plugin.git
cd wtt-dsh-plugin/plugins/dsh-creation-workbench
npm ci
npm run build
package_file=$(npm pack --silent)
dsh plugin --profile web add "$PWD/$package_file"
```

### 安装后启动

```sh
WTT_COURSE_WORKSPACE=/path/to/workspace dsh web
```

进入 DSH 左侧「WTT 创作工作台」即可使用；之后可直接从工作目录运行 `dsh web`，工作区在前端切换并记忆。

仓库还自带启动器 `./scripts/wtt-dsh --workspace /path/to/workspace`：使用项目内 Node 24 与 DSH，在隔离 profile 自动安装插件，首次安装后复用；停止用 `Ctrl+C`。

## 检查更新与升级

- **社区插件市场（`dshmarket`）**。打开 **插件 → 插件市场 → 已安装**，找到 WTT 创作工作台。看到「有新版本」时点「立即更新」，按 DSH 提示完成。市场根据 GitHub 发布源检查这个插件的版本。
- **旧安装串迁移**。在 **插件 → 已安装** 打开工作台详情查看「代码来源」。如果子目录写成 `path:plugins/...`，在同一个配置中用本文开头的 `#path:/plugins/dsh-creation-workbench` 安装串覆盖安装一次。市场按带斜杠的子目录识别后续更新。
- **DSH 自定义插件索引**。从「发现」刷新 WTT 索引，选择兼容的新版本安装。也可以对照 [WTT 市场索引](../../market/index.json) 的版本和固定提交。

等待任务结束后再更新，按 DSH 提示重新加载或重启。打开原项目，核对版本和现有画布。回退可用旧版本的固定提交安装。备份时复制项目目录和其中隐藏的 `.wtt-workbench/`。

## 0.52.0 的主要改进

- 文本卡可以直接手填。卡旁输入框更紧凑，用 `@` 搜索画布卡片和项目文件。
- 待审稿和任务里的过程文件可在画布右栏打开；阶段成果保存后仍显示任务进度，中断的任务可在原对话继续。
- 同一个任务登记多份独立成果时，文件按名称分别成卡并错开放置；附件仍可留在主卡。
- 新任务只带入明确选中的引用，长资料按需读取；节省模式由 DSH 按模型上下文压力整理对话。
- PPT 源稿查找覆盖更深的项目目录，按导出文件校验值匹配。匹配到源工程时，可以从右栏进入编辑。

## 构建与检查

本插件要求 Node ≥ 24。推荐先安装隔离运行时与 DSH 宿主（不污染系统 Node）：

```sh
npm install --prefix .runtime/node node@24.11.0 --registry=https://registry.npmjs.org
PATH="$PWD/.runtime/node/node_modules/node/bin:$PATH" npm ci --registry=https://registry.npmjs.org
PATH="$PWD/.runtime/node/node_modules/node/bin:$PATH" npm install --prefix .runtime/host @deepseek-ai/dsh@0.2.1-rc.5 --registry=https://registry.npmjs.org   # 安装与你运行版本一致的 DSH 宿主
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
- 课程技能、个人知识库、企业模板和模型账号由使用者配置

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

最近项目与最后选择保存在 `$DSH_HOME/wtt-creation-workbench/projects.json`；额外 Skill 目录与常用名称保存到 `$DSH_HOME/wtt-creation-workbench/skill-settings.json`，与各项目业务文件分开。插件不复制或修改 Skill 原件；目录适配复用官方 peer `@deepseek-ai/dsh-skill-filesystem@0.2.1-rc.5`。

## 开源使用须知

- 本插件是面向 DSH 的独立第三方项目，与 DeepSeek 无隶属关系；运行依赖 DSH 宿主 `0.2.1-rc.5` 或更新（`engines.dsh: >=0.2.1-rc.5 || >=0.2.2-rc.0`）
- 按许可证「按原样」提供，不含任何担保
- 项目文件保存在你选择的本机目录。发起 AI 任务时，提示词和引用资料会按任务设置交给所选模型或技能处理
- 模型账号、本机技能、Python 依赖与外部工具需自行配置，插件对缺失能力如实报错，不伪装可用

## 许可证

MIT © 2026 Wattter (WTT)
