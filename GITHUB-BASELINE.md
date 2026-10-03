# GitHub 开发基线

目标仓库：`https://github.com/zeyuan2/qianchuan-replica`，分支：`main`。

本次只上传当前运行项目的脱敏副本；源目录的 84 个程序/文档文件与交接快照逐一核对一致。没有直接在生产目录提交或配置 Git remote。

应用版本 2.3.0，Chrome 扩展 1.3.0。生产配置、采集数据、日志、登录会话及密钥均未迁入；测试响应均为人工生成。开发电脑先阅读《交接说明.md》。Git commit SHA 是本基线的唯一编号，版本号本身不能标识全部内容。

```powershell
git clone --branch main https://github.com/zeyuan2/qianchuan-replica.git
cd qianchuan-replica
git rev-parse HEAD
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build:lan
npm.cmd test
```

核对 `git rev-parse HEAD` 与交付的提交编号。以后 main 有新提交时，用该编号检出固定基线，再从新分支开发。仓库访问需自己的获授权 GitHub 登录，项目生产密钥不属于仓库登录凭证。

验证：离线依赖安装、前端构建、46/46 自动测试、随机回环端口的隔离启动通过；未进行真实账户操作或发送通知。`.runtime` 和所有 `data/` 被忽略。`.gitattributes` 保持审计过的字节和 PowerShell BOM，跨电脑拉取不自动改换行。
