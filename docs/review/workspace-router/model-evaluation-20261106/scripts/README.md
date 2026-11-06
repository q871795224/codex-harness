# 本批部署与实测脚本

本目录保存2026-11-06本批使用的Python脚本；不是Harness运行时代码，也不会随应用启动。除`audit_results.py`是收集结果后的本地审计工具，其余文件与89部署目录中的同名文件逐字节一致，哈希见上级`environment.json`的`scripts_sha256`。

| 文件 | 用途 |
| --- | --- |
| deploy.py | 首次创建隔离venv、安装依赖、启动服务；不要用于日常重启 |
| download_models.py | 从三个固定Hugging Face revision下载模型和分词器 |
| prism_server.py | 使用模型自带query/document模板、FP32 CPU对23个候选打分 |
| manage_services.py | 查看、启动、停止本目录登记的进程；拒绝接管已有端口 |
| benchmark.py | 从私有dataset.json构造7组条件，按固定计划调用；已有结果按案例/模型/条件跳过 |
| status_report.py | 从results.jsonl计算分组命中、错误及耗时 |
| metadata.py | 采集依赖版本、权重/脚本哈希及当前服务健康 |
| audit_results.py | 核对112条计划、标签、请求哈希、截断、Prism模板及试跑排除 |

现有部署位于`10.251.137.89:/home/toc/SSE/harness-router-eval-20261106`，日常操作在该目录执行：

```sh
venv/bin/python manage_services.py status
venv/bin/python manage_services.py stop prism08
venv/bin/python manage_services.py start prism08
```

以上是可用命令说明，本次结果收集只执行了status，没有停止或重启健康服务。start发起后需再次status检查模型加载情况；没有配置开机自启。

部署时实际Chinese Decision源码为`https://github.com/yanqiangmiffy/chinese-decision`的`25923d266c4d69629560193b119966d41ebbba62`。首次安装脚本clone当时HEAD，不保证将来运行会取到同一提交；另建实验时需显式固定该revision并按environment.json固定依赖版本。三个权重revision已在download_models.py固定。依赖只读复用原Laya的venv包目录，原目录变动可能影响新服务；本轮实际版本见environment.json。

环境记录中`deployment`是初次就绪快照；`services_current`及其health才是18:24:55的复查状态，包含修正后的Prism native-v2。JSON中的PID只代表本次观察，不用于识别未来运行状态。

原始数据留在服务器及本机临时实验目录，仓库不包含用户历史正文和完整API回包。复查本次数据时，将本目录脚本与私有dataset.json放在BUNDLE目录，将results.jsonl、plan.json、capacity.json、environment.json及results-before-prism-template-fix.jsonl放在RAW目录，再执行：

```sh
python3 audit_results.py BUNDLE RAW audit.json
```

审计脚本不调用模型。benchmark.py会实际调用模型；不要在本批归档目录直接重跑。新一轮应使用独立输出目录并保存新计划，避免把旧结果和新服务条件混合。plan.json的frozen_at是恢复运行时写出时间，案例、候选、示例及顺序与首跑一致；dataset哈希、重建请求哈希及每条index已核对。
