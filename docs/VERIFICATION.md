# 验证记录

- 日期：2026-11-11
- 环境：Windows，Node.js v24.15.0，DeepSeek Harness `0.2.2-rc.1`
- 插件版本：`0.3.2`

## 1. 离线测试

```powershell
cd dsh-session-bridge
node --test
```

结果：**70 / 70 通过**。

覆盖范围：

- 配置归一化、无目标白名单、任意 sessionId；
- 文本/附件至少一个、本机路径与相对路径、`allowFileRoots`、`file://`、http(s) 下载、重定向；
- 无附件数量/总字节/文本长度上限、内网 URL 拒绝；
- 图片魔数识别、图片流式上传、普通文件流式上传 receipt、文本+图片+文件顺序；
- 图片降级、降级时复用已上传文件、`fileUploads` 缺失；
- `session_create`：cwd / workspaceId 二选一、cwd 命中已注册工作区时挂载、标题、provider/model/reasoningEffort 校验、**模型选择只改会话不改默认模型**、未知模型/强度、创建/选模型/改名失败；
- `workspace_create`：建目录、复用、改名、缺服务、创建失败；
- `accepted:false`、AbortSignal、`enabled:false`、输出文案。

## 2. 宿主 API 契约检查

```powershell
node tools/check-host.mjs
```

直接读取已安装的 `app.asar`（不启动 DSH），核对：

- `@deepseek-ai/dsh-api-session-controller`：`sessionController` 服务名、
  `prompt`、`list`、`create`、`selectModel`、`rename`、`modelCatalog`、
  `hasPromptContent`、file receipt 解析；
- `@deepseek-ai/dsh-client-file-upload`：`fileUploads` 服务名、
  `uploadStream`、`uploadImageStream`；
- `@deepseek-ai/dsh-api-workspace-controller`：`workspaceController` 服务名、
  `create`、`rename`、`workspaceRegistry.create(request.path)`；
- `@deepseek-ai/dsh-workspace`：`workspaceRegistry.resolveByPath(path)`、
  `Workspace.attachSession(sessionId)`；
- `@deepseek-ai/dsh-agent`：`AgentModel.select(selection)`、会话级
  `model/selection` 事件。

结果：**25 / 25 通过**（相关包版本均为 `0.2.2-rc.1`）。

## 3. 隔离实例附件链路（0.2）

临时 `DSH_HOME` + 临时 profile（`dsh-base` + `dsh-web-app`）中，用真实
`sessionController` / `fileUploads` 调本插件：

- 本机 `pixel.png` + `notes.txt`：`sent: true`，`images: 1`，`files: 1`；
  目标会话事件里确认到文本、`image/webp` 1×1 图片、17 B 文件附件；
- 本地 HTTP 服务提供 PNG，配置 `allowPrivateUrls: true` 后发送：
  `sent: true`，目标事件确认到图片；
- 隔离实例没有模型凭据，目标回合在模型请求阶段会失败；验证的是
  **宿主准入、附件流式上传、图片规范化与消息落库**。

## 4. 真实 desktop 实例

插件通过 profile 的 junction 加载：

```text
C:\Users\Kaede\.dsh\profiles\desktop\node_modules\dsh-session-bridge
  -> E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-session-bridge
```

### 4.1 新建工作区

调用：

```json
{
  "path": "C:\\Users\\Kaede\\AppData\\Local\\Temp\\dsh-shots\\bridge-workspace-test",
  "title": "跨会话测试工作区"
}
```

返回：

```text
已创建工作区 跨会话测试工作区
workspaceId 5e0d206a-9c0d-412f-bd7f-7ce7e65f8b50
path C:\Users\Kaede\AppData\Local\Temp\dsh-shots\bridge-workspace-test
```

侧栏实际出现了「跨会话测试工作区」。

### 4.2 新建会话并指定模型/推理强度

调用：

```json
{
  "workspaceId": "5e0d206a-9c0d-412f-bd7f-7ce7e65f8b50",
  "title": "跨会话创建测试会话",
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "reasoningEffort": "max"
}
```

返回：

```text
已创建会话 session-e3a2c9ae-fe7d-4b31-bfb8-455b0d3d16cf
标题：跨会话创建测试会话
工作区：5e0d206a-9c0d-412f-bd7f-7ce7e65f8b50
模型：deepseek-account/deepseek-flash
推理强度：max
```

侧栏的「跨会话测试工作区」下实际出现了「跨会话创建测试会话」。

### 4.3 向新会话投递消息

```json
{
  "sessionId": "session-e3a2c9ae-fe7d-4b31-bfb8-455b0d3d16cf",
  "text": "新工具联调：这个会话由 session_create 创建……现在收到 session_send 的消息。"
}
```

返回 `sent: true`、`requestId f5b78f73-a748-42a1-9360-3ee401bb6952`。目标会话实际开始处理这条消息；测试随后在 UI 里停止，避免继续消耗额度。

### 4.4 此前的真实附件投递（0.2）

目标会话 `session-342e6e4b-027a-4e12-a580-973212931faf` 接收了文本 + `pixel.png` + `notes.txt`；目标助手读取了文件只读路径、校验 sha256，并在对话里确认「文本 + 图片 + 普通文件三种载荷均能跨会话正常送达」。

## 5. HMR 与 cwd 工作区挂载修复

### 5.1 HMR 热替换

不重启 DSH，临时把 `workspace_create` 返回文案加上 `[HMR] `，等待约 5 秒后调用同一已存在工作区，返回立刻带 `[HMR]`；`git restore` 恢复源码后再调用，返回恢复原样。结论：正常 `lib/*.js` 修改会由 HMR 热替换，不需要重启。

### 5.2 IM 测试暴露的问题与修复

`dsh-im-session-b081d597...` 里的测试用：

```json
{"cwd": "E:\\Data\\Project\\DeepSeekHarness\\问答助手", "title": "能力测试：专家团与子代理"}
```

调用了 `session_create`。宿主 `sessionController.create` 只在收到 `workspaceId` 时才执行 `workspace.attachSession`；只给 `cwd` 会创建会话，但不会加入工作区的 `sessionIds`，所以侧栏看不见。该次创建的 `session-f85bb888-e675-4ebf-8730-49656949ed40` 即为未挂载的旧会话。

修复后，`session_create` 会先用 `workspaceRegistry.resolveByPath(cwd)` 找到已注册工作区，再以 `workspaceId` 创建。实测：

```json
{
  "cwd": "E:\\Data\\Project\\DeepSeekHarness\\问答助手",
  "title": "入口修复测试"
}
```

返回：

```text
已创建会话 session-2da12109-3752-4068-99eb-a5135b1163f2
工作区：68777dec-6460-42c0-95fa-0b20214a26c0
```

再通过 `session_send` 投递「只回复 OK」后，DSH 侧栏的「问答助手」下实际出现了「入口修复测试」；`workspace.json` 的该工作区 `sessionIds` 也包含 `session-2da12109-...`。

### 5.3 模型/推理强度默认值隔离

`sessionController.selectModel` 不只是改会话：它还会调用 `agentDefaultModel.saveSelection(selected)`，把同一选择写成 profile 默认值。插件旧实现调用了它，所以会给用户“默认模型被改掉”的观感。

修复后不再调用 `selectModel`：

1. 通过 `agents.get(sessionId)` 或 `sessionController.resolveAgent(sessionId)` 取到会话 Agent；
2. 用 `llm.resolveCallConfig(selection)` 校验；
3. 调用 `agent.model.select(selection)`，只追加会话级 `model/selection` 事件；
4. 不调用 `agentDefaultModel.saveSelection`。

实测：

- 创建 `session-7c37f497-bf21-4c03-89d0-5cc1eab9f445`（`deepseek-account/deepseek-v4-pro` + `high`）后，该会话输入框显示 `DeepSeek-V4-Pro High`；
- 同时新开一个空白对话，输入框仍显示默认 `DeepSeek-V4.1-Flash Max`；
- 用临时探针读取 `agentDefaultModel.currentSelection()` 也是 `deepseek-account/deepseek-flash max`。

结论：模型/推理强度现在**只影响指定会话**，profile 默认值不变。

## 6. 当前保留的测试对象

- 工作区「跨会话测试工作区」
- 会话「跨会话创建测试会话」
- 会话「Pro/High 模型测试」
- 会话「跨会话发送测试目标会话」
- 问答助手工作区下的会话「入口修复测试」
- 问答助手工作区下的会话「会话级模型修复测试2」（`session-7c37f497...`）
- 旧的无工作区归属会话「能力测试：专家团与子代理」（`session-f85bb888...`，修复前创建）

它们保留在侧栏方便复查；不需要时可在 DSH UI 中删除。临时目录 `%TEMP%\dsh-shots\bridge-workspace-test` 可随工作区一起清理。
