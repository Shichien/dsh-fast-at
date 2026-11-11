# dsh-fast-mentions v0.3

让 DSH 的 `@` 补全每个按键都从内存里出结果：文件和会话两部分都不再在按键时遍历磁盘，也不再在按键时做全量排序。

## 根因

`@` 菜单（`dsh-client-ui-reference`）用 `Promise.all` 同时等两个宿主调用，然后合并成一个列表显示，所以较慢的那一半决定了整个菜单的速度：

```js
Promise.all([
  ctx.remote.fileReferences.list(sessionId, query, signal),
  ctx.remote.sessionReferenceResolver.candidates(sessionId, query, signal),
])
```

原版文件那一半有两个问题：

1. **索引按对话各建一份。** 每开一个新对话，第一次 `@` 都要把整个工作区重新遍历一遍。真实使用中出现过 226、393、763 ms。
2. **每个按键都全量重算。** 每敲一个字，都要对全部已索引路径（最多 5 万条）做一遍小写化、打分和完整排序。在 4–5 万条的工作区里，每个按键要花 25–46 ms。

## v0.3 的做法

| 部分 | 做法 |
|---|---|
| 文件索引 | 同一个工作目录只建一份，所有对话共用；路径的小写形式在建索引时就算好；每次只选出前 20 条，不做全量排序；继续输入时只在上一次的匹配结果里继续筛 |
| 冷启动 | 新工作区还没建完索引时，最多等 `coldBudgetMs`（默认 120 ms），然后先用已扫描到的部分返回结果。扫描是广度优先，先出来的正是浅层、最相关的那部分；下一个按键会看到更多 |
| 预热 | 对话一打开就在后台建好它所在工作区的索引 |
| 失效 | 工具执行完后，先用旧索引立即回答，新索引在后台重建 |
| 会话索引 | 全部会话预先建好内存表；正在运行的会话的标题有变化时立即生效 |
| 兜底 | 任何异常都退回原版实现；卸载时恢复原版方法 |

输出与原版**逐条一致**：`test/equivalence.mjs` 直接导入安装包里原版的 `WorkspaceFileSearch`，在真实目录上逐个查询对比结果。

## 实测（本机运行中的宿主，37 个 agent）

| 工作区 | 条目数 | 每个按键 · 原版 | 每个按键 · v0.3 |
|---|---|---|---|
| F:\Project\Litemora | 50 000 | 40–46 ms | 3–10 ms |
| G:\MDRebuild | 41 670 | 25–35 ms | 2.4–6.6 ms |
| F:\Project\Agent | 20 306 | 10–11 ms | 0.2–1.6 ms |
| F:\tmp\sessions | 13 549 | 14 ms | 0.6–2.3 ms |
| F:\Project\Typst | 8 855 | 11–18 ms | 0.25–1.2 ms |
| 小工作区 | < 500 | 3 ms | 0.1–0.2 ms |
| 新对话的第一次 `@`（冷启动） | — | 0.2–1.3 s | ≤ 120 ms（返回部分结果） |
| 会话标题部分 | 639 个会话 | 6–9 ms | 3.5–5 ms |

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `fileIndex` | `true` | 共享文件索引 |
| `sessionIndex` | `true` | 会话内存索引 |
| `prewarm` | `true` | 对话打开时预热工作区 |
| `coldBudgetMs` | `120` | 冷索引最多让菜单等多久 |
| `rebuildMinMs` | `3000` | 工具执行后两次后台重建的最小间隔 |
| `maxWorkspaces` | `16` | 同时保留的工作区索引数，超出时淘汰最久未用的 |
| `warmupDelayMs` | `1000` | 对话出现后多久开始预热 |
| `refreshMs` | `30000` | 会话索引后台刷新间隔 |
| `verbose` | `false` | 输出详细日志 |

`maxResults`、`maxEntries`、`excludedDirectories` 直接沿用宿主 `fileReferences` 的配置。

## 测试

```
node test/selftest.mjs                 # 23 项
node test/equivalence.mjs <目录> ...    # 与原版逐条对比 + 计时
```

## 安装与卸载

纯 ESM，无需构建，也没有第三方依赖。

```powershell
git clone https://github.com/Shichien/dsh-fast-at.git "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-fast-mentions"
```

然后在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里追加以下内容（[`cordis.patch.yml`](cordis.patch.yml) 里有带默认值的示例）：

```yaml
- insert:
    - id: fast-mentions
      name: dsh-fast-mentions
```

这个文件改动后会热重载，保存后立即生效，不用重启。删掉这条 insert 就卸载。

注意：宿主会缓存已加载过的 ESM 模块。如果想在不重启 DSH 的情况下更新代码，需要把目录换一个新包名（`package.json` 的 `name` 和 insert 的 `name` 一起改），或者直接重启 DSH。

测试 `equivalence.mjs` 需要用 `DSH_APP` 环境变量指定 DSH Desktop 的 `resources/app` 目录。

## 不在本插件范围内

- 宿主 → 渲染进程的 IPC 传输，以及菜单的 React 渲染
- 客户端那个 `Promise.all`：两部分现在都在 10 ms 以内，它已经不再是瓶颈
