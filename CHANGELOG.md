# Changelog

## 0.3.0

- 新增 `session_create`：按 cwd 或 workspaceId 新建空白会话，可设标题、provider/model、reasoningEffort。
- 新增 `workspace_create`：默认递归创建目录并注册工作区，可设名称；已有工作区复用。
- 模型与推理强度在创建前对照 `sessionController.modelCatalog()` 校验；未指定时沿用宿主默认。
- 新增共享 `errors.js`、`services.js`、`session-tools.js` 与对应测试。
- 宿主契约检查扩展到 20 项；真实桌面实例验证了工作区、会话创建和后续投递。

## 0.2.0

- 移除目标会话白名单：任意普通会话都可作为 `sessionId`。
- 移除插件级固定上限：不限制附件数量、总字节数或文本长度。
- 本机文件、`file://`、http(s) URL 都支持；文件与图片改为流式上传，URL 先落临时文件并在发送后清理。
- 图片通过 `fileUploads.uploadImageStream` 发送；目标模型不支持视觉时自动降级为文件附件。
- 新增可选配置 `allowFileRoots`、`allowPrivateUrls`。
- 扩充离线测试、宿主契约检查与隔离实例验证记录。

## 0.1.0

- 首个版本：`session_send`、精确 `allowedSessionIds` 白名单、`queue` / `steer`、离线测试与宿主契约检查。
