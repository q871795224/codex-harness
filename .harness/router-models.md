# Router 模型选型与复测

## 当前选择

2026-11-06用户明确选择 **Chinese Decision 2B**，暂时以正确率优先，后续积累更多真实反馈再复测。该选择替代此前“第二步保持Codex、实验后等待用户选型”的阶段性安排；不再重复询问本轮后端。当前实现默认`decision2`，没有backend字段的旧设置也按此默认读取；用户显式切回`codex`后保留其选择。

模型只判断纯文字请求的主要工作区，`related=[]`。图片或可见工作区超过25个时使用原Codex判断，保留完整输入和候选；记录实际backend、model及fallbackReason。没有工作区时直接使用通用目录。Decision连接失败、响应不合法或超限时保留草稿、提示重试或手动切换，不自动发起另一轮Codex。简介生成仍用原Codex模型/强度配置，Decision不生成介绍。

设置保留三个纵向区域：Codex临时会话、Chinese Decision 2B、其他模型API。前两者可选择，未选区域字段置灰；其他API不可启用。Decision服务地址与模型只读，暂不扩展通用Provider或任意远端地址。最终Prompt页展示当前后端实际组装的请求，填入`{{用户输入}}`占位；Decision用原生state/questions/criteria，并非将整段Codex提示词塞入一个字段。

## 模型与部署清单

以下版本与测试状态核实于2026-11-06。本批权重SHA256、实际包版本、源码与服务参数见[环境快照](../docs/review/workspace-router/model-evaluation-20261106/environment.json)。

| 候选 | 权重源与revision | 本批运行方式 | 输入边界与接口 |
| --- | --- | --- | --- |
| Chinese Decision 0.8B | `quincyqiang/chinese-decision-0.8b-gguf`，`890ffc6791c383107614f21b30f41669b8adb117` | CPU、作者Q8_0 GGUF、llama-cpp-python 0.3.36、16线程 | 16384模型Token；最多26选项；localhost:16601 |
| Chinese Decision 2B（选定） | `quincyqiang/chinese-decision-2b-gguf`，`2357aa9aad05cbd87bcfc11a1b74e5705e3b5bbc` | CPU、作者Q8_0 GGUF、llama-cpp-python 0.3.36、16线程 | 16384模型Token；最多26选项；localhost:16602 |
| Prism-Qwen3.5-Reranker-0.8B | `infgrad/Prism-Qwen3.5-Reranker-0.8B`，`c60729783cb2f0662c0b054a02964402a211e3f4` | CPU FP32、Transformers 5.17.0、Torch 2.14.0+cpu、16线程、batch4 | 本适配器单对10000 Token，超限拒绝；localhost:16603/rerank；23对评分取最高项 |
| 既有Laya multilingual | 部署模型revision `1c5edc17a7acd8701df6fc341c0d179f1c62c982`；SDK与配置哈希见[旧环境记录](../docs/review/workspace-router/evaluation-20261106/environment.json) | 既有CPU FP32 eager服务，version 0.2.0 | max_len=1024、head_max_len=256，SDK存在截断；端点`http://10.251.137.89:5050/laya` |
| 既有Laya typed-decisions | 与上行同批部署revision，独立模型配置/分词器哈希见旧环境记录 | 同上 | 同上；英文Laya虽已加载，本批未评价 |

Chinese Decision服务源码`yanqiangmiffy/chinese-decision`固定实测提交`25923d266c4d69629560193b119966d41ebbba62`，前向分类而非生成一段回复。26项包括通用候选，因此Harness最多传25工作区；作者训练主要覆盖2–16项，本批实际测试23项。Prism使用权重自带query/document模板，只读yes/no logits，不生成证据；CPU卷积与Gated Delta走参考实现，本次耗时不能直接代表GPU部署性能。

主机`10.251.137.89`，48逻辑核Xeon Silver4116、约250GiB内存、无GPU。独立目录`/home/toc/SSE/harness-router-eval-20261106`，三个模型均只监听127.0.0.1；venv只读复用原Laya包目录，不升级原环境。依赖复用不是完全隔离，未来原环境变更后应重新核对包版本。

接入地址为`http://10.251.137.89:5050/harness-router/decision2`，提供`/health`、`/v1/compile`、`/v1/systemone`。该内网HTTP入口依赖公司网络。16602直连已实测超时，因此在`/etc/nginx/conf.d/dns-console.conf`新增独立location代理至127.0.0.1:16602，通过nginx -t后reload；原Laya location保持原样并复查readyz。原配置备份在部署目录`nginx-before-router-integration.conf`。实验报告中的“未改nginx”是选型之前的历史状态，接入后的状态见[接入核实记录](../docs/review/workspace-router/model-evaluation-20261106/router-integration.json)。

日常在部署目录运行`venv/bin/python manage_services.py status|start|stop [decision2]`；start后再查health确认加载完成。不重跑deploy.py，不自动清理未选模型。进程未配置开机自启，重启后需手动start；停止Decision不会自动切换客户端后端。

## 当前证据与输入边界

[112次完整实测](../docs/review/workspace-router/model-evaluation-20261106/report.md)固定完整22工作区中文人工短介绍+通用选项，16条需求×7条件。5条历史人工确认中4条属于Harness、1条DNS API，另11条合成；数据偏向已知项目。0.8B/2B不加示例均13/16；加入两条演示后15/16、16/16，平均2.85/5.67秒、p95 3.58/6.72秒。Prism 13/16、20.16秒；Laya两个原生名称输入基线10/16、8/16。每格16次的nearest-rank p95就是最大值，不能外推生产准确率。Laya与新模型信息量不同，不能只归因于模型。

演示指向Harness/DNS API，都是实验准备的例子，**不作为真实人工纠错注入生产**。实际路由只引用已有明确人工纠错，并受条数、选取规则与预算约束。自动介绍也来自真实缓存，和实验人工短介绍不同；本次16/16是冻结实验条件的成绩。

应用文字预算以o200k计数：Decision对完整原生JSON正文加64余量计数；Codex计指令、schema、上下文和原始文字。先减少案例、再缩短介绍，原始用户文字不静默截断。调用前另经模型自身`/v1/compile`核对候选数及≤16384 Token，执行usage必须与编译数一致。模型/选项不匹配、重定向、超限或不合法响应均拒绝，错误消息不包含上游正文。请求和回包各限1MiB，连接超时5秒、每次HTTP总超时30秒，不自动重试。

本批Decision加示例687–839模型Token，无截断；7880 Token只做编译容量验证，24680 Token明确拒绝。Prism 23对总Token与单对窗口分开报告。初次Prism手拼模板多换行的5条结果已排除，native-v2全部重测；以后直接使用模型自带模板，不能凭阅读复刻。

## 积累数据后的复测方法

1. 从反馈页收集明确“准/不准”和人工指定的正确工作区。继续聊天产生的implicit-accurate不能当人工真值；图片、主要/关联工作区分别标记，歧义样本单列。原文继续通过Provider引用读取，不复制进SQLite或诊断日志。
2. 保留本批16条作为回归集，另准备覆盖22工作区、通用需求、相邻仓库和跨工作区的新样本；后加入的真实反馈按时间切分为案例池与未见评测集。不能把待测样本自己的纠正放进其Prompt。分别报告真实/合成、是否引用案例、实际缓存介绍版本和候选规模。
3. 固定模型revision、量化、源码/包版本、硬件、线程、候选顺序、中文介绍、预算与纠错规则。各候选用其原生接口，保留候选顺序；Decision的字母标签按criteria插入顺序分配，不能将JSON对象排序后再发送（含state与案例字段顺序），原生适配器使用有序序列化；对照案例有无、主工作区与拒选，完整保留模板哈希、模型自身Token与截断标记。新结果使用独立目录，不向旧results.jsonl混写。
4. 沿用单调用方随机穿插作为可比基线，再单独测并发。分别统计错误率、超限/失败率、均值/p50/p95，以及Mac到服务和Harness首条完整路由耗时；不要把服务器本机HTTP时间当首字延迟。复测原生适配器与实际Harness动态案例/缓存输入，两者结果分开。
5. 汇总各模型的配对改善/退化案例，特别检查DNS Agent/API边界、通用问题误选和跨项目需求。保留未选模型与本批脚本；更新本文件选型记录后再决定是否换后端，不因少量满分自动替换。

实现入口：[原生适配器](../src-tauri/src/workspace_router_decision.rs)、[路由与后端选择](../src/core/workspace-router/service.ts)、[设置](../src/core/workspace-router/settings.ts)。真实服务冒烟显式运行`cargo test live_decision_2b_smoke --lib -- --ignored --nocapture`；常规测试只使用本地假HTTP服务，不依赖89或真实用户配置。
