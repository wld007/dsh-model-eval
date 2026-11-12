# dsh-model-eval

DeepSeek Harness 医疗模型评测插件：在 jsonl / json / csv 数据集上评测一个或多个 OpenAI 兼容模型（DeepSeek、OpenAI、vLLM、Ollama、LM Studio、SGLang 等），自动打分，生成排行榜、分类准确率、两两对比和答错样本报告。

当前为 **0.2（核心闭环 + 基础界面）**：侧栏「医疗模型评测」页面可以查看模型、检测连通、发起评测、实时看进度、排行榜和报告。后续：LLM 裁判 / Excel 导出、内置基准 MMLU / C-Eval / GSM8K、人工复核、Agent / 工作流评测。

## 安装

1. DSH 侧栏 →「插件」→「添加插件」，填入 npm 包名 `dsh-model-eval`（或本仓库的本地路径），然后启用。
   命令行等价：`dsh plugin add dsh-model-eval`
2. 在 profile 的 `cordis.patch.yml` 中编辑 `model-eval` 的 `config.models`，配置待评测模型（见下）。
3. 修改配置或代码后，在插件页停用再启用（Host 代码变更需重启 DSH）。

## 配置模型

```yaml
- id: model-eval
  name: 'dsh-model-eval'
  config:
    models:
      - id: local-qwen
        baseURL: 'http://127.0.0.1:11434/v1'
        model: 'qwen2.5:7b'
      - id: deepseek-chat
        baseURL: 'https://api.deepseek.com/v1'
        model: 'deepseek-chat'
        apiKeyEnv: 'DEEPSEEK_API_KEY'   # 推荐用环境变量，避免把密钥写进文件
    defaultModels: []      # 不指定模型时使用；空 = 全部
    concurrency: 4
    maxTokens: 1024
    localOnly: false       # true = 所有评测都按敏感数据处理
    trustedHosts: []       # 视为内网的域名，如 '*.hospital.lan'
```

Agent 只能按 id 选择这里配置的模型，不能新增端点，评测数据只会发往你配置过的地方。

## 使用

**界面**：点左侧栏的「医疗模型评测」图标，填数据集路径（可点「使用示例数据集」）、勾选模型和评分器，点「开始评测」；进度、排行榜（平均分条形图、准确率、延迟、Token）和完整报告都在批次详情页里，运行中可取消，取消/失败的批次可续跑。

**对话**：对 Agent 说：「用 local-qwen 和 deepseek-chat 评测 examples/demo.jsonl」，或用命令：

```
/eval /path/to/data.jsonl --models local-qwen,deepseek-chat --limit 50
/eval /path/to/records.jsonl --sensitive          # 病历等敏感数据
/eval --resume eval-20261031-130021-90e3          # 断点续跑
```

| 工具 | 作用 |
| --- | --- |
| `eval_models` | 列出已配置模型，可检测连通性 |
| `eval_start` | 启动评测（或 `resumeRunId` 续跑），立即返回批次 id |
| `eval_status` | 进度、排行榜、各模型指标 |
| `eval_report` | Markdown 报告 |
| `eval_runs` | 最近批次 |
| `eval_cancel` | 取消；已完成结果保留，可续跑 |

## 数据集格式

每条样本字段自动识别：

| 含义 | 字段 |
| --- | --- |
| 输入 | `question` / `input` / `prompt` / `query` / `problem` / `text`；Alpaca 的 `instruction`+`input`；或 `messages`（最后一条 assistant 作为参考答案） |
| 参考答案 | `answer` / `reference` / `target` / `expected` / `label` / `solution` / `output` / `gold`；可为数组（多个参考，取最优） |
| 选项 | `choices` / `options`（数组或 `{A:…,B:…}`），或 `A`、`B`、`C`、`D` 列 |
| 分类 | `category` / `subject` / `type` / `task` / `domain` |
| 其他 | `id`、`system`、`scorer`（单条覆盖评分器） |

## 评分器

| 名称 | 规则 |
| --- | --- |
| `auto` | 有选项→`choice`；参考答案是纯数字→`number`；否则 `exact` |
| `exact` | 归一化后完全相等（全半角、大小写、首尾标点） |
| `includes` | 输出包含参考答案 |
| `regex` | 参考答案为正则（`/pat/flags` 或默认忽略大小写） |
| `choice` | 从输出中提取选项字母（“答案是 B”“(C)”“B. …”、选项原文等） |
| `number` | 提取数值比较（支持 `####`、`\boxed{}`、千分位、分数、百分数） |
| `f1` / `rouge_l` / `bleu` | 连续分；中文按字、英文按词；≥ `threshold`（默认 0.5）记为通过 |

`<think>…</think>` 推理内容不参与评分。

## 敏感数据

`sensitive: true`（或设置 `localOnly: true`）时：

- 只允许本地/内网端点（127.x、10.x、172.16–31.x、192.168.x、localhost、`.local`、IPv6 ULA，以及 `trustedHosts`），否则拒绝启动；
- 报告、`report.json` 和工具返回中不含输入、参考答案、模型输出与端点错误详情，只列样本 id。DSH 的 Agent 本身可能是云端模型，这能保证原文不经工具结果离开本机；
- 完整逐条结果只保存在本机 `results/*.jsonl`（文件权限 0600）。

## 输出

默认在工作区的 `.model-eval/`：

```
index.json
runs/<批次id>/run.json
runs/<批次id>/results/<模型>.jsonl   每条样本一行：输出、提取值、得分、延迟、token
runs/<批次id>/report.json
runs/<批次id>/report.md
```

## 测试

```bash
npm test   # 内置 mock 模型，无需联网
```
