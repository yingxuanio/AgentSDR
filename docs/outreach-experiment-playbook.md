# AgentSDR B2B 获客实验手册（战线 A × 低频护域 × 方案 A/C × 零 Unipile 多渠道）

> **核心转型**：从“每日 40 封跨 10 行业名录盲发 + 推送 13 页简介 PDF”全面升级为 **「战线 A 技术招聘替代单点突破 → 每日 <=10 封主域低频精品投放 → 零客户负担的一页核对单 & 概念预览（方案 A/C）→ LinkedIn L1 人工双打与 WhatsApp 原生工作站温热跟进」**。

---

## 一、第一阶段基线复盘（2026-11-10 至 2026-11-13）与战略转向依据

| 维度 | 实测基线数据 | 诊断结论与策略重构 |
| --- | --- | --- |
| **触达与回复** | 累计入库 `254` 家，触达 `186` 家，人工有效回复 `0`（入站为 1 自动回执 + 2 离职转介） | 商会静态名单中 95% 企业当下并无软件采购急迫性；全面切换至 **战线 A（近 90 天正招聘技术/系统岗位的实体 SME）** |
| **护域与退信** | 总退信率 **`4.84%`**（香港 `8.16%` vs 台湾 `0.00%`） | 暂不购买新副域名；严格通过 **每日仅 1 波、单日总发信 <=10 封** + **纯 DNS MX 校验** + **禁用 `@biznetvigator.com`/`@netvigator.com`** 护住 `yingxuan.io` / `linktion.cn` |
| **价值钩子** | 过去 `92%` 邮件在首封附带官网 + `.pdf` 简介双链接，平均 `431` 字 | 停用 13 页自我介绍 PDF 钩子；亦不做需客户填表贴 JD 的工具（**拒绝方案 B**）；改用 **方案 A（预先整理好的一页《一期独立验收边界与源码移交核对单》）** 与 **方案 C（周度 S 级 2–3 屏可点按 Working Preview）** |
| **通道短板** | Email `186`｜LinkedIn `0`｜WhatsApp `0`；55.4% 邮件落在 `info@`/`sales@` | 启用 **LinkedIn L1 半自动工作台（零 Unipile）** 直达创始人；**WhatsApp 原生工作站（`services/call-worker` 基于 WhatsApp Web 网页版 + 多设备扫码/配对码）** 仅用于温热回访与过前台确认，绝不冷群发 |

---

## 二、当前作战架构（四大支柱）

### 1. 主攻战线 A：港台 15–150 人非软件企业的「招聘替代 / 工作包拆分」
`run-outreach-wave.mjs` 聚焦 4 个高意向招聘分片（每次目标 `<= 8` 家新客）：
1. `hk-tech-contract-hiring`：香港近期在 JobsDB / CTgoodjobs / 官网招 **Contract / Part-time / 1–2 名全端或系统开发** 的实体贸易、物流、零售、医疗与工程商；
2. `tw-sme-system-hiring`：台湾在 104 / 1111 / Cake / Yourator / 官网招募 **全端 / 前后端 / 网站 / 系统开发** 的非软件中小企业；
3. `hk-lean-it-digital`：香港实体企业招募 **单兵 IT Officer / System Analyst / E-Commerce Specialist** 缺口；
4. `tw-export-ops-hiring`：台湾外销制造、批发与连锁品牌招募 **资讯专员 / ERP / PHP/Node/Python/C# 开发** 缺口。

> **绝对红线**：虽然从招聘信号发现企业，但严禁向 `hr@` / `jobs@` / `careers@` / `recruit@` 发信！必须通过官网抓取锁定创始人、董事长、总经理或业务负责人的商业邮箱（实名个人邮箱优先；公共职能邮箱首句加礼貌转交引导），且严禁把招聘平台域名填作 `companyDomain`。
> **搜索与抓取架构**：`prospect-tool.mjs` 采用 **Exa Search 主搜（含 `linkedin profile` 垂直索引与自动高亮摘要，Firecrawl 作备选）+ 本地 Direct HTTP 优先抓取官网（0 额度消耗，SPA/拦截页自动降级 Exa `contents` / Firecrawl）**。

### 2. 低频护域配额纪律（单日 <= 10 封）
- 每个工作日 **10:30（Asia/Shanghai）仅跑 1 波**：
  - **Priority 1｜离职转介（Warm Referral）**：优先承接同域业务继任者；
  - **Priority 2｜Touch #2 直接交付干货（<= 4 封）**：针对 3–8 天前首触未回线索，直接在正文给出 **3 条开箱即用验收标准**（不贴 13 页简介 PDF、不写“不知是否收到上封信”）；两封未回即止损，不发第 3 封；
  - **Priority 3｜战线 A Touch #1 新客开拓（`min(8, max(4, 10 - 转介 - Touch2))`）**。

### 3. 前置交付物：方案 A + 方案 C（品牌对标 `BRAND.md`）
- **方案 A（每家标配）**：运行 `wave-review-tool.mjs generate-briefs --pending` 在 `docs/briefs/` 自动为待审客户生成 1 页专属《**一期獨立驗收邊界與源碼移交核對單**》，围绕 **「Agent 幹活，英选把關」** 与 **「能上線、改得動、始終歸你」** 三个可验证承诺撰写（客户就算最后仍自己招人，也能拿去当试用期验收标准）。
- **方案 C（每周 3–5 家 S 级高潜）**：运行 `wave-review-tool.mjs s-tier-candidates --limit 5` 筛选本周最高分线索，制作 2–3 屏带其业务场景的静态概念预览（Working Preview，遵守 `PROPOSAL.md`“概念示意”边界规范），通过 `--preview-url <url>` 嵌入 Touch #2 或 LinkedIn 私信。

### 4. 零 Unipile 多渠道双打
- **LinkedIn L1 半自动工作台（先跑通转化再考虑本地浏览器 Worker）**：
  - `prospect-tool.mjs` 在抓取阶段自动采集 `personLinkedinUrls` 与 `companyLinkedinUrls`；
  - 运行 `wave-review-tool.mjs linkedin-l1 --limit 10 --write-doc` 输出 [`docs/linkedin-l1-queue.md`](file:///Users/ivan/projects/AgentSDR/docs/linkedin-l1-queue.md)（含一键直达/搜人链接、`<=150` 字零推销好友备注、1–2 行短信级私信、25 秒语音/短视频跟进脚本）；
  - 手动发送后执行 `mark-linkedin-sent <recordId> [--url <url>]` 记入实验账本防重复。
- **WhatsApp + 语音外呼原生工作站（`services/call-worker`，基于 WhatsApp Web）**：
  - 原理：在本地持久浏览器 Profile 中运行官方 **WhatsApp Web（Linked Devices 扫码 / 8 位码绑定）**，由扩展 `extensions/whatsapp-recorder` 完成消息收发与语音接打，完全不经过 Unipile；
  - **防封号铁律**：由于运行在普通 App 多设备网页端（非 Meta 付费模板 API），**禁止向陌生人批量冷发 WhatsApp**；仅用于 **转介、热线索或先经电话与前台确认过称呼与意向** 后的轻量预览发送与沟通。

---

## 三、常用运行与复盘命令速查

```bash
# 执行器：官方 Cursor Agent CLI（`agent`），不再使用 AGY；禁止把 Agent 包装成名为 agy 的假程序。
# 必填 Secrets：AGENTSDR_URL / AGENTSDR_API_KEY / CURSOR_API_KEY / EXA_API_KEY|FIRECRAWL_API_KEY /
#   AGENTSDR_OWN_MAILBOXES / AGENTSDR_FROM_EMAIL_ZH|EN
# 权限：仅 .cursor/cli.json allowlist（Shell(node) 跑 prospect-tool）；禁止 --force/--yolo/--dangerously-skip-permissions
# 安装 Agent CLI：curl https://cursor.com/install -fsS | bash
# 默认 delivery=draft_only；熔断锁下不要 send-paced。

# 1. 前置复盘 + 更新账本
node scripts/wave-review-tool.mjs retrospective --days 14 --sync-mailboxes --write-ledger

# 2. 为 3–8 天到期高潜线索准备 Touch #2（直接交付 3 条核对要点；可选挂 S 级概念预览 URL）
node scripts/wave-review-tool.mjs prepare-followups --limit 4 --min-days 3 --max-days 8 [--preview-url https://...]

# 3. 战线 A 招聘信号新客开拓（draft_only，单日容量截断）
# --model 默认仍是历史字符串 gemini-3.8-flash-medium；若 Cursor 不支持，由 Ivan 指定兼容 model id（勿擅自换付费模型）
node scripts/run-outreach-wave.mjs --target 6 --concurrency 4 --model gemini-3.8-flash-medium --delivery draft_only --experiment-arm auto

# 4. 生成方案 A 一页核对单 + 筛选本周 S 级 Working Preview 候选 + 刷新 LinkedIn L1 工作台
node scripts/wave-review-tool.mjs generate-briefs --pending
node scripts/wave-review-tool.mjs s-tier-candidates --limit 5
node scripts/wave-review-tool.mjs linkedin-l1 --limit 10 --write-doc

# 5. 逐封审核 + 节流发送 + LinkedIn L1 回写台账（仅 Ivan 批准且熔断解除后）
node scripts/wave-review-tool.mjs list-pending
node scripts/wave-review-tool.mjs send-paced --pace-ms 8000 --experiment-arm <arm> --write-ledger --report <wave-report.json> <draftId1> ...
node scripts/wave-review-tool.mjs mark-linkedin-sent <recordId> [--url <linkedinUrl>]
```
