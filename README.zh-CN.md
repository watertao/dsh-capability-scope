<div align="center">

# dsh-capability-scope

**在 DeepSeek Harness 的输入框里，按会话开关 MCP 服务器、MCP 工具和 Skill，并按工作区记住这些选择**

[English](README.md) · [更新日志](CHANGELOG.md) · [MIT](LICENSE)

[![npm](https://img.shields.io/npm/v/dsh-capability-scope.svg)](https://www.npmjs.com/package/dsh-capability-scope)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-2563eb.svg)](#兼容性)

</div>

> 社区维护的 DeepSeek Harness（DSH）插件，并非 DeepSeek 官方产品。

一个 profile 里往往挂着很多 MCP 服务器和 Skill，但具体到某个项目、某次会话，模型只需要其中一部分。多余的工具会占用上下文，还会诱导模型调用不该用的东西。这个插件在输入框底部加两个按钮 `MCP 3/12` 和 `Skill 4/5`：点开即可按会话裁剪模型能看到的能力，改动立即生效，并作为该目录的默认值保留到下一次。

## 功能

- **MCP 服务器开关**：列出 profile 与当前 agent preset 里的全部 MCP 服务器，带连接状态与来源标签。关闭的服务器对本会话隐藏全部工具、拒绝调用，并从系统提示里移除它的说明。只做减法，不会停止服务器进程，也不影响其他会话。
- **MCP 工具过滤**：点进某个服务器，逐个勾选要保留的工具。没有勾选过时沿用该服务器配置里的 `toolFilter`；服务器之后新增的工具默认隐藏，直到你勾选它。
- **Skill 开关**：关闭的 Skill 从模型的技能目录、`skill` 工具和输入框 `/` 菜单里一起消失，仅对本会话生效。面板里显示每个 Skill 的来源（如 `project-dsh`、`user-dsh`、`bundled`）、描述和所在目录。
- **按工作区记忆**：面板上的每次改动都会记为该目录的默认值，下次在同一目录新建会话时自动沿用。
- **按目录选 preset**：在某个目录新建的空白会话，会自动切到该目录上次选择的 agent preset；没有记录时按 `rules` 配置选。
- **锁定模式**：`locked: true` 时面板只显示、不能改，能力完全由配置决定，适合统一分发的部署。

## 截图

**Skill 开关：**

![Skill 开关面板](assets/skill.png)

## 安装

需要 DSH 0.2.x，Web 或 Desktop profile。该命令从 npm 安装本包：

```sh
dsh plugin --profile web add dsh-capability-scope
```

重启 DSH 后，输入框底部（权限模式按钮右侧）会出现 `MCP` 和 `Skill` 两个按钮。Desktop 把 `web` 换成 `desktop`。

在 headless 等没有 Web UI 的 profile 里也可以安装：此时没有面板，但目录记忆和 `defaultOff` 照常生效。

<details>
<summary>从源码挂载（开发用）</summary>

在 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）里用绝对路径插入一行。浏览器半边会沿路径向上找到本包的 `package.json`，自动加载：

```yaml
- insert:
    - id: dsh-capability-scope
      name: /absolute/path/to/dsh-capability-scope/src/index.mjs
```

</details>

## 使用

**MCP 面板**

- 每行一个服务器：状态点、名称、来源标签（`profile` / `preset` / `未登记`），括号里是「保留的工具数/总数」，服务器连不上时显示状态。
- 点左侧 `›` 进入该服务器的工具列表，勾选要保留的工具；底部「恢复默认」回到配置里的 `toolFilter`。
- 底部「全部开启 / 全部关闭」只作用于当前过滤后可见的条目；「恢复默认」回到 `defaultOff`。

**Skill 面板**

- 每个 Skill 三行：名称和来源标签、描述、所在目录（家目录缩写为 `~`；运行期注册的 Skill 没有目录）。悬停查看完整内容。
- 被关掉的 Skill 仍然列在面板里，方便随时打开。

条目超过 13 个时，标题下方会出现过滤框：MCP 按服务器名匹配；Skill 按名称、描述、目录和来源匹配。

> [!NOTE]
> 对已经开始对话的会话做改动，会改变模型可见的工具或 Skill，导致提示缓存失效，下一轮请求的成本会上升。最好在会话开始前调好。

## 配置

所有配置项都是可选的。要修改，在 profile 自己的 `cordis.patch.yml` 里按 id 覆盖这一行（覆盖会**整体替换** config，需要写全你要的键）：

```yaml
- id: dsh-capability-scope
  config:
    rules:                        # 没有记忆的目录按路径选 preset（含子目录，最长匹配优先）
      - path: ~/work/payment-service
        preset: backend-tools
    defaultOff:                   # 没有记忆的目录默认关闭的服务器 / Skill
      mcp: [tdoc]
      skills: []
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `rules` | `[]` | `{ path, preset }` 列表。只用于没有 preset 记忆的空白会话；`path` 必须是绝对路径（可用 `~`），匹配该目录及其子目录 |
| `defaultOff.mcp` | `[]` | 没有记忆的目录默认关闭的 MCP 服务器（`serverName`） |
| `defaultOff.skills` | `[]` | 没有记忆的目录默认关闭的 Skill |
| `remember` | `true` | 是否按目录记住面板改动和 preset 选择。关闭后改动只对当前会话有效 |
| `locked` | `false` | 面板只读：写入请求返回 403，不读也不写目录记忆（即 `remember` 视为 `false`）。MCP 工具由 `toolFilter` 决定，开关由 `defaultOff` 决定 |
| `enforceGuard` | `true` | 除了隐藏，还拒绝对被隐藏工具的调用 |
| `memoryPath` | profile 目录下的 `.capability-scope.json` | 记忆文件位置，必须是绝对路径 |
| `echoToConsole` | `true` | 诊断信息同时打印到 stdout / stderr |

几条规则：

- **目录记忆按精确路径匹配**，子目录算作「没有记忆的目录」；`rules` 则包含子目录。
- **`defaultOff` 是黑名单**：之后新增的服务器或 Skill 默认是开启的。
- preset 只会替**空白的顶层会话**切换：已开始的会话、子代理、显式指定了 preset 的会话（如 Creator 模式）以及手动改过 preset 的会话都不会被改动。

## 工作原理

| 能力 | 实现 |
|---|---|
| 隐藏 MCP 工具 | `agent.ctx.tools.restrict({ deny })`，能遮住从全局层和 preset 作用域继承的工具；`agent.ctx.tools.guard()` 拒绝调用（资源工具按 `server` 参数判断） |
| 移除服务器说明 | 在会话层注册同名的空 `mcp:<server>` 提示段，并重写 `mcp-resource-servers` 段 |
| 关闭 Skill | 在会话层注册同名、模型和用户都不可调用的影子 Skill；Skill 注册表按「离会话最近的一层优先」合并，影子就盖住了原 Skill |
| 刷新 `/` 菜单 | Skill 开关变化后为该会话重发一次当前 preset 的 `agent-preset/selected`，浏览器据此丢弃 Skill 缓存。这个事件不写入会话，也不会被记成该目录的 preset |
| 记忆 | profile 目录下的 `.capability-scope.json`，按目录保存 preset、关闭列表、工具白名单，以及被关闭 Skill 的描述、目录和来源（Skill 关闭后无法再从会话视图读到这些信息） |

面板通过 `GET /dsh-capability-scope/session?id=<sessionId>` 读取状态，通过 `POST /dsh-capability-scope/session`（body 带 `id` 和 `mcpOff` / `skillsOff` / `filter` 之一）写入。

## 兼容性

在 DSH **0.2.0-rc.2** 上开发和测试，`peerDependencies` 声明为 `>=0.2.0-rc.2 <0.3.0-0`，超出范围时 `dsh plugin add` 会拒绝安装。Node.js ≥ 20。

插件读取了宿主的几处内部接口：`agentPresets.definitions`（读 preset 的 MCP 行和作用域）、`agentPresets.serviceFor / composedPreset / select / defaultId`、`ctx.tools.schemas / restrict / guard`、`skills.register / snapshot`、`sessionProjections.stateOf`、`mcpResources.layers`。这些接口变化时插件会降级，而不是挂载失败：

- `definitions` 不可读：preset 里的服务器显示为「未登记」，不显示连接状态；工具仍按名字归到对应服务器。
- 宿主不再在 `agent-preset/selected` 时丢弃 Skill 缓存：Skill 开关仍然生效，只是 `/` 菜单要到新会话才更新。

## 开发

```sh
npm test          # 用模拟宿主跑冒烟测试，无需安装任何依赖
npm run pack:check
```

| 路径 | 内容 |
|---|---|
| `src/index.mjs` | 宿主半边：会话状态、工具限制、影子 Skill、preset 选择、HTTP 接口 |
| `src/memory.mjs` | 工作区记忆文件的读写 |
| `src/names.mjs` | MCP 公开工具名与 `toolFilter` 匹配（与 `dsh-mcp-client` 的命名规则一致，由 `test/golden-names.json` 锁定） |
| `lib/client.js` | 浏览器半边：输入框按钮与面板（无需构建） |
| `cordis.patch.yml` | `dsh plugin add` 使用的 bundle 补丁 |

欢迎提 Issue 和 PR。

## 许可证

[MIT](LICENSE)
