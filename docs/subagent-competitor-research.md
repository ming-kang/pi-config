# Subagent 竞品调研报告：nicobailon/pi-subagents

> 目的：从热度较高的竞品 `nicobailon/pi-subagents` 中甄选**有价值、且契合我们设计取向**的特性，为后续开发提供依据。本报告只做调研与判断，**不含开发**。

## 0. 调研状态（诚实边界）

本报告经竞品两轮问答 + 我方/Pi 两轮代码审计定稿，区分「已确认」与「仍待决」：

- **已确认（竞品特性面）**：竞品的功能全景、TUI/UX、各模式语义、持久化路径方案、并发/调度模型、fork 前提等，来自对竞品文档与源码结构的两轮问答，可信度高。
- **已确认（我方基线）**：我们 `extensions/subagent` 的会话构造、回传机制、参数面、并发默认、TUI —— 均来自本会话对源码的直接阅读，附行号。
- **已确认（我方 controller 审计，§7-B 闭环）**：cwd 解析与消费点、全部终止路径、资源释放点、调度队列结构，结论已并入 §3.1/§3.2。核心事实：**不存在单一 teardown 收敛点**，资源释放仅 `releaseSession()`（controller.ts:1244）与 `dispose()` 内联块（609-616）两处且未统一；终态 worker 的 session 故意保活以支持 `send` 续跑。
- **已确认（Pi API 能力面，§7-C 闭环）**：fork 三要素全部可达（`ctx.sessionManager` 只读暴露父历史、`SessionManager.forkFrom` 等一等分叉能力、`createAgentSession({ sessionManager })` 自动以既有历史起步）；git/worktree 无公开 API，须经 `pi.exec` 自己 shell。结论已并入 §3.1/§3.3。
- **仍待决**：脏 worktree 处置策略（§7-D）、链式必要性（§7-E）、fork 内存重放路线的 `append*` 族签名核验（§7-C 残留项）。§7-A 竞品对照降级为参考项。

---

## 1. 定位差异：不照搬的前提

| | 竞品 pi-subagents | 我们的 subagent |
|---|---|---|
| 产品形态 | **全功能编排框架** | **进程内轻量工人池** |
| 执行载体 | **独立 `pi` CLI 子进程**（`subagent-runner.ts` spawn；异步任务 detached，父关子存活） | **同进程 `createAgentSession()` 内存会话** |
| 父子通信 | 子进程写 `status.json`/`events.jsonl`/`output-<n>.log`，父进程读文件 | `session.subscribe` 直接回调 + `pi.sendMessage` 回传 |
| 执行模式 | SINGLE / PARALLEL / CHAIN + MANAGEMENT | 单一 spawn（可批量 `tasks`，批量即并行） |
| 状态存储 | 落盘到父会话旁 + tmp artifacts | 纯内存 `SubagentRecord`，零落盘 |
| 跨重启 | 可恢复（scheduledRuns 重启续跑） | 随进程消亡 |
| TUI | 三套（Clarification / Fleet / Agents Manager） | 两面（footer widget + 单聚焦 overlay） |
| 安全审查 | Watchdog 对抗审查 | 无（靠 `noExtensions` 递归硬阻断） |
| 认知负担取向 | 功能面大、快捷键多 | 上一轮刚做完「少即是多」的简化 |

**核心判断**：竞品是"什么都能编排"，我们上一轮刚反方向做完 UX 精简。因此甄选原则不是"抄齐功能"，而是**只补真实能力短板、守住轻量身份**。下面据此把竞品特性分三层。

**架构路线是根本分野（后补审计确认）**：竞品是**"进程 + 文件"模型** —— 每个 subagent 是 spawn 出的独立 `pi` CLI 子进程（`subagent-runner.ts`；有 `getPiSpawnCommand`/`PI_SUBAGENT_PI_BINARY` 选定二进制），异步任务为 detached OS 进程、父进程退出后仍可跑完；父子通过磁盘 artifacts 通信（子写 `status.json`/`events.jsonl`/`output-<n>.log`，父读文件驱动 widget 与 `status`）。我们是**"进程内 + 内存"模型** —— worker 是父进程里的 `createAgentSession()` 对象，事件经 `session.subscribe` 直接回调，完成经 `pi.sendMessage` 触发父回合。竞品的持久化、跨重启恢复、定时任务都是进程模型的自然产物；我们的零落盘、启动即用、无 IPC 也是内存模型的自然产物。**两线互斥，几乎不存在"抄一半"的中间态** —— 这也是"不抄"清单大半的根因。

---

## 2. 特性全景与分类

| 竞品特性 | 竞品机制（要点） | 我方现状 | 处置 |
|---|---|---|---|
| **worktree 隔离并行** | PARALLEL 模式可选 git worktree 隔离每个 task | 共享 cwd，仅口头警告勿重叠编辑 | **该抄（设计已定稿；用户决策降为非当前要务）** |
| **CHAIN + 模板变量** | `{task}/{previous}/{outputs.name}/{chain_dir}` 串接数据流 | 只能靠 parent 手动串 | **权衡：轻量版或不做** |
| **context:"fork"** | 从父会话当前 leaf 分叉出子会话文件 | worker 为 fresh context | **可行已验证，按需做** |
| **subagent_wait** | 阻塞父回合等 next/all/id 完成 | 靠 followUp 自动回传 | **仅随链式配套** |
| 全量落盘持久化 / artifacts | 会话落 `~/.pi/agent/sessions/<sid>/{runId}/run-{N}/` | 纯内存 | **不抄**（身份） |
| Watchdog 对抗审查 | agent-end 用对抗模型审查改动 | 无 | **不抄**（超范围） |
| Skills（SKILL.md） | 可复用 prompt/工具注入，`skills=a+b` | agent markdown 定义已覆盖 | **不抄**（重复抽象） |
| Clarification TUI | 运行前预览编辑 model/thinking/skills | 项目 agent 已有 confirm 门 | **不抄**（违背派活即走） |
| scheduledRuns 定时任务 | 持久化定时、重启恢复 | 无 | **不抄**（对立于进程内） |
| Fleet View 双栏 dashboard | roster+detail 双栏，`/subagents-fleet` | 单聚焦 overlay + Tab 循环 | **不抄**（刚简化，不回退） |
| Agents Manager TUI | `/agents` 浏览/编辑/多选启动链 | 无独立管理器 | **不抄**（重量级） |

---

## 3. 入选特性深挖

### 3.1 worktree 隔离并行 —— 该抄，第一优先

**为什么最该做**：这是我们 README 里**自认的短板** —— "Worktree isolation is not currently implemented"，并只能口头警告"do not assign overlapping edits"。多个并行 worker 共享同一 cwd，一旦并发编辑同一批文件就互相踩踏。这是唯一"实现即消除一类真实故障"的项。

**竞品机制（已确认到的层面）**：PARALLEL 模式对每个 task 可选建立 git worktree 做隔离；并发用 `src/runs/shared/parallel-utils.ts` 的 `Semaphore` 控制（默认并发 4）。worktree 的**精确建立/清理调用点**尚未提取（见 §7-A）。

**与我们的契合度**：高。worktree 是**临时资源**，和 worker 同生命周期同生共死 —— 正好呼应我们"纯内存、零残留"的取向。不依赖 Pi 特殊 API：经 `pi.exec` 调 `git worktree add/remove` 即可（§7-C 确认 Pi 无现成 worktree/git 公开 API，shell 是唯一路径）。

**落地设计（§7-B 审计后定稿）**：cwd 侧很干净 —— 单一解析点 `prepareLaunchSpecs`（controller.ts:779，恒存绝对路径），消费集中在 `createSession`（1024/1037/1046），所以"把 record.cwd 换成 worktree 路径"只需动一处。生命周期按审计事实绑定：

1. **懒建**：worktree 不在 spawn/入队时建，而在 fresh run 真正启动时（`executeQueuedRun` 进 `createSession` 前）经 `pi.exec("git", ["worktree", "add", ...])` 建 —— "排队即被 stop"（558-569）、"dispose 清队"（596）、"pump 时丢弃"（927-931）这些从未启动的路径就天然无树可泄漏。
2. **绑定 record 而非单次 run**：审计确认终态 worker 的 session **故意保活**（支持 `send` 续跑已完成的对话），所以 worktree 也必须活到 record 释放 —— 否则 continue 会踩空 cwd。清理恰好挂在仅有的两个 session 释放点上：`releaseSession()`（1244，覆盖 clear 与 fresh-restart）和 `dispose()`（609-616）。
3. **前置改造**：`dispose()` 目前不调 `releaseSession()` 而是内联重写同样的清理 —— 须先统一成单一释放函数，worktree 清理才有唯一挂点。小而必要的收敛重构。
4. **可选开关**：task 加 `isolate: true`，默认仍共享 cwd；非 git 仓库 / git 不可用时优雅降级回共享 cwd 并在结果里注明。

**风险与取舍（仅剩一项未决）**：
- **脏 worktree 处置（§7-D）**：`git worktree remove` 对有未提交改动的树会拒绝，强删则销毁 worker 的劳动成果。倾向：干净则删、脏则保留并在回传/clear 结果里报告路径，由 parent/用户显式合并 —— 与纯内存哲学一致（产出留在文件系统，管理权在人）。restart fresh 按同一策略处理旧树后再建新树，避免"fresh context + 脏工作区"的不一致。

### 3.2 轻量链式依赖 —— 权衡，做轻量版或不做

**竞品机制（已确认）**：CHAIN 模式用模板变量在步骤间传数据：`{task}`（首步原始任务）、`{previous}`（上一步输出）、`{outputs.name}`（某个具名步骤/并行任务的输出，靠 `as:"name"` 命名）、`{chain_dir}`（共享工件目录）；还支持 `agent[key=value,...]` 行内覆盖 `output/reads/model/skills/progress`。可用 `/chain` 或 `subagent` 的 `chain` 数组触发。

**我方现状**：要串 A→B 只能 parent 手动：等 A 完成 → 读 `record.lastOutput` → 带着该文本 spawn B。

**判断**：完整模板引擎（`{outputs.name}`/`{chain_dir}`/行内覆盖）是重量级，不做。**若要做只做轻量版**：spawn 的 task 上加 `after: [id]`，调度器在依赖完成后把上游 `lastOutput` 注入下游 prompt 前缀。**但**这会明显增加 controller 调度复杂度（从"就绪即跑"变成"带依赖的 DAG 调度"）。**决策取决于实际编排深度**：如果多数编排都很浅、parent 手动串已够用，就不值得引入。倾向：**默认不做，除非出现真实的多级链式需求**。

**改动面（§7-B 已审计确认）**：若做，涉及 `schema.ts`（task 加依赖字段）、`types.ts`、`prepareLaunchSpecs`（743-865，校验依赖指向同批兄弟）、`spawn`（622-713，批内 task→id 映射，id 在循环 680 才分配）、`pumpQueue`（918-943，就绪门控 —— 主要摩擦点：现在 `queue.shift()` 假设队首恒可跑，须改成"扫描首个可运行项"或回插队尾）、`executeQueuedRun`（971-978，把上游 `lastOutput` 前置进 prompt）。范围有界，但调度语义的改变是实打实的复杂度 —— 印证"无真实需求不做"。

### 3.3 context:"fork" —— 可行性已确认，作为可选项排在 worktree 之后

**竞品机制（已确认）**：`context:"fork"` 让 worker 继承父会话上下文，但在**分叉的独立线程**里推理，适合"顾问型/执行型"任务参考历史而不污染父会话。竞品前提：父会话已持久化，从当前 leaf 分叉出真实会话文件。

**我方现状**：worker 是 fresh context（仅 `systemPrompt` + task），干净但"失忆"。

**可行性结论（§7-C 闭环：三要素全部可达）**：
1. **父历史可读**：扩展 `ctx.sessionManager`（`ReadonlySessionManager`）暴露 `getEntries/getBranch/buildContextEntries/getLeafId/getSessionFile`，其中 `buildContextEntries()` 给出 compaction 感知的当前有效上下文。
2. **既有历史起步受支持**：`createAgentSession({ sessionManager })` 在传入已含历史的 SessionManager 时自动接管其 messages（编译后 sdk.js 行为已核实；注意 JSDoc 里的 `continueSession` 字段实际不存在，勿照抄）。
3. **一等分叉 API**：`SessionManager.forkFrom(parentPath, targetCwd)`、`open`、`branch`、`createBranchedSession` 及 `append*` 编程构建族。

**两条实现路线**：
- **甲（最省事）**：`getSessionFile()` → `forkFrom` → 传入 `createAgentSession`。代价：fork 出的子会话**落盘**进 `~/.pi/agent/sessions/`（破坏零落盘身份），且要求父会话已持久化（同竞品限制）。
- **乙（契合身份，倾向）**：`buildContextEntries()` 读有效条目 → 新建 `SessionManager.inMemory()` 用 `append*` 族重放 → 传入 `createAgentSession`。保持零落盘，也不要求父会话落盘。残留核验：`append*` 族签名与条目→消息映射（§7-C 残留项）。
- 无论哪条，fork worker 的上下文体量≈父会话，意味着**贵、慢、且偏离"干净上下文"卖点** —— 只适合顾问型任务（review/plan 需要参考历史），应做成 spawn 显式 `context:"fork"` 可选项，默认恒 fresh。

**倾向**：技术可达、路线乙成本可控；排在 worktree 之后，出现顾问型真实需求再动工。

### 3.4 subagent_wait —— 仅随链式配套

**竞品机制（已确认）**：`subagent_wait()` 阻塞父回合直到 next 完成 / `{all:true}` 全部 / `{id}` 指定，带 `timeoutMs`；配合 `subagent_status`（`view:"fleet"|"transcript"`）观测。背后是 `createAsyncJobTracker`（`src/extension/index.ts`）+ 完成事件。

**判断**：我们的 followUp 自动回传（完成即 `triggerTurn` 触发 parent 新一轮）**已经很优雅**，`wait` 的价值只在**同一回合内**要拿结果继续——而这恰与我们"派活即走、不要 poll"的引导冲突。**只有做了 §3.2 链式才有配套必要**。否则不做。

---

## 4. 明确不抄的特性及理由

- **全量落盘持久化 / artifacts**：上一轮我们已阐明"纯内存是刻意设计"（零磁盘足迹、无递归风险、启动即用、`/resume` 不留残留）。这是**身份不是短板**。顶多加"用户主动导出某个 worker 结果成文件"的可选动作，绝不自动全量落盘。
- **Watchdog 对抗审查**：重量级安全子系统（对抗模型审查改动），远超我们范围。
- **Skills（SKILL.md）**：我们的 agent markdown 定义已覆盖"注入专属 prompt"，skills 是正交再抽象，收益不抵复杂度。
- **Clarification TUI**：运行前预览编辑直接违背"派活即走"；项目 agent 我们已有 confirm 门槛。
- **scheduledRuns 定时任务**：需持久化 + 重启恢复，与进程内哲学对立。
- **Fleet 双栏 / Agents Manager**：我们刚把 TUI 简化成 footer widget + 单聚焦 overlay + Tab 循环，认知负担更低，不回退成多栏 dashboard 与独立管理器。

---

## 5. 我方当前基线速查（便于报告自足）

- **会话构造**（`controller.ts:1022-1057`）：`DefaultResourceLoader`（`noExtensions/noPromptTemplates/noThemes` + `systemPromptOverride` 拼 worker 提示）→ `createAgentSession({ cwd, agentDir, modelRegistry, model?, thinkingLevel?, tools?, resourceLoader, sessionManager: SessionManager.inMemory(record.cwd), settingsManager: SettingsManager.inMemory() })`。worker 内禁止再 spawn（`controller.ts:207` 系统提示 + `noExtensions` 双保险）。
- **回传**（`controller.ts:1161-1219`）：`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`，正文含状态/任务/统计/结果，封顶 `COMPLETION_OUTPUT_CHARS = 24000`。
- **参数面**（`schema.ts`）：action = `spawn|list|read|send|restart|stop|clear|configure`；task 单发或 `tasks` 批量；每 task 可带 `agent/model/tools/cwd/thinkingLevel/maxTurns/label`；`send` 的 `delivery = steer|followUp`。
- **限额**（`constants.ts`）：并发默认 3 / 硬顶 8；保留记录默认 16 / 硬顶 32；批量 16；timeline 400 条 / 12 万字符；`READ_OUTPUT_CHARS = 32000`。
- **TUI**：footer widget（稳定排序，pending/active 在上、完成沉底）+ 单聚焦 transcript overlay（Enter/Esc/Tab/方向键/PgUp-Dn/Home-End/ctrl+c，assistant 消息复用 Pi `Markdown` 渲染）。

---

## 6. 落地顺序（用户决策后存档）

> **用户决策（2026-07-18）**：扩展以**成熟度优先**，worktree 降为"可选、非当前要务"；内置 profile 精简为 `general` + `explorer` 二元（已落地）。下列各项为**验证过的储备设计**，按需启用，不排期：

1. **worktree 隔离**（§3.1）—— 设计已定稿：懒建于 run 启动、清理收敛到 session 释放点、`pi.exec` shell 实现。**前置**：统一 `dispose()`/`releaseSession()` 释放路径；动工前定脏树处置策略（§7-D）。
2. **fork 上下文**（§3.3）—— 可行性已确认，倾向内存重放路线；作为 spawn 可选项，出现顾问型真实需求再动工。
3. **轻量链式 + 配套 wait**（§3.2/3.4）—— 默认不做，出现真实多级编排需求再评估（§7-E）。

---

## 7. 后续待调研

> §7-B/§7-C 已由两个后台审计 agent 闭环，结论并入 §3；剩余是设计决策项（D/E）与参考项（A）。

- **A.（参考项，不阻塞）竞品 worktree 精确生命周期**：`git worktree` 在竞品里由哪个文件/函数创建、以什么 base commit/branch、在成功/失败/abort/进程退出各自何处清理。我方绑定设计已凭 §7-B 自立，此项仅作实现期对照。
- **B. 我方 controller 落地点（已闭环，并入 §3.1/§3.2）**：cwd 单一解析点 `prepareLaunchSpecs`（controller.ts:779，恒存绝对路径）；终止侧**无统一 teardown** —— 状态转终态散落 4 处（完成/异常/maxTurns/stop），资源释放仅 `releaseSession()`（1244，由 fresh-restart 958 与 clear 1503 调用）与 `dispose()` 内联块（609-616）两处且未统一；终态 session 故意保活支持续跑；防重入靠 `generation` 计数；队列为 id 数组 + `pumpQueue`（918-943）`shift()` 出队。
- **C. Pi API：fork 可达性（已闭环，并入 §3.3）**：`ctx.sessionManager: ReadonlySessionManager` 暴露父历史（`getEntries/getBranch/buildContextEntries/getLeafId/getSessionFile`）；`createAgentSession({ sessionManager })` 自动以既有历史起步；`SessionManager.forkFrom/open/branch/createBranchedSession/append*` 为一等能力；git/worktree **无公开 API**，须 `pi.exec("git", ...)` 自行 shell。**残留核验**：内存重放路线所需 `append*` 族精确签名与条目→消息映射。
- **D. worktree 产出合并策略（唯一阻塞 §3.1 动工的决策）**：worker 在隔离树内的改动如何回到主树。§3.1 已给倾向：干净则删、脏则保留并报路径，由 parent/用户显式合并；待定的是最终确认与是否提供辅助合并命令。
- **E. 链式必要性判断**：收集我方真实使用中是否出现多级依赖编排，决定 §3.2 做/不做（避免为假想需求引入 DAG 调度复杂度）。

---

*报告状态：两轮代码审计已闭环，worktree（§3.1）与 fork（§3.3）均为验证过的设计。未决项仅 §7-D/E 两个产品决策。本报告不含开发承诺，动工前过用户评审。*
