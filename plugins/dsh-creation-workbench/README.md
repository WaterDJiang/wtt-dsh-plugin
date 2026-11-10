# WTT 创作工作台

**WTT 创作工作台**（`@wtt/dsh-creation-workbench`）是 DeepSeek Harness（DSH）的开源 AI 创作画布。在同一个项目里整理资料、引用卡片与文件、调用本机 Skill，并管理文本、演示文稿、图片和视频的成果版本。

## 快速开始

1. 选择一个本机文件夹，新建画布。把项目资料从文件树拖进去，也可以新建文本卡记录提纲。卡片多时用底部「排版」。
2. 单击卡片正文或点卡片旁的「＋」，输入你想完成的任务。用 `@` 引用画布卡片或项目文件。输入 `/` 可以选择本机 Skill，常用 Skill 也可以从创作框底部展开。
3. 双击卡片在右栏编辑文本或预览文件。审阅后保存成果，继续迭代时可在同一卡片保留新旧版本。

| 场景 | 可以怎样组织 |
| --- | --- |
| 内容策划 | 把参考资料、提纲、初稿和改稿放在同一张画布 |
| 视频创作 | 从创意简报推进到脚本和分镜，再归档图片和视频素材 |
| 调研与汇报 | 整理访谈与文献，引用原始材料撰写简报并制作演示稿 |

## 功能总览

- **自由画布**：一键排版、拖动、平移缩放、多选编组、连线、撤销重做、小地图；卡片按文本／PPT／图片／视频／文档分型展示，主题跟随 DSH 手动明暗设置
- **AI 创作**。在卡旁选择 DSH 已配置的模型和推理等级，直接描述任务或调用本机 Skill。配置即梦服务后，也可生成图片或视频，验证文件后加入画布。
- **文件与项目**：左侧文件树管理项目目录，支持行内新建、删除与回收站恢复；导入电脑资料自动提取正文（PDF／DOCX／PPTX），原件保留
- **文档编辑**：文本卡双击打开右栏进行富文本编辑；Word／PDF／CSV 右栏预览并通过本机应用修改工作副本，保存新版本才归档
- **PPT 编辑**。在页面上修改文字和备注，或请 AI 对整页或选中内容提出修改。SVG 源稿支持整页重绘和引用换图，确认后保存到同一卡片的新版本。
- **成果管理**：正式文件按「需求／版本／任务」目录组织，同卡多版本、下载绑定具体文件与 SHA-256 校验，旧版本不覆盖
- **Skill 发现**：自动读取本机常见技能目录（`~/.codex/skills`、`~/.agents/skills`、`~/.claude/skills`），常用技能点星收藏、中文改名

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

进入 DSH 左侧「WTT 创作工作台」后，可以在界面切换工作目录。下次打开时会记住你的选择。

仓库还自带启动器 `./scripts/wtt-dsh --workspace /path/to/workspace`：使用项目内 Node 24 与 DSH，在隔离 profile 自动安装插件，首次安装后复用；停止用 `Ctrl+C`。

## 检查更新与升级

- **社区插件市场（`dshmarket`）**。打开 **插件 → 插件市场 → 已安装**，找到 WTT 创作工作台。看到「有新版本」时点 **立即更新**，按 DSH 提示完成。
- **旧安装串迁移**。在 **插件 → 已安装** 打开工作台详情查看「代码来源」。如果子目录写成 `path:plugins/...`，在同一个配置中用本文开头的 `#path:/plugins/dsh-creation-workbench` 安装串覆盖安装一次。市场按带斜杠的子目录识别后续更新。
- **DSH 自定义插件索引**。从「发现」刷新 WTT 索引，选择兼容的新版本安装。也可以对照 [WTT 市场索引](../../market/index.json) 的版本和固定提交。

等待任务结束后再更新，按 DSH 提示重新加载或重启。打开原项目，核对版本和现有画布。回退可用旧版本的固定提交安装。备份时复制项目目录和其中隐藏的 `.wtt-workbench/`。

WTT 创作工作台已加入社区公共目录。镜像尚未同步时，可使用上面的 Git 安装串。[查看收录记录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13878)

## 0.53.2 的主要改进

- 已打开的画布在后台同步任务状态时保持可见，拖动卡片和保存布局时可继续操作。
- 如果拖动期间收到旧布局，工作台会在保存后重新读取。后台刷新保留当前视角，同一布局的撤销和重做记录仍可使用。

## 0.53.1 的主要改进

- 单击卡片正文和点卡片「＋」使用同一创作布局。常用技能从底栏按需展开，也可搜索全部技能。
- 历史成果的文件名、创作详情和原对话集中展示。卡片菜单按需列出本机应用。
- 修复工具栏、右键和快捷键无法删除画布节点的问题。默认移除仍保留文件，可从项目回收站恢复节点。

## 0.53.0 的主要改进

- 画布底部新增「排版」。卡片和分组按当前阅读顺序整理，可一次撤销；大量卡片时只渲染可视区域附近的内容，减轻拖动和缩放开销。
- 单击卡片内容打开 AI 创作；顶栏和边框可直接选择和拖动。双击文本卡在右栏编辑，切回画布时保留未保存的草稿。
- 从画布添加引用时，名称与卡片顶栏一致。引用预览仍对应选中时的文件版本。
- 工具栏、右侧标签和任务采用「AI 创作」；课程大纲仍可从「列表编辑 → 生成课程大纲」生成。

## 0.52.1 修复

- 打开旧项目或样例画布时，自动跳过宿主已找不到的历史对话。原任务记录、成果文件和版本仍可查看。
- 手动打开缺失的任务对话时，显示具体原因。已保存的文件可继续在同项目预览。

## 0.52.0 的主要改进

- 文本卡可以直接手填。卡旁输入框更紧凑，用 `@` 搜索画布卡片和项目文件。
- 待审稿和任务里的过程文件可在画布右栏打开；阶段成果保存后仍显示任务进度，中断的任务可在原对话继续。
- 同一个任务登记多份独立成果时，文件按名称分别成卡并错开放置；附件仍可留在主卡。
- 新任务只带入明确选中的引用，长资料按需读取；节省模式由 DSH 按模型上下文压力整理对话。
- PPT 源稿查找覆盖更深的项目目录，按导出文件校验值匹配。匹配到源工程时，可以从右栏进入编辑。

## 构建与检查

本插件的源码构建使用 Node ≥ 24。

```sh
npm ci
npm run build
npm test
```

`npm run build` 产出 `dist/` 前端与业务服务，并生成 `dist/third-party-notices.txt`（前端依赖许可声明）。`npm test` 覆盖画布与会话恢复、冻结引用、素材路径与状态、失败回滚、文件登记核验、PPT 原生可编辑性等离线检查；模型调用不在离线测试中模拟为真实成功。

## 按需配置

- AI 创作使用你在 DSH 中配置的模型。可安装自己的 Skill，将复杂任务拆成多个步骤，每步选择对应的 Skill 并引用前一步的成果。
- 文档处理使用 Python 3 和 [Python 依赖](resources/course-python-requirements.txt)，PPT 分页渲染需要 LibreOffice。
- MP4／WebM 视频预览需要本机 `ffprobe`。使用即梦生成图片或视频需要配置相应服务和账号。
- 课程开发是可选流程。可从「列表编辑 → 生成课程大纲」开始，搭配自己安装的 Skill。见[课程开发示例](../../examples/course-workflow.md)。

## 文件组织

`courses/` 是为兼容已有项目保留的目录名，通用创作项目也沿用此存储结构。

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
