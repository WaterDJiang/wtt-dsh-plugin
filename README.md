# WTT 创作工作台

WTT 创作工作台（`@wtt/dsh-creation-workbench`）是 DeepSeek Harness（DSH）的独立开源插件。它把本机文件、画布卡片、AI 任务和成果版本放在同一个项目中。你可以直接向模型提要求，也可以在卡旁用 `/` 调用自己的 Skill。

## 在画布上组织创作

- 把项目文件拖进画布，用卡片和连线组织调研资料、内容提纲、视频脚本、分镜或课件。卡片多时点「排版」，快速整理画布。
- 单击卡片内容打开「AI 创作」，用 `@` 或「＋ 添加」补充引用。需要移动卡片时，拖动顶栏或边框。
- 双击文本卡，在右栏编辑正文。其他成果也可以在右栏预览，有可编辑源稿的课件可以继续修改并保存新版本。

[查看从课程需求到可编辑 PPT 的完整案例](examples/course-workflow.md)

## 安装

在 DSH 中打开 **插件 → 添加插件 → 安装第三方插件**，粘贴以下安装串：

```text
github:WaterDJiang/wtt-dsh-plugin#path:/plugins/dsh-creation-workbench
```

也可以在「发现」添加 [WTT 插件索引](https://raw.githubusercontent.com/WaterDJiang/wtt-dsh-plugin/main/market/index.json)。需要兼容的 DSH 宿主，具体范围见[插件安装说明](plugins/dsh-creation-workbench/README.md#安装)。

## 已安装？如何检查更新

当前版本为 **0.53.1**，统一卡旁创作入口，修复删除节点失效。[查看更新内容](plugins/dsh-creation-workbench/README.md#0531-的主要改进)。

使用社区市场 `dshmarket` 时，打开 **插件 → 插件市场 → 已安装**，找到 WTT 创作工作台。看到「有新版本」就点 **立即更新**。如果旧版的「代码来源」写的是 `path:plugins/...`，在原 DSH 配置用上面的安装串覆盖安装一次，以后可以直接从市场更新。

WTT 创作工作台已加入社区公共目录。各镜像的同步进度可能不同。[查看收录记录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13878)

[按原安装来源升级、验证和回退](plugins/dsh-creation-workbench/README.md#检查更新与升级)

## 项目文件

| 项目 | 入口 |
| --- | --- |
| 插件源码、安装与运行说明 | [plugins/dsh-creation-workbench](plugins/dsh-creation-workbench) |
| 制课案例与操作步骤 | [examples/course-workflow.md](examples/course-workflow.md) |
| DSH 自定义插件索引 | [market/index.json](market/index.json) |

许可证为 [MIT](LICENSE)。
