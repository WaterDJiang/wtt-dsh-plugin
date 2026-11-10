# WTT 创作工作台

WTT 创作工作台（`@wtt/dsh-creation-workbench`）是 DeepSeek Harness（DSH）的开源 AI 创作画布。在同一个项目里整理资料、引用卡片与文件、调用本机 Skill，并管理文本、演示文稿、图片和视频的成果版本。

## 从一张画布开始

1. 选一个本机文件夹作为项目，新建画布，把项目文件拖进去，或新建文本卡记录想法。
2. 单击卡片正文或点卡片旁的「＋」发起 AI 创作。用 `@` 引用资料，按需用 `/` 选择本机 Skill。
3. 在右栏审阅成果，双击文本卡可直接编辑。需要继续迭代时，把修改保存成新版本。

可以把访谈与笔记整理成研究简报，从品牌资料推进到视频脚本和分镜，或用一张画布管理文章提纲、初稿和修订稿。

## 安装

在 DSH 中打开 **插件 → 添加插件 → 安装第三方插件**，粘贴以下安装串：

```text
github:WaterDJiang/wtt-dsh-plugin#path:/plugins/dsh-creation-workbench
```

也可以在「发现」添加 [WTT 插件索引](https://raw.githubusercontent.com/WaterDJiang/wtt-dsh-plugin/main/market/index.json)。需要兼容的 DSH 宿主，具体范围见[插件安装说明](plugins/dsh-creation-workbench/README.md#安装)。

## 已安装？如何检查更新

当前版本为 **0.53.2**。画布在后台刷新时保持可见，拖动和保存布局更连贯。[查看更新内容](plugins/dsh-creation-workbench/README.md#0532-的主要改进)

使用社区市场 `dshmarket` 时，打开 **插件 → 插件市场 → 已安装**，找到 WTT 创作工作台。看到「有新版本」就点 **立即更新**。如果旧版的「代码来源」写的是 `path:plugins/...`，在原 DSH 配置用上面的安装串覆盖安装一次，以后可以直接从市场更新。

WTT 创作工作台已加入社区公共目录。各镜像的同步进度可能不同。[查看收录记录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/13878)

[按原安装来源升级、验证和回退](plugins/dsh-creation-workbench/README.md#检查更新与升级)

## 项目文件

| 项目 | 入口 |
| --- | --- |
| 插件源码、安装与运行说明 | [plugins/dsh-creation-workbench](plugins/dsh-creation-workbench) |
| 可选流程示例（课程开发） | [examples/course-workflow.md](examples/course-workflow.md) |
| DSH 自定义插件索引 | [market/index.json](market/index.json) |
| 维护与发布 | [发布检查清单](RELEASING.md) |

许可证为 [MIT](LICENSE)。
