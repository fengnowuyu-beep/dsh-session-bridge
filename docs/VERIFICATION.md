# 验证记录

- 日期：2026-11-11
- 环境：Windows，Node.js v24.15.0，DeepSeek Harness `0.2.2-rc.1`
- 插件版本：`0.3.0`

## 1. 离线测试

```powershell
cd dsh-session-bridge
node --test
```

结果：**68 / 68 通过**。

覆盖范围：

- 配置归一化、无目标白名单、任意 sessionId；
- 文本/附件至少一个、本机路径与相对路径、`allowFileRoots`、`file://`、http(s) 下载、重定向；
- 无附件数量/总字节/文本长度上限、内网 URL 拒绝；
- 图片魔数识别、图片流式上传、普通文件流式上传 receipt、文本+图片+文件顺序；
- 图片降级、降级时复用已上传文件、`fileUploads` 缺失；
- `session_create`：cwd / workspaceId 二选一、标题、provider/model/reasoningEffort 校验、未知模型/强度、创建/选模型/改名失败；
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
  `create`、`rename`、`workspaceRegistry.create(request.path)`。

结果：**20 / 20 通过**（三个包版本均为 `0.2.2-rc.1`）。

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

## 5. 当前保留的测试对象

- 工作区「跨会话测试工作区」
- 会话「跨会话创建测试会话」
- 会话「跨会话发送测试目标会话」

它们保留在侧栏方便复查；不需要时可在 DSH UI 中删除。临时目录 `%TEMP%\dsh-shots\bridge-workspace-test` 可随工作区一起清理。
