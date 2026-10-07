# 千川商品投放工作台

当前生产源码的脱敏开发基线，更新日期：2026-10-07（北京时间）。应用声明版本2.3.0，Chrome扩展1.3.1；请以Git提交编号区分实际修订。

先读[交接说明](交接说明.md)。`main`对齐运行版本；`development/roi-comparison`另含未上线的ROI调整前后对比。仓库不附生产数据、登录状态或凭据。

```powershell
git clone https://github.com/zeyuan2/qianchuan-replica.git
cd qianchuan-replica
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build:lan
node --test --test-concurrency=2 tests/*.test.mjs
```

无第三方npm依赖。`dist/`包含原生前端源码，不能当作普通构建缓存删除。`scripts/build-lan.mjs`生成共享前端；不要直接修改生成的`dist/lan-main.mjs`。

核心功能：完整分页采集、每5分钟更新、新计划识别、指标配置、日期查询、详情、经确认的计划操作、批量起量及异常核实、预算提醒、故障记录、Windows登录自启动和守护。账户操作仍要求逐次确认，写入结果不明时不自动重试。

- [运行优先保障](运行优先保障说明.md)
- [故障记录](故障记录使用说明.md)
- [登录自启动](登录自启动说明.md)
- [批量起量](批量起量升级说明.md)
- [配置示例](config-examples/README.md)

开发电脑默认使用人工fixtures；先完成账户占位配置，再决定是否接入真实浏览器。不要复制生产`.runtime`或同时启用同一生产账户的重复通知/操作。

计划表新增“创建时间”固定信息列（北京时间），与ROI、消耗并列；点击列头切换全量匹配结果升降序，默认最新在前，缺失值最后。不增加源站采集请求。
