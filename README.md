# 千川商品投放工作台

当前生产源码的脱敏开发基线，更新日期：2026-10-12（北京时间）。应用声明版本2.3.0，Chrome扩展1.3.1；请以Git提交编号区分实际修订。

先读[交接说明](交接说明.md)。`main`对齐运行版本；`development/roi-comparison`另含未上线的ROI调整前后对比。仓库不附生产数据、登录状态或凭据。

```powershell
git clone https://github.com/zeyuan2/qianchuan-replica.git
cd qianchuan-replica
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build:lan
node --test --test-concurrency=2 tests/*.test.mjs
```

无第三方npm依赖。`dist/`包含原生前端源码，不能当作普通构建缓存删除。`scripts/build-lan.mjs`生成共享前端；不要直接修改生成的`dist/lan-main.mjs`。构建会逐一校验替换目标，目标失配时报错中止（`--out=<目录>` 可输出到其他目录做对照），测试会核对构建产物与已提交文件一致，以及内网页面资源清单与模块导入闭包的一致性。

核心功能：完整分页采集、每5分钟更新、新计划识别、指标配置、日期查询、详情、经确认的计划操作、批量起量及异常核实、预算提醒、故障记录、Windows计划任务托管、隧道连接健康检查与自动重连。人工账户操作要求逐次确认，写入结果不明时不自动重试。计划自动化代码已接入，规则见 `AUTOMATION-HANDOFF.md`；生产自动化已按用户要求停止，新机配置示例默认关闭。公共网关的已确认操作（含自动化恢复提交）写入本机 `.runtime/public-operations.jsonl` 审计记录；`latest.json` 中的新增发现事件保留最近7天。

- [自动化规则与接入](AUTOMATION-HANDOFF.md)
- [主机执行器](deployment/HOST-RUNTIME.md)
- [Windows计划任务托管](deployment/WINDOWS-SUPERVISION.md)
- [运行优先保障](运行优先保障说明.md)
- [故障记录](故障记录使用说明.md)
- [登录自启动](登录自启动说明.md)
- [批量起量](批量起量升级说明.md)
- [配置示例](config-examples/README.md)

开发电脑默认使用人工fixtures；先完成账户占位配置，再决定是否接入真实浏览器。不要复制生产`.runtime`或同时启用同一生产账户的重复通知/操作。

计划表新增“创建时间”固定信息列（北京时间），与ROI、消耗并列；点击列头切换全量匹配结果升降序，默认最新在前，缺失值最后。不增加源站采集请求。
