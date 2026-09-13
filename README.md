# dsh-android-ssh

把官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）搬到 Android 手机上：**手机上是 dsh 原版界面，代码和命令在你的服务器上跑**。

- 手机端：官方 dsh `0.1.5-rc.2` 原版 Web UI（全屏，无自制页面）、对话历史、插件、Skill、模型 Key
- 服务器端：只需原本就有的 SSH（`sshd` + bash），**不安装 dsh、不安装任何客户端**
- 文件、命令、终端、编译、测试全部通过 SSH/SFTP 在你的服务器执行

## 它长什么样

装好后打开就是 dsh 原版界面。SSH 配置在：

```
dsh 设置 → 插件 → 插件配置 → SSH 远程执行
```

## 安装

从 [Releases](../../releases) 下载 `dsh-android-*.apk`，传到手机安装（需允许「未知来源」）。

首次启动会解压内置运行环境，**需要等一会**（约 127 MB）。

## 使用

1. 打开 App，等 dsh 界面出现
2. 进 `设置 → 插件 → 插件配置 → SSH 远程执行`
3. 填服务器地址、端口、用户名、密码或私钥、远程工作目录
4. 点「测试连接」，首次会显示服务器指纹，确认后保存
5. 之后正常对话，命令与文件都在服务器上执行

## 工作方式

```
┌─────────────── 手机 ───────────────┐        ┌──────── 你的服务器 ────────┐
│  dsh 原版 UI (WebView)             │        │                            │
│  Node 24 + dsh 0.1.5-rc.2          │  SSH   │  bash / 文件 / 编译 / 测试  │
│  对话历史 / 插件 / Skill / 模型 Key │ ─────▶ │  (只需 sshd)               │
│  SSH 插件（本仓库）                 │        │                            │
└────────────────────────────────────┘        └────────────────────────────┘
```

- 模型 API 请求由手机上的 dsh 用你自己的 Key 直接发出，不经过服务器转发
- 服务器不保存 dsh 会话、插件、Skill 或模型 Key
- 全部数据在 App 私有目录，卸载即删除

## 安全设计

- **TOFU 指纹信任**：首次连接确认服务器指纹，之后指纹变化立即阻断
- **凭据独立存储**：密码/私钥/口令通过凭据服务保存，不写入设置文档
- **fail-closed 门禁**：SSH 未连接时禁止新建会话、禁止执行；绝不回退到手机本地执行
- **换服务器只读**：切换服务器或远程目录后，旧会话只能查看

## 仓库结构

```
dsh-android/             Android 外壳（3 个 Java 文件 + Gradle）
  app/src/main/java/app/dsh/shell/
    MainActivity.java      全屏 WebView，连本机 dsh
    DshService.java        前台服务：proot 启动 dsh
    RuntimeInstaller.java  首次运行解压运行时
  scripts/stage-runtime.sh 组装运行时包（Ubuntu + Node + dsh + 插件）

dsh-ssh/                 SSH 执行插件（dsh 外部插件，不改 dsh 源码）
  packages/ssh-runtime/       连接、认证、指纹、重连
  packages/fs-ssh/            ctx.fs → SFTP
  packages/subprocess-ssh/    ctx.subprocess → 远程进程/PTY
  packages/ssh-integration/   ssh-remote 设置卡片 + 执行门禁
  packages/ssh-bundle/        SSH-only profile 层
```

## 自行构建

需要 Linux 构建机（x86_64 也可，靠 qemu 验证 arm64）。

```bash
# 1. 组装运行时（下载 Ubuntu/Node/proot，安装 dsh 与插件）
cd dsh-android
./scripts/stage-runtime.sh

# 2. 构建 APK
export ANDROID_HOME=/path/to/android-sdk
gradle :app:assembleRelease
# 产物: app/build/outputs/apk/release/app-release.apk
```

工具链：JDK 17、Gradle 8.7、Android SDK（build-tools 34、platform 34）。

签名：默认使用 `signing/personal.keystore`（仓库不含该文件，需自备；未提供则用 debug 签名）。

## 已知限制

- 仅 arm64-v8a，仅适配自用设备（OPPO OPD2407 / Android 15 验证）
- 第三方插件与 dsh 同在手机本地 Node 进程运行，插件若自行调用 Node 本地 API 可能绕过标准 `ctx.fs`/`ctx.subprocess`（dsh 本身机制，非本壳引入）
- 不支持多服务器收藏、跳板机、Windows/macOS 服务器

## 许可

外壳与 SSH 插件：MIT。官方 dsh 版权归 DeepSeek 所有。
