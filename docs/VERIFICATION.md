# 验证记录

- 日期：2026-11-11
- 环境：Windows，Node.js v24.15.0，DeepSeek Harness `0.2.2-rc.1`
- 插件版本：`0.2.0`

## 1. 离线测试

命令：

```powershell
cd dsh-session-bridge
node --test
```

结果：**53 / 53 通过**。

覆盖范围：配置归一化、无目标白名单、任意 sessionId、文本/附件至少一个、
本机路径与相对路径、`allowFileRoots`、`file://`、http(s) 下载、重定向、
无附件数量上限、无文本长度上限、内网 URL 拒绝、图片魔数识别、图片流式上传、
普通文件流式上传 receipt、文本+图片+文件顺序、图片降级、降级时复用已上传文件、
`fileUploads` 缺失、`accepted:false`、AbortSignal、`enabled:false`、输出文案。

## 2. 宿主 API 契约检查

命令：

```powershell
node tools/check-host.mjs
```

它直接读取已安装的 `app.asar`（不启动 DSH），核对：

- `@deepseek-ai/dsh-api-session-controller`：`sessionController` 服务名、
  `prompt(request, signal)`、`mode === "steer"` / `agent.steer` /
  `agent.followup`、`list(_request, signal)`、`hasPromptContent`、
  `file` 内容按 receipt 解析；
- `@deepseek-ai/dsh-client-file-upload`：`fileUploads` 服务名、
  `uploadStream(request)`、`uploadImageStream(request)`。

结果：**12 / 12 通过**（会话控制器与文件上传服务版本均为 `0.2.2-rc.1`）。

## 3. 隔离实例真机验证

目的：不触碰用户日常 DSH 的 profile、会话库和正在运行的进程，验证真实
`sessionController` + `fileUploads` 下的完整链路。

做法：

1. 新建临时 `DSH_HOME`，临时 profile 只组合
   `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`。
2. 启动隔离实例：`dsh --profile probe --port 0 --no-open`。
3. 临时探针插件（不随包发布）：
   - 创建空白会话；
   - 用真实 `sessionController` / `fileUploads` 调本插件的 `apply()`，
     再执行 `session_send`；
   - 通过真实 `sessionController.events()` 读取目标会话事件。
4. 结束后删除临时 `DSH_HOME`；真实 `~/.dsh/profiles` 仍只有 `desktop` / `web`。

### 3.1 本机图片 + 普通文件

发送参数：

```json
{
  "sessionId": "session-5cc44d71-...",
  "text": "跨会话附件测试 BRIDGE-PROBE",
  "attachments": ["pixel.png", "notes.txt"]
}
```

结果：

```text
fileUploads.uploadStream: function
fileUploads.uploadImageStream: function
send: {"sent":true,"images":1,"files":1,"imageFallback":false,...}
local events contain probe text: true
local events contain image part: true
local events contain file part: true
```

目标会话事件里确认到：

- `text`：`跨会话附件测试 BRIDGE-PROBE`；
- `image`：宿主已规范化为 `image/webp`，1×1，`name: pixel.png`；
- `file`：`notes.txt`，17 字节，带持久 attachment id；
- 消息的 `source.rpcId` 与工具返回的 `requestId` 一致；
- 随后出现 `turn/start`。

### 3.2 http(s) URL 图片

用一个只监听 `127.0.0.1` 的临时 HTTP 服务提供 PNG，插件配置
`allowPrivateUrls: true` 后发送：

```json
{
  "sessionId": "session-acfcc6ae-...",
  "text": "URL 附件测试 BRIDGE-PROBE-URL",
  "attachments": ["http://127.0.0.1:<port>/url-pixel.png"]
}
```

结果：

```text
url send: {"sent":true,"images":1,"files":0,"imageFallback":false,...}
url events contain probe text: true
url events contain image part: true
```

说明：隔离实例没有配置模型凭据，目标回合在模型请求阶段会失败；本次验证的是
**宿主准入、附件流式上传、图片规范化与消息落库**，不是助手回复内容。

图片降级路径（目标模型不支持视觉）由离线测试覆盖；本次隔离实例的图片准入
没有触发 `MODEL_DOES_NOT_SUPPORT_IMAGES`，所以 `imageFallback` 为 `false`。

## 4. 没有做的验证

没有把插件装进当前正在使用的 `desktop` profile，也没有重启正在运行的 DSH。
原因：这会改用户日常 profile 并影响当前所有会话，应在用户确认后执行。

正式启用步骤见 README 的「安装」与「真机验证」两节。
