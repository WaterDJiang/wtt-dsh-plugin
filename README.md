# WTT 创作工作台

WTT 创作工作台（`@wtt/dsh-creation-workbench`）是 DeepSeek Harness（DSH）的独立开源插件。它把本机文件、画布卡片、AI 任务和成果版本放在同一个项目中。你可以直接向模型提要求，也可以在卡旁用 `/` 调用自己的 Skill。

## 使用案例：从一份课程需求做到可编辑 PPT

**需求 → 课程大纲 → PPT 设计（逐页分镜）→ 可编辑 PPT → 修改与定稿**

以虚构的 Excel 入门课为例。先把需求文档拖进画布，从需求卡生成大纲。确认教学顺序后，再从大纲卡做分镜，明确每页讲什么、怎么呈现。用确认版分镜制作 PPT 后，双击成果卡逐页查看。有匹配的源工程时，可以原位改字、补备注、把选中的页面对象交给 AI，再保存为新版本。

- **从卡片继续。** 点卡边「＋」时，原卡会带入新任务。用 `@` 或「＋ 添加」补资料，发送前可以核对引用和版本。
- **在成果旁边做决定。** 需要确认时回到原任务看方案和文件。课件右栏能切页，编辑器里可以边看页面边提修改，旧版本也能在卡片里回看。
- **同一套操作可用在别的项目。** 比如把访谈接到营销方案和脚本，或把参考资料接到调研分析和简报。专业方法由你选择的模型和本机 Skill 提供。

[查看完整案例与操作步骤](examples/course-workflow.md)

## 安装

在 DSH 中打开 **插件 → 添加插件 → 安装第三方插件**，粘贴以下安装串：

```text
github:WaterDJiang/wtt-dsh-plugin#path:/plugins/dsh-creation-workbench
```

也可以在「发现」添加 [WTT 插件索引](https://raw.githubusercontent.com/WaterDJiang/wtt-dsh-plugin/main/market/index.json)。需要兼容的 DSH 宿主，具体范围见[插件安装说明](plugins/dsh-creation-workbench/README.md#安装)。

## 已安装？如何检查更新

当前版本为 **0.52.1**，修复旧任务对话缺失时打开画布弹错的问题。[查看更新内容](plugins/dsh-creation-workbench/README.md#0521-修复)。

使用社区市场 `dshmarket` 时，打开 **插件 → 插件市场 → 已安装**，找到 WTT 创作工作台。看到「有新版本」就点 **立即更新**。如果旧版的「代码来源」写的是 `path:plugins/...`，在原 DSH 配置用上面的安装串覆盖安装一次，以后可以直接从市场更新。

中国镜像的公共目录收录正在审核。收录后，新用户可以直接在社区市场搜索「WTT 创作工作台」。[查看收录进度](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13878)

[按原安装来源升级、验证和回退](plugins/dsh-creation-workbench/README.md#检查更新与升级)

## 项目文件

| 项目 | 入口 |
| --- | --- |
| 插件源码、安装与运行说明 | [plugins/dsh-creation-workbench](plugins/dsh-creation-workbench) |
| 制课案例与操作步骤 | [examples/course-workflow.md](examples/course-workflow.md) |
| DSH 自定义插件索引 | [market/index.json](market/index.json) |

许可证为 [MIT](LICENSE)。
