<div align="center">

# 🐦 OpenProxy

### 一个轻巧的本地 AI 代理小工具

把 Claude Code、Pi、OpenCode 连接到 OpenCode 免费模型，  
也可以接入你自己的 OpenAI / Anthropic 兼容服务。

**本地运行 · 双协议接口 · 一键接入 · 隐私过滤**

</div>

---

## ✨ 它能做什么？

| 功能 | 说明 |
|---|---|
| 🔌 双协议接口 | 同时提供 OpenAI-compatible 和 Anthropic-compatible 本地接口 |
| 🎁 免费模型 | 在线获取 OpenCode 免费模型，离线或获取失败时提示刷新失败 |
| 🧩 自定义上游 | 支持接入自己的 OpenAI / Anthropic 兼容服务 |
| 🧭 模型前缀 | 使用 `opencode/` 和 `custom/` 明确区分模型来源 |
| 🕵️ 隐私过滤 | 请求发往上游前自动脱敏邮箱、手机号、密钥等敏感信息 |
| 🧰 一键接入 | 自动配置 Claude Code、Pi、OpenCode |
| 🌐 局域网访问 | 可在仅本机访问和局域网访问之间切换 |
| 🪟 托盘应用 | 以 Windows 系统托盘程序运行，左键展开或收起面板 |

---

## 🚀 快速开始

### 1. 打开 OpenProxy

双击启动 OpenProxy，应用会出现在系统托盘中。

### 2. 展开小面板

左键点击托盘图标，即可展开或收起 OpenProxy 面板。

### 3. 启动本地服务

点击面板里的“启动服务”。

默认监听地址：

```text
127.0.0.1:3210
```

### 4. 复制接口地址和 API Key

面板中会显示本地接口地址和访问密钥。

常用地址：

```text
OpenAI Base URL:     http://127.0.0.1:3210/v1
Anthropic Base URL:  http://127.0.0.1:3210
```

### 5. 选择模型来源

你可以选择：

- 🎁 OpenCode 免费模型
- 🧩 自定义服务

如果使用自定义服务，需要填写：

- Base URL
- API Key

保存后，OpenProxy 会尝试检测该服务的模型列表。

### 6. 一键接入工具

在工具区域中选择：

- Claude Code
- Pi
- OpenCode

点击对应按钮后，OpenProxy 会自动写入本地配置。

### 7. 开始使用

启动 Claude Code、Pi 或 OpenCode，就可以通过 OpenProxy 使用本地代理模型了。

---

## 🔗 本地接口

| 协议 | Base URL | 主要接口 |
|---|---|---|
| OpenAI-compatible | `http://127.0.0.1:3210/v1` | `POST /v1/chat/completions` |
| Anthropic-compatible | `http://127.0.0.1:3210` | `POST /v1/messages` |
| 模型列表 | `http://127.0.0.1:3210/v1` | `GET /v1/models` |

请求需要携带 OpenProxy 面板中展示的 API Key。

```http
Authorization: Bearer <OpenProxy API Key>
```

也可以使用：

```http
x-api-key: <OpenProxy API Key>
```

---

## 🧭 模型 ID 规则

OpenProxy 不维护默认模型，模型由调用方请求中的 `model` 字段决定。

为了避免不同来源的模型重名，所有模型 ID 都需要带来源前缀：

```text
opencode/<上游模型 ID>
custom/<上游模型 ID>
```

### 🎁 OpenCode 免费模型

```text
opencode/deepseek-v4-flash-free
opencode/mimo-v2.5-free
```

### 🧩 自定义服务模型

```text
custom/gpt-4.1-mini
custom/deepseek-chat
custom/openai/gpt-4.1
```

如果请求中传入未带来源前缀的模型，例如：

```text
gpt-4.1-mini
```

OpenProxy 会拒绝请求，并提示改用：

```text
opencode/<model>
```

或：

```text
custom/<model>
```

---

## 🎁 OpenCode 免费模型

OpenProxy 会从在线模型列表中获取 OpenCode 免费模型，并通过本地 `/v1/models` 返回 OpenAI 风格的模型列表。

返回的模型会统一加上 `opencode/` 前缀。

如果无法联网获取模型列表，OpenProxy 不会展示伪造的备用模型；面板会提示加载失败。请恢复网络后刷新，或切换到自定义服务。

OpenCode 免费模型模式下：

- OpenAI `/v1/chat/completions` 请求会直接转发到 OpenCode OpenAI-compatible 接口。
- Anthropic `/v1/messages` 请求会先转换为 OpenAI tools 请求，再将响应转换回 Anthropic 格式。

---

## 🧩 自定义上游

如果你有自己的模型服务，可以在 OpenProxy 中配置自定义上游。

支持填写服务根地址或常见 OpenAI-compatible 地址，例如：

```text
https://example.com
https://example.com/v1
https://example.com/v1/chat/completions
```

OpenProxy 会自动尝试推导这些接口：

```text
/v1/models
/models
/v1/chat/completions
/chat/completions
/v1/messages
```

如果某个候选地址成功，OpenProxy 会记住解析后的服务根路径，后续请求会优先使用该路径。

自定义上游模式下：

- OpenAI 请求会透传到自定义 OpenAI-compatible 接口。
- Anthropic 请求会透传到自定义 Anthropic-compatible `/v1/messages` 接口。
- 实际支持的模型能力取决于上游服务本身。

---

## 🧰 工具接入

### Claude Code

Claude Code 通过 Anthropic 协议接入 OpenProxy。

OpenProxy 会写入 Claude Code 的本地配置，使其使用：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:3210
ANTHROPIC_AUTH_TOKEN=<OpenProxy API Key>
```

同时可以为 Claude 的不同模型槽位配置对应的 OpenProxy 模型 ID：

```text
ANTHROPIC_DEFAULT_OPUS_MODEL
ANTHROPIC_DEFAULT_SONNET_MODEL
ANTHROPIC_DEFAULT_HAIKU_MODEL
```

这些模型 ID 同样需要使用：

```text
opencode/<model>
custom/<model>
```

### Pi

Pi 通过 OpenAI-compatible 接口接入 OpenProxy。

OpenProxy 会写入 Pi 的模型配置，使其使用：

```text
http://127.0.0.1:3210/v1
```

同时会把当前模型列表同步到 Pi 的配置中。

### OpenCode

OpenCode 通过 OpenAI-compatible provider 接入 OpenProxy。

OpenProxy 会写入本地 OpenCode 配置，新增 `openproxy` provider，并同步当前可用模型。

---

## 🕵️ 隐私模式

OpenProxy 内置隐私过滤器，可在请求进入上游模型前对文本内容进行不可逆脱敏。

当前支持检测和替换：

- 邮箱
- 中国大陆手机号
- 身份证号
- 银行卡号
- IPv4 地址
- 常见 API Key / Token / Secret
- 高熵疑似密钥字符串

示例：

```text
我的邮箱是 user@example.com
```

会被替换为：

```text
我的邮箱是 [PRIVATE_EMAIL]
```

隐私模式可在 OpenProxy 面板中开启或关闭。

覆盖范围包括：

- OpenAI-compatible 请求中的 `messages` 文本内容
- Anthropic-compatible 请求中的 `messages` 文本内容
- Anthropic-compatible 请求中的 `system` 字符串和 text block
- 默认也会处理 assistant 历史消息和 `tool_result` 文本

非文本内容以及 Anthropic `system` 中非 text block 会保持原样。

---

## 🌐 局域网访问

默认情况下，OpenProxy 只监听本机地址：

```text
127.0.0.1
```

如果需要让局域网内其他设备访问，可以在面板中开启局域网访问。

开启后服务监听：

```text
0.0.0.0:3210
```

面板会显示可用于局域网访问的地址。

> ⚠️ 开启局域网访问后，同一网络内其他设备可能访问该代理服务。请妥善保管 API Key。

---

## 🪟 安装

下载 Windows 安装包后双击安装即可。

支持的安装包类型通常为：

- `.msi`
- `.exe`

安装完成后启动 OpenProxy，应用会出现在系统托盘中。

---

## 🛠️ Windows 自行构建

如需自行构建 Windows 安装包，建议在 Windows 原生环境中执行。

### 环境要求

请先安装：

- Node.js 18+
- Rust stable
- Visual Studio C++ Build Tools
- Microsoft Edge WebView2 Runtime

Windows 11 通常已自带 WebView2 Runtime。

### 安装依赖

在项目根目录执行：

```bash
npm install
```

然后进入前端目录安装依赖：

```bash
cd frontend
npm install
```

### 构建前端

```bash
npm run build
```

返回项目根目录：

```bash
cd ..
```

### 构建 Tauri 安装包

```bash
npm run tauri:build
```

默认产物目录：

```text
src-tauri/target/release/bundle/msi/
src-tauri/target/release/bundle/nsis/
```

其中：

- `msi/` 通常包含 `.msi` 安装包
- `nsis/` 通常包含 `.exe` 安装包

具体产物取决于 Tauri 打包配置和本机环境。

---

## 🧪 开发命令

### 启动 Node 代理

```bash
npm start
```

或：

```bash
npm run dev
```

### 运行 Node 测试

```bash
npm test
```

### 通过环境变量传入敏感密钥

Tauri 桌面端启动 Node 代理时，会通过环境变量传递敏感密钥，避免出现在进程命令行参数中。

Node 代理也支持直接读取这些环境变量：

```text
OPENPROXY_API_KEY=<OpenProxy 本地访问密钥>
OPENPROXY_CUSTOM_API_KEY=<自定义上游 API Key>
OPENPROXY_OPENCODE_UPSTREAM_API_KEY=<OpenCode 上游 API Key>
OPENPROXY_CONFIG_PATH=<运行时配置文件路径>
```

非敏感配置仍可通过 CLI 参数覆盖，例如：

```bash
node src/index.js --host 127.0.0.1 --custom-base-url https://example.com/v1
```

兼容旧脚本的 `--api-key`、`--custom-api-key`、`--opencode-upstream-api-key` 参数仍可被 Node 解析，但不建议使用。

### 启动 Tauri 开发模式

```bash
npm run tauri:dev
```

### 构建前端

```bash
npm --prefix frontend run build
```

### 构建桌面应用

```bash
npm run tauri:build
```

---

## 🧯 常见问题

### 构建时出现旧路径错误

如果构建时出现类似：

```text
failed to read plugin permissions ... Downloads\openproxy-main\...
```

通常是 `src-tauri/target` 中残留了旧工作目录缓存。

可以清理后重新构建：

```powershell
Remove-Item -Recurse -Force .\src-tauri\target
npm run tauri:build
```

### 安装版无法启动代理服务

请确认系统中可以正常执行：

```bash
node --version
```

OpenProxy 当前通过 Node 子进程运行本地代理服务，因此需要可用的 Node.js 环境。

### 模型列表为空

可以尝试：

1. 确认代理服务已经启动。
2. 点击刷新模型列表。
3. 检查网络是否可以访问模型来源。
4. 如果使用自定义服务，确认 Base URL 和 API Key 有效。

### 查看日志

如果安装版运行异常，可以查看临时日志：

```text
%TEMP%\openproxy-debug.log
%TEMP%\openproxy-node.log
```

---

## 🧱 项目结构

```text
openproxy/
├─ src/
│  ├─ index.js
│  ├─ server.js
│  ├─ config.js
│  ├─ runtime-config.js
│  ├─ convert.js
│  ├─ models.js
│  └─ proxy/
│     ├─ backend.js
│     ├─ handlers.js
│     ├─ upstream.js
│     ├─ models-service.js
│     ├─ middleware.js
│     ├─ privacy-filter.js
│     ├─ logging.js
│     └─ errors.js
├─ frontend/
│  └─ src/
│     ├─ App.vue
│     ├─ main.js
│     └─ components/
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  └─ src/main.rs
└─ test/
   ├─ convert.test.js
   └─ proxy-modules.test.js
```

---

## ⚠️ 当前兼容性说明

### OpenCode 免费模型模式

OpenCode 免费模型主要通过 OpenAI-compatible 接口访问。

当客户端请求 OpenAI `/v1/chat/completions` 时，OpenProxy 会直接转发到 OpenCode 上游。

当客户端请求 Anthropic `/v1/messages` 时，OpenProxy 会将请求转换为 OpenAI 格式，并在收到响应后转换回 Anthropic 格式。

该桥接路径支持常见文本、图片、tools、tool_use / tool_result 等格式转换。

### 自定义上游模式

自定义 OpenAI-compatible 请求会透传到用户配置的 OpenAI-compatible 接口。

自定义 Anthropic-compatible 请求会透传到用户配置的 Anthropic-compatible `/v1/messages` 接口。

OpenProxy 不会对自定义上游做复杂能力探测，实际可用能力取决于上游服务本身。

---

## 📄 许可证

MIT License
