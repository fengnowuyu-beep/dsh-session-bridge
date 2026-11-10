# dsh-session-bridge

给 DSH 增加三个 Host 工具：

- `session_send`：把用户消息投递到**另一个 DSH 会话**，由宿主 `sessionController.prompt` 完成准入；
- `session_create`：**新建空白会话**，可指定工作区/目录、标题、模型与推理强度；
- `workspace_create`：**新建或复用工作区**，可创建目录并命名。

v0.3 起：

- **没有目标白名单**——任何普通会话都可以指定；
- 不只发文本，还可以带**图片和附件**；附件支持**本机文件路径、`file://` URL、http(s) URL**；
- 图片作为图片内容发送；目标模型不支持视觉时，**自动降级为文件附件**；
- 新建会话时可以显式指定 `provider` + `model` + `reasoningEffort`；都不传则沿用宿主默认；
- 新建工作区默认会递归创建目录，也可以要求目录必须已存在。

它适合这些场景：

- 让一个会话把结论、提醒或交接内容发给另一个正在等待的会话；
- 从一个"调度"会话把任务分派给多个已经存在的会话；
- 把本机图片、报告、日志或下载到的文件投递给另一个会话；
- 用代码/工具链批量开新会话、新工作区，而不是手点 UI。

它**不会**修改已有会话的历史、不会伪造助手消息。`session_send` 投递成功只代表宿主已受理并放进目标会话的队列，**不代表目标已经回答**。

---

## 1. 文件结构

```text
dsh-session-bridge/
├─ package.json             # DSH bundle 清单
├─ cordis.patch.yml         # 向 profile 插入 session-bridge 行
├─ lib/
│  ├─ index.js              # 插件入口：注册三个工具
│  ├─ session-tools.js      # session_create / workspace_create
│  ├─ errors.js             # 共享错误类型
│  ├─ services.js           # 可选 Host 服务解析
│  ├─ config.js             # 配置归一化
│  └─ attachments.js        # 本机/URL 附件、图片识别、流式上传
├─ test/                    # 零依赖离线测试（node:test）
├─ test-support/
│  └─ fake-host.mjs         # 假 Host / controller / fileUploads / fetch
├─ tools/
│  └─ check-host.mjs        # 直接从 app.asar 核对宿主 API 契约
├─ docs/
│  └─ VERIFICATION.md       # 本次验证记录
└─ README.md
```

没有构建步骤，也没有运行时 npm 依赖。

---

## 2. 安装

### 2.1 前置条件

- DSH Desktop 或 Web 组合（必须挂载 `@deepseek-ai/dsh-api-session-controller`，它提供 `sessionController`）。
- 普通文件附件需要宿主挂载 `fileUploads` 服务（`@deepseek-ai/dsh-client-file-upload`，桌面 / Web 组合默认有）。
- `dsh-headless` 组合默认**没有** sessionController，因此插件不会注册工具。
- 安装 Host 插件后需要**重启 DSH** 才会生效。

### 2.2 装进 profile（本地 bundle）

下面以 desktop profile、插件放在
`E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-session-bridge`
为例。

1. 编辑 `~/.dsh/profiles/<profile>/package.json`，把插件同时加进
   `dependencies` 和 `dsh.profile.bundles`：

   ```json
   {
     "dependencies": {
       "dsh-session-bridge": "file:E:/Data/Project/DeepSeekHarness/DSH-Homemade-Plugins/dsh-session-bridge"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "...原有 bundle...",
           "dsh-session-bridge"
         ]
       }
     }
   }
   ```

2. 在 profile 目录安装依赖（或使用 DSH 插件管理器完成同样的 pnpm 安装）：

   ```powershell
   dsh plugin --profile desktop install
   ```

3. 按下一节按需配置 `allowFileRoots` / `allowPrivateUrls`。

4. 重启 DSH。

> 只想临时试装时，也可以把 profile 复制一份（例如 `probe`）再改，
> 用 `dsh --profile probe` 启动，避免影响日常配置。

---

## 3. 配置

插件在 profile 里是一行 Loader 配置。bundle 自带的 `cordis.patch.yml` 已经插入这一行，默认值如下：

```yaml
- insert:
    - id: session-bridge
      name: 'dsh-session-bridge'
      config:
        sendMode: queue
        allowFileRoots: []
        allowPrivateUrls: false
```

要收紧配置，在 **profile 自己的** `cordis.patch.yml` 里按同一个 `id` 覆盖（不是再 insert 一行）：

```yaml
- id: session-bridge
  name: dsh-session-bridge
  config:
    enabled: true
    sendMode: queue
    allowFileRoots:
      - E:/Data/Project/DeepSeekHarness
    allowPrivateUrls: false
```

### 3.1 配置项

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` 时插件不注册 `session_send`。 |
| `sendMode` | `"queue"` / `"steer"` | `"queue"` | `queue`：目标空闲时开始新回合，运行中时排队；`steer`：把消息插入正在运行的回合，更打断。 |
| `allowFileRoots` | string[] | `[]` | 非空时，本机附件必须落在这些根目录内（会先做 `realpath`）；空数组 = **不限制本机路径**。 |
| `allowPrivateUrls` | boolean | `false` | `false` 时拒绝 `localhost`、`127.0.0.1`、常见内网 IP 字面量 URL；`true` 时放行。 |

**没有插件级固定上限**：

- 不限制附件数量、总字节数或文本长度；本机文件与 URL 下载都按流处理，不会整块读进内存；
- URL 下载只有操作性的**时间/重定向**保护（默认 30 秒、最多 5 次重定向），不是载荷上限；
- 单个文件上传有 120 秒操作超时；
- 真实上限来自宿主自身：图片的格式/尺寸/字节限额由 `fileUploads.uploadImageStream` 和附件服务执行，
  prompt 长度最终受模型上下文限制；宿主拒绝时插件会把错误原样转述。

### 3.2 怎么拿到 sessionId

- 目标会话的 ID 形如 `session-<uuid>`，可以从 DSH 的会话信息 / 链接里复制；
- 当前会话的 ID 就在环境变量 `DSH_SESSION_ID` 里；
- 也可以从 `~/.dsh/sessions/<工作区目录>/` 下的会话目录名核对（以实际会话 header 为准）。

---

## 4. 工具用法

### 4.1 工具签名

```json
{
  "name": "session_send",
  "parameters": {
    "sessionId": "string（必填）",
    "text": "string（可选；text 与 attachments 至少一个）",
    "attachments": "string[]（可选；本机路径 / file:// / http(s) URL）"
  }
}
```

```json
{
  "name": "session_create",
  "parameters": {
    "cwd": "string（可选；绝对路径，与 workspaceId 二选一）",
    "workspaceId": "string（可选；与 cwd 二选一）",
    "title": "string（可选）",
    "provider": "string（可选；必须与 model 同时提供）",
    "model": "string（可选；必须与 provider 同时提供）",
    "reasoningEffort": "string（可选）"
  }
}
```

```json
{
  "name": "workspace_create",
  "parameters": {
    "path": "string（必填；绝对目录）",
    "title": "string（可选）",
    "createDirectory": "boolean（可选；默认 true）"
  }
}
```

### 4.2 只发文本

```json
{
  "sessionId": "session-00000000-0000-0000-0000-000000000000",
  "text": "构建已完成，结果在 dist/ 目录；请接着做验收。"
}
```

### 4.3 发图片

```json
{
  "sessionId": "session-00000000-0000-0000-0000-000000000000",
  "text": "这是最新的界面截图。",
  "attachments": ["E:/Data/Project/screenshots/ui.png"]
}
```

- 图片按文件头识别 PNG / JPEG / WebP / GIF；
- 通过 `fileUploads.uploadImageStream` 传到目标会话，宿主会做格式、尺寸和字节规范化；
- 目标模型必须支持视觉，否则自动降级为文件附件（见 4.5）。

### 4.4 发普通文件或 URL

```json
{
  "sessionId": "session-00000000-0000-0000-0000-000000000000",
  "text": "报告和构建日志在附件里。",
  "attachments": [
    "E:/Data/Project/report.pdf",
    "https://example.com/releases/build.log"
  ]
}
```

- 普通文件会通过 `fileUploads.uploadStream` 流式存进目标会话的附件存储；
- 目标模型不会直接收到文件字节，而是收到一行带**只读路径**的说明，目标会话自己用文件工具去读；
- URL 会先下载到系统临时文件，再流式上传；发送结束（成功或失败）后临时文件自动删除；
- URL 支持 http(s)，默认拒绝本机/内网 IP 字面量；需要本地开发服务器时设 `allowPrivateUrls: true`；
- 相对路径按**调用方会话的 cwd** 解析。

### 4.5 图片降级

如果目标会话当前模型不支持图片输入，宿主会以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝第一次准入。插件会自动：

1. 把图片原字节作为普通文件上传到目标会话；
2. 用文件附件重新投递同一段文本/附件；
3. 返回 `imageFallback: true`。

这样弱模型会话至少能拿到图片的只读路径，而不是整条消息失败。

### 4.6 成功返回

```json
{
  "sent": true,
  "sessionId": "session-00000000-0000-0000-0000-000000000000",
  "requestId": "8f14e45f-ceea-467f-a8b0-7c1d2e3f4a5b",
  "mode": "queue",
  "attachments": 2,
  "images": 1,
  "files": 1,
  "imageFallback": false
}
```

工具结果里的提示文本会明确写"宿主已受理，不代表对方已回复"，避免模型把"已投递"说成"已送达"。

### 4.7 宿主 API 契约

插件内部调用：

```js
sessionController.prompt({
  requestId: crypto.randomUUID(),
  sessionId,
  mode: 'queue' | 'steer',
  content: [
    { type: 'text', text },
    { type: 'image', attachment, encodedBytes },
    { type: 'file', receiptId }
  ]
}, abortSignal)
```

图片通过：

```js
fileUploads.uploadImageStream({
  sessionId,
  name,
  mediaType,
  data: asyncIterable,
  signal
})
```

返回 `{ receiptId, image }`，其中 `image` 就是上面的 stored image part。普通文件通过：

```js
fileUploads.uploadStream({
  sessionId,
  name,
  data: asyncIterable,
  signal
})
```

换取 `receiptId`。`requestId` 用于宿主侧的准入幂等；`abortSignal` 必须是真正的 `AbortSignal`。

---

### 4.8 新建会话

```json
{
  "workspaceId": "5e0d206a-9c0d-412f-bd7f-7ce7e65f8b50",
  "title": "跨会话创建测试会话",
  "provider": "deepseek-account",
  "model": "deepseek-flash",
  "reasoningEffort": "max"
}
```

- `cwd` 与 `workspaceId` 只能给一个；两个都不给时用宿主默认目录；
- `provider` 与 `model` 必须成对出现；只给 `reasoningEffort` 时使用宿主模型目录里的默认模型；
- 三个模型参数都不给时，使用宿主默认模型，不改变会话选择；
- 模型 ID 和推理强度会在**创建前**对照 `modelCatalog()` 校验；未知值直接报错并列出可用项，不会留下配置错误的空会话；
- `title` 会调用 `rename`；失败时错误里带已创建的 `sessionId`；
- 返回 `{ created, sessionId, workspaceId, cwd, title, provider, model, reasoningEffort }`。

注意：`session_create` 只创建空白会话，不发消息；标题通常要等第一条消息后才会自动生成，除非显式传 `title`。

### 4.9 新建工作区

```json
{
  "path": "C:/Users/Kaede/AppData/Local/Temp/dsh-shots/bridge-workspace-test",
  "title": "跨会话测试工作区",
  "createDirectory": true
}
```

- `path` 必须是绝对路径；`createDirectory` 默认 `true`，会递归创建缺失目录；
- 同一目录已有工作区时复用，返回 `created: false`；
- `title` 会重命名工作区；不传则使用目录名；
- 工作区注册不会删除目录、文件或会话；删除工作区请在 UI 里操作；
- 依赖宿主 `workspaceController`；桌面 / Web 组合默认有，headless 组合可能没有。

---

## 5. 安全模型与风险

v0.2 **移除了目标白名单**。这意味着：

1. **任意会话可写。** 模型（或提示注入）可以把消息写进任何普通会话，包括你不想打扰的会话。
2. **本机文件可读。** 默认 `allowFileRoots: []` 不限制路径；模型能读到的本机文件就可能被发到别的会话。建议按需填写允许的根目录。
3. **URL 可下载。** 默认只拦明显的 `localhost` / 内网 IP 字面量；它**不是**完整的 SSRF 防护，公网域名解析到内网地址的情况没有被钉住。只让模型处理可信 URL。
4. **普通文件会持久保存。** 宿主的附件存储不会自动删除；发出去的文件会一直保留。
5. **模式由运维决定。** 模型不能把 `queue` 改成 `steer`，`sendMode` 只读配置。
6. **没有插件级固定上限。** 附件数量、总字节数、文本长度都不在插件里设死；文件流式处理，URL 下载到临时文件，发送后删除。真实限制来自宿主（图片规范化限额、模型上下文）和磁盘/网络。
7. **有记录。** 每次成功准入写一行 Host 日志：`session-bridge: delivered <requestId> to <sessionId> (...)`。
8. **工作区会写文件系统。** `workspace_create` 在 `createDirectory` 为 true 时会在任意绝对路径下递归建目录；这是比发消息更强的写操作。只让模型处理可信路径。
9. **新建会话会消耗资源。** 空会话本身不贵，但随后投递消息会启动模型回合；显式指定模型/强度时请确认目标模型 ID。

仍然需要注意：向正在运行的会话 `steer` 会打断它当前的步骤；向空闲会话发送会**唤醒**它并消耗模型额度。

---

## 6. 验证

### 6.1 离线测试（不需要启动 DSH）

```powershell
cd E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-session-bridge
node --test
```

结果：**68 / 68 通过**。

覆盖：配置归一化、无白名单目标、文本/附件至少一个、本机路径、相对路径、`allowFileRoots`、`file://`、http(s) 下载、重定向、无数量上限、内网 URL 拒绝、图片魔数识别、图片流式上传、普通文件上传 receipt、文本+图片+文件顺序、图片降级、降级时复用已上传文件、`fileUploads` 缺失、`accepted:false`、AbortSignal、`enabled:false`、输出文案；以及 `session_create` 的 cwd/workspaceId 二选一、标题、模型/强度校验与失败路径，`workspace_create` 的建目录、复用、改名与失败路径。

### 6.2 宿主契约检查（读取已安装的 app.asar）

```powershell
node tools/check-host.mjs
```

它会直接读 `D:\Software\DeepSeek Harness\resources\app.asar`，核对：

- `sessionController` 服务名、`prompt(request, signal)`、`queue` / `steer` 分支、`list`；
- `sessionController.create` / `selectModel` / `rename` / `modelCatalog`；
- `hasPromptContent`、文件 receipt 解析；
- `fileUploads` 服务名、`uploadStream` / `uploadImageStream`；
- `workspaceController` 服务名、`create` / `rename`、`workspaceRegistry.create(request.path)`。

结果：**20 / 20 通过**。如果 DSH 升级后这里失败，先别发消息，按报错项核对新版 API。

### 6.3 真机验证（安装并重启后）

1. 用 `workspace_create` 建一个临时工作区（也可在 UI 里先建）。
2. 用 `session_create` 在该工作区建会话，例如：
   ```json
   {
     "workspaceId": "<上一步的 workspaceId>",
     "title": "跨会话创建测试会话",
     "provider": "deepseek-account",
     "model": "deepseek-flash",
     "reasoningEffort": "max"
   }
   ```
   预期返回 `created: true` 和新 `sessionId`，侧栏出现对应工作区/会话。
3. 打开另一个会话，对助手说：
   「用 session_send 给 `<sessionId>` 发一条：跨会话测试」。
4. 再准备一张小图片和一个文本文件，分别试：
   「把 `C:/path/pixel.png` 和 `C:/path/notes.txt` 用 session_send 发给 `<sessionId>`，文字写：附件测试」。
5. 预期：
   - 工具返回 `sent: true`；
   - 目标测试会话里出现一条**用户消息**，图片可预览，文件显示为附件/只读路径；
   - 如果目标空闲，它会开始一个新回合（会消耗模型额度）；
   - 如果目标模型不支持图片，结果里 `imageFallback: true`，图片以文件附件出现。
6. 若配置了 `allowFileRoots`，再试一个根目录外的文件，预期报 `file-outside-roots`，目标会话没有新消息。

本仓库的真实桌面验证记录见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

---

## 7. 卸载

1. 从 profile 的 `package.json` 中删除 `dsh-session-bridge`（`dependencies` 和 `dsh.profile.bundles` 两处）。
2. 在 profile 目录执行 `dsh plugin --profile <profile> install`。
3. 删除 profile `cordis.patch.yml` 中的 `session-bridge` 配置行。
4. 重启 DSH。

---

## 8. 已知限制

- 只面向**普通会话**；subagent 会话可能被宿主的 ownership fence 拒绝，已归档会话可能被 archived gate 拒绝。
- 音频/视频没有专门处理；会按普通文件附件发送。
- 图片只支持 PNG / JPEG / WebP / GIF；其他格式按普通文件处理。
- 目标会话模型不支持视觉时，只能降级为文件附件，不能强制让模型看图。
- 没有图形设置页；配置是 profile 的 YAML。
- `dsh-headless` 组合没有 sessionController，插件不会生效。

---

## 9. 版本

- `0.3.0`：新增 `session_create`（cwd/workspaceId、标题、provider/model/reasoningEffort）和 `workspace_create`（建目录、注册、改名）；模型/强度在创建前校验；补齐离线测试与真实桌面验证。
- `0.2.0`：移除目标白名单；支持本机路径、`file://`、http(s) URL 附件；图片流式上传 + 普通文件 receipt；目标模型不支持图片时自动降级；新增 `allowFileRoots` / `allowPrivateUrls`；移除插件级附件/文本上限。
- `0.1.0`：首个版本。`session_send` + 精确白名单 + `queue`/`steer` + 离线测试 + 宿主契约检查。
