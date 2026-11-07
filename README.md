# wtt-dsh-plugin

WTT 面向 DeepSeek Harness（DSH）的插件合集，按 monorepo 组织。每个子插件独立构建、独立发包（npm scope `@wtt`）。

| 子插件 | 定位 |
| --- | --- |
| [`dsh-creation-workbench`](plugins/dsh-creation-workbench) | 通用创作工作台：自由画布管理素材与文件，卡片化组织文本、PPT、图片、视频与文档，AI 创作流接入本机任意 Skill；课程制作为旗舰工作流 |

- 运行依赖 DSH 宿主 `0.2.1-rc.5`
- 许可证：MIT（整仓统一）

## 安装

各子插件的完整安装说明见其目录内 README。最简单的方式是在 DSH 插件市场选择「新增插件」，粘贴安装串后安装：

```
git+https://github.com/WaterDJiang/wtt-dsh-plugin#main&path:plugins/dsh-creation-workbench
```

以创作工作台为例，npm 成品包两步安装（包内含已构建产物，无需本地构建）：

```sh
npm pack @wtt/dsh-creation-workbench
dsh plugin --profile web add "$PWD/wtt-dsh-creation-workbench-0.51.0.tgz"
```

源码构建、启动参数与运行前提见 [`plugins/dsh-creation-workbench/README.md`](plugins/dsh-creation-workbench/README.md)。
