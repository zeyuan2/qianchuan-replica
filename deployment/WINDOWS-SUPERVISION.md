# Windows计划任务托管

在已配置的生产目录运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-watchdog-task.ps1`。安装脚本使用当前用户的 Interactive / Limited 身份，不保存密码、不申请SYSTEM权限；`-WhatIf`只展示计划。若系统拒绝创建任务，需要由主机管理员执行安装。

任务名 `Qianchuan-Workbench-Watchdog`：Windows登录时触发，另每分钟触发；已有任务运行时忽略重复实例。运行中的任务没有默认执行时长上限，异常退出每分钟重试，已有守护循环继续每20秒检查工作台、网关、隧道及健康记录器。计划任务直接运行守护脚本，独立于Codex及终端进程。

安装成功后将绑定写入本机 `.runtime/watchdog-task.json`，现有启动脚本发现绑定便通过任务计划程序启动守护。安装器不会自行结束任何进程。交接时核对 `.runtime/watchdog.pid` 与实际 `watch-services.ps1` 命令行，只停止旧守护，再调用 `Start-ScheduledTask -TaskName Qianchuan-Workbench-Watchdog`；网站、采集、数据、自动化账本保持运行。

配置 `.runtime/watchdog.stop` 表示主动关闭守护；存在时周期触发直接退出，不重新拉起业务服务。`.runtime/watchdog.pause` 仍用于临时维护。不要仅结束守护进程作为永久关闭方式，Windows任务会再次启动它。

验证需要同时检查任务状态Running、任务动作中的脚本路径、守护PID存活与 `.runtime/watchdog-status.json` 心跳。可以只终止已核实的守护PID，观察下一次任务触发是否重新创建守护；不要通过结束网站或发起广告操作来测试。

此模式依赖Windows用户会话：锁屏后进程可以继续；注销、关机或睡眠期间不能保证采集。登录后自动恢复服务，但Chrome中目标千川页面及扩展仍需保持登录和连接。当前托管检查进程退出，不宣称能检测所有逻辑卡死。

回退：先创建watchdog.stop并暂停计划任务，保留任务导出的备份；核对任务动作属于当前生产目录后才卸载该任务。移除本机watchdog-task.json绑定后，可恢复旧启动脚本模式。回退不删除数据或自动化账本，也不会撤销平台上的已确认操作。


## 隧道进程存活但断线的恢复

守护每轮同时查询本机cloudflared `/ready`，仅HTTP/JSON状态200且连接数大于0才视为健康。新进程有90秒连接宽限；连续至少3次失败、持续至少40秒后，只重启已再次核实归属的cloudflared进程。重启间隔至少5分钟，状态保存在 `.runtime/tunnel-health-state.json`，守护重启不清空冷却时间。现有维护和主动停止标志继续优先。

健康状态显示`disconnected`与连接数，恢复事件记录为`tunnel_health_restart`；旧隧道日志按原有恢复流程留存。此机制不修改代理路由、登录验证、广告自动化开关或计划设置。外网登录页302只表示Access入口可访问，不能代替隧道健康检查。
