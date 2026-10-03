# 脱敏配置示例

这些文件不是可直接上线的凭证。不要复制原机器的 `.runtime`。

- `public-access.example.json`：自行填写 origin、team、audience、emails 后保存为 `.runtime/public-access.json`。Cloudflare 门户的 Access 策略还需同时设置相同成员。
- `budget-alerts.example.json`：结构示例。建议通过本机 `notifications.html` 新填各接收人的 Token；默认关闭，未填 Token 不发送。
- `tunnel-token.example.txt`：仅提示占位。不要把示例字符串作为 Token 保存。通过本机 `external-connect.html` 填新隧道凭证。
- 浏览器配对码由新机器首次启动自动生成，操作密码由本机 `connect.html` 新设，不提供预置密码或登录会话。
