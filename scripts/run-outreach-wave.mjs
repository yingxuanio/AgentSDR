#!/usr/bin/env node
/**
 * Outreach Wave Orchestrator (Cursor Agent executor)
 *
 * Spawns official Cursor Agent CLI (`agent`) workers to discover, verify, import,
 * and draft personalized outreach via AgentSDR. AGY is retired — do not wrap
 * Cursor Agent as a binary named `agy`.
 *
 * Usage:
 *   node scripts/run-outreach-wave.mjs --help
 *   node scripts/run-outreach-wave.mjs --target 8 --concurrency 4 --delivery draft_only --experiment-arm auto
 *
 * Required env: AGENTSDR_URL, AGENTSDR_API_KEY, CURSOR_API_KEY,
 *   and EXA_API_KEY and/or FIRECRAWL_API_KEY.
 * Never reads .env files. Permission bypass flags (--force/--yolo/
 * --dangerously-skip-permissions) are refused; use .cursor/cli.json allowlist.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  REPO_ROOT,
  allowDangerouslySkipPermissions,
  assertFileExists,
  envTrim,
  requireAgentsdrApiKey,
  requireAgentsdrUrl,
  resolveDeliveryMode,
  resolvePath,
  resolveProspectTool,
  resolveWorkdir,
} from "./outreach-cli/env.mjs";
import {
  LEGACY_AGY_MODEL,
  assertCursorAgentAvailable,
  assertNoPermissionBypass,
  buildCursorAgentArgs,
  detectUnsupportedModelMessage,
  requireCursorApiKey,
  resolveCursorAgentBin,
} from "./outreach-cli/cursorAgent.mjs";

const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
function hasFlag(flag) {
  return args.includes(flag);
}

function printHelp() {
  console.log(`Usage: node scripts/run-outreach-wave.mjs [options]

Options:
  --help                 Show help (no network)
  --target <n>           Discovery quota (default 8)
  --concurrency <n>      Parallel Cursor Agent workers (default 4)
  --model <id>           Cursor Agent --model id (default legacy string ${LEGACY_AGY_MODEL}; may need Ivan remap)
  --delivery <mode>      draft_only (default) | queue_working_hours | send_now | send_paced
  --pace-ms <ms>         Pace for send_paced
  --worker-timeout <s>   Per-worker wall-clock timeout (default 900)
  --experiment-arm <id>  Experiment arm or auto
  --prospect-tool <path> Override prospect-tool.mjs

Required env: AGENTSDR_URL, AGENTSDR_API_KEY, CURSOR_API_KEY, EXA_API_KEY and/or FIRECRAWL_API_KEY
Optional: CURSOR_AGENT_BIN, OUTREACH_WORKDIR, PROSPECT_TOOL
Permissions: .cursor/cli.json allowlist only — --force/--yolo/--dangerously-skip-permissions refused`);
}

if (hasFlag("--help") || hasFlag("-h")) {
  printHelp();
  process.exit(0);
}

const TARGET_COUNT = Number(getArg("--target", "8"));
const CONCURRENCY = Number(getArg("--concurrency", "4"));
const MODEL = getArg("--model", LEGACY_AGY_MODEL);
let DELIVERY_MODE;
try {
  DELIVERY_MODE = resolveDeliveryMode(getArg("--delivery", "draft_only"));
  // Refuse any permission-bypass flags early (throws).
  allowDangerouslySkipPermissions(args);
  assertNoPermissionBypass(args);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const PACE_MS = Number(getArg("--pace-ms", "8000"));
const WORKER_TIMEOUT_SEC = Number(getArg("--worker-timeout", "900"));
const EXPERIMENT_ARM_ARG = getArg("--experiment-arm", "auto");

let AGENTSDR_URL;
let AGENTSDR_API_KEY;
let AGENT_BIN;
try {
  AGENTSDR_URL = requireAgentsdrUrl();
  AGENTSDR_API_KEY = requireAgentsdrApiKey();
  requireCursorApiKey();
  AGENT_BIN = assertCursorAgentAvailable(resolveCursorAgentBin());
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const PROSPECT_TOOL = resolveProspectTool(getArg("--prospect-tool", null));
const WORKDIR_ROOT = resolveWorkdir();
const WAVE_CURSOR_FILE = path.join(WORKDIR_ROOT, "wave-cursor.json");
const LEDGER_PATH = resolvePath("OUTREACH_LEDGER_PATH", "docs/outreach-experiment-ledger.json");

const EXA_API_KEY = envTrim("EXA_API_KEY");
const FIRECRAWL_API_KEY = envTrim("FIRECRAWL_API_KEY");

if (!EXA_API_KEY && !FIRECRAWL_API_KEY) {
  console.error("Missing EXA_API_KEY or FIRECRAWL_API_KEY");
  process.exit(1);
}
try {
  assertFileExists(PROSPECT_TOOL, "prospect-tool");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (DELIVERY_MODE === "send_now" || DELIVERY_MODE === "send_paced") {
  console.warn(`[safety] delivery=${DELIVERY_MODE} will send mail — requires an approved batch.`);
}
if (MODEL === LEGACY_AGY_MODEL) {
  console.warn(
    `[compat] --model default is legacy AGY string "${LEGACY_AGY_MODEL}". If Cursor Agent rejects it, ask Ivan for a supported Cursor model id (do not auto-pick).`,
  );
}

const SHARDS = [
  {
    id: "hk-tech-contract-hiring",
    regionLabel: "香港",
    vertical: "戦線 A · 香港 15–150 人非軟件實體企業：近期正在招聘 Contract / Part-time / 1–2 名 Full-Stack、Web、ERP、E-commerce 或自動化開發人員之貿易、物流、零售、醫療及工程服務商",
    queryPool: [
      `site:hk.jobsdb.com ("Full Stack" OR "Web Developer" OR "System Developer") ("Contract" OR "Part-time") "Hong Kong"`,
      `site:ctgoodjobs.hk ("Programmer" OR "System Analyst" OR "Web Developer" OR "E-Commerce") "Limited" -"IT Consultancy" -"Software House"`,
      `("Full Stack Developer" OR "Web Developer" OR "ERP") "Careers" "Hong Kong" ("Limited" OR "Ltd") "@" -cyberport -hkstp -"software development"`,
      `("程式員" OR "系統開發" OR "網站開發") ("招聘" OR "誠聘" OR "Careers") "有限公司" "香港" ("聯絡" OR "電話" OR "電郵")`,
      `site:linkedin.com/jobs ("Web Developer" OR "Application Developer" OR "System Developer") "Hong Kong" ("Limited" OR "Trading" OR "Logistics")`,
      `("Contract" OR "Part-time") ("Developer" OR "Programmer" OR "系統") "Hong Kong" ("Director" OR "Founder" OR "Manager") "@"`,
    ],
  },
  {
    id: "tw-sme-system-hiring",
    regionLabel: "台湾",
    vertical: "戰線 A · 台灣 15–150 人非軟體中小企業：近期在 104 / 1111 / Cake / Yourator / 官網人才招募頁面徵求 1–2 名全端、前後端、網站程式設計師、系統開發、ERP 串接或電商工程師之實體品牌、製造批發與服務業",
    queryPool: [
      `site:104.com.tw ("系統工程師" OR "全端工程師" OR "網站程式設計師") ("股份有限公司" OR "有限公司") -"資訊服務業" -"軟體開發"`,
      `site:1111.com.tw ("系統開發" OR "ERP工程師" OR "電商網站" OR "全端") "股份有限公司" -"軟體公司"`,
      `site:cake.me ("全端工程師" OR "後端工程師" OR "系統工程師") ("傳產" OR "製造" OR "品牌" OR "電商" OR "貿易") "台灣"`,
      `("誠徵" OR "人才招募") ("全端工程師" OR "系統工程師" OR "網站工程師" OR "程式設計師") "股份有限公司" site:.com.tw`,
      `("約聘" OR "專案" OR "兼職") ("網站開發" OR "系統開發" OR "自動化工程師" OR "ERP") "股份有限公司" site:.tw`,
      `("人才招募" OR "職缺") ("PHP工程師" OR "前端工程師" OR "資料庫管理" OR "資訊工程師") ("食品" OR "醫療" OR "五金" OR "物流") site:.com.tw`,
    ],
  },
  {
    id: "hk-lean-it-digital",
    regionLabel: "香港",
    vertical: "戰線 A · 香港中小型實業／專業商貿機構：正在招聘單兵 IT Officer、System Analyst、E-Commerce Technical Specialist 或 CRM/Workflow 專員（存在「難招單兵技術＋需推進內部業務系統」痛點）",
    queryPool: [
      `site:hk.jobsdb.com ("IT Officer" OR "System Analyst" OR "E-commerce Technical") ("Manufacturing" OR "Trading" OR "Wholesale" OR "Clinic" OR "Logistics") "Hong Kong"`,
      `site:moovup.com ("IT" OR "程式員" OR "網頁設計" OR "系統") "香港" "有限公司"`,
      `("IT Officer" OR "Digital Transformation" OR "ERP") ("Join Us" OR "Careers") "Hong Kong" ("Limited" OR "Ltd") site:.com.hk`,
      `("數碼轉型" OR "系統優化" OR "網店系統") ("招聘" OR "誠聘") "香港" "有限公司" ("董事" OR "總經理" OR "經理")`,
      `site:linkedin.com/jobs ("IT Specialist" OR "Business Systems" OR "ERP") "Hong Kong" ("Retail" OR "Manufacturing" OR "Healthcare" OR "Shipping")`,
      `("E-commerce" OR "ERP" OR "CRM") ("Developer" OR "Specialist") "Hong Kong" ("Director" OR "Managing Director") "@" site:.hk`,
    ],
  },
  {
    id: "tw-export-ops-hiring",
    regionLabel: "台湾",
    vertical: "戰線 A · 台灣外銷製造／連鎖品牌／批發貿易：正在招募 1 名資訊專員、PHP/Node/Python/C# 工程師或數位營運開發，以推動官網型錄改版、海外詢價、經銷商後台或內部報表自動化",
    queryPool: [
      `("資訊專員" OR "資訊人員" OR "系統維護工程師") ("股份有限公司") ("外銷" OR "製造" OR "工廠" OR "批發") site:.com.tw`,
      `site:yourator.co ("Full-Stack" OR "Backend" OR "前端" OR "系統工程師") ("品牌" OR "電商" OR "貿易" OR "零售")`,
      `("Node.js" OR "Python" OR "PHP" OR "C#") ("誠徵" OR "徵才" OR "招募") ("股份有限公司") ("桃園" OR "台中" OR "台南" OR "彰化") site:.com.tw`,
      `("ERP" OR "CRM" OR "客製化系統" OR "數據報表") ("工程師" OR "開發人員") "徵才" ("食品" OR "醫材" OR "貿易" OR "工程") site:.com.tw`,
      `site:104.com.tw ("資訊專員" OR "MES" OR "ERP") ("機械" OR "精密" OR "生技" OR "批發") "股份有限公司"`,
      `("數位轉型" OR "系統整合" OR "電子商務") ("誠徵" OR "招募" OR "職缺") "股份有限公司" site:.com.tw`,
    ],
  },
];

function loadAndAdvanceWaveEpoch(shardAdvanceCount) {
  let state = { waveEpoch: 0, shardOffset: 0 };
  try {
    if (fs.existsSync(WAVE_CURSOR_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(WAVE_CURSOR_FILE, "utf8"));
      if (Number.isInteger(parsed?.waveEpoch)) state.waveEpoch = parsed.waveEpoch;
      if (Number.isInteger(parsed?.shardOffset)) state.shardOffset = parsed.shardOffset;
    }
  } catch {
    // ignore corrupt cursor
  }
  const current = { ...state };
  try {
    fs.mkdirSync(path.dirname(WAVE_CURSOR_FILE), { recursive: true });
    fs.writeFileSync(
      WAVE_CURSOR_FILE,
      JSON.stringify({
        waveEpoch: state.waveEpoch + 1,
        shardOffset: (state.shardOffset + shardAdvanceCount) % SHARDS.length,
        updatedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // ignore write error
  }
  return current;
}

function selectQueriesForShard(shard, waveEpoch, count = 3) {
  const pool = shard.queryPool ?? shard.searchHints ?? [];
  if (pool.length <= count) return pool;
  const start = (waveEpoch * count) % pool.length;
  const picked = [];
  for (let i = 0; i < count; i++) {
    picked.push(pool[(start + i) % pool.length]);
  }
  return picked;
}


function resolveExperimentArm(waveEpoch) {
  if (EXPERIMENT_ARM_ARG && EXPERIMENT_ARM_ARG !== "auto") return EXPERIMENT_ARM_ARG;
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
      const rec = ledger?.latestSnapshot?.recommendedNextWavePlan?.recommendedExperimentArm;
      if (rec === "A_permission_0link" || rec === "B_clean_root_url") {
        return rec;
      }
    }
  } catch {
    // ignore ledger read failure and fallback to epoch parity
  }
  return waveEpoch % 2 === 0 ? "A_permission_0link" : "B_clean_root_url";
}

function buildWorkerPrompt(shard, quota, waveWorkDir, waveEpoch, experimentArm) {
  const outJsonPath = path.join(waveWorkDir, `leads-${shard.id}.json`);
  const activeSearchHints = selectQueriesForShard(shard, waveEpoch, 3);
  const isDraftOnly = DELIVERY_MODE === "draft_only";
  const targetCounterField = isDraftOnly ? "awaitingReview" : DELIVERY_MODE === "queue_working_hours" ? "queued" : "sent";
  const targetStatusLabel = isDraftOnly ? `status: "awaiting_review"` : `status: "sent"`;
  return `你是專注「戰線 A：高意圖技術招聘替代」的 B2B 拓客執行 Agent（本波次實驗臂：${experimentArm}）。本輪你的唯一任務是為分片【${shard.id}】（方向：${shard.vertical}）尋獲、核驗並成功提交 **${quota} 家** 正在招聘 1–2 名技術/系統開發人員、卻非軟件外包本業的港台實體企業（系統會自動完成入庫與開發信草稿生成${isDraftOnly ? "，留待主控 Agent 逐一人工覆核與生成 1 頁驗收核對單後再統一發信" : "並按節流節奏發出郵件"}）。

### 一、工具與兩步工作流（信號捕獲 → 企業官網核驗 → 提交）
1. **絕對禁止觸碰系統與容器**：嚴禁讀取或修改 AgentSDR 源碼目錄、嚴禁執行任何 \`docker\` / \`psql\` / \`lsof\` / \`curl\` 命令、嚴禁使用瀏覽器或 MCP 工具！全程**只允許**調用 \`node ${PROSPECT_TOOL}\`（與寫 JSON 檔案）。
2. **兩步「信號 → 官網」精準路徑（嚴禁把招聘平台域名當公司域名！）**：
   - **Step A · 並發檢索在招信號**（已自動過濾 CRM 已有及並發分片已認領域名）：
     \`node ${PROSPECT_TOOL} search ${activeSearchHints.map((q) => `'${q}'`).join(" ")}\`
     從職缺摘要或官網徵才頁面識別近期在招 **Full-Stack / 前端 / 後端 / Web / 系統工程師 / ERP / 電商開發 / 資訊專員 / 約聘（Contract / Part-time）** 的傳統製造、外銷批發、品牌零售、物流、醫療服務企業。
   - **Step B · 抓取招募企業自家官網 + 順帶查 LinkedIn**（一次傳 4–8 個 URL；返回含 \`b2bSignals.hiringSignals\`、\`careerPages\`、\`personLinkedinUrls\`、\`companyLinkedinUrls\`）：
     \`node ${PROSPECT_TOOL} scrape "https://..." "https://..." ...\`
     *務必抓取該公司的官方網站（聯絡我們 / 關於我們 / 人才招募）確認真實業務負責人與企業郵箱！* 若抓完官網決策人姓名但缺少 \`linkedinUrl\`，可在 2-hop 預算內補查一次：
     \`node ${PROSPECT_TOOL} search 'site:linkedin.com/in "<人名>" "<公司名>"'\`
   - **Step C · 批量提交入庫並生成草稿**：
     先用 \`write_file\` 將核驗完畢的客戶陣列寫入 \`${outJsonPath}\`，然後執行：
     \`node ${PROSPECT_TOOL} submit ${outJsonPath}\`
     ⚠️ **重要**：\`submit\` 會並發生成郵件草稿，耗時約 20–50 秒；當命令轉為背景任務運行時，**嚴禁調用 \`manage_task\` 輪詢**，直接簡短回覆一句話結束當前回合，系統會在執行完畢後自動喚醒你！
3. **2-Hop 快速止損原則**：
   - 若某公司抓完招聘貼 + 官網首頁/Contact 仍無法確認 **真實業務/高管聯絡人姓名與職稱** 或 **有效商業郵箱**，立即放棄換下一家！為穩妥達成 **${quota} 家** \`${targetStatusLabel}\`，一次準備 **${quota + 1} 家** 候選提交；若遇門禁攔截再補齊差額直至 \`${targetCounterField} >= ${quota}\`。

### 二、戰線 A 客戶畫像與郵箱硬紅線（違反將被系統攔截）
1. **排除軟件公司與千人大型集團（>150人正職熔斷）**：
   - 凡軟件開發、SaaS、AI、系統集成商、數位行銷代操、獵頭公司一律排除！
   - 員工規模明顯超過 150 人且僅招長期編制正職的大型上市集團（如千人餐飲/地產/銀行集團）一律排除！若 \`scrape\` 返回 \`b2bSignals.overSizeWarning: true\`（人數 > 150 人）且非短期約聘/單兵缺口，立即放棄換下一家！聚焦 **15–150 人非軟件實體中小企業**。
2. **嚴禁寄信給 HR / Recruiting 郵箱（極關鍵！）**：
   - 雖然我們通過招聘帖發現對方，但系統 API 會直接拒絕 \`hr@\`、\`jobs@\`、\`careers@\`、\`recruit@\`、\`talent@\`！
   - 必須挖掘並寄往 **創辦人 / 董事長 / 總經理 / 營運或業務總監** 的實名個人企業郵箱（Tier 1 優先）；若官網僅公開 \`info@\` / \`sales@\` / \`enquiry@\` / \`service@\`，可於查明負責人真實姓名與職稱後使用，由郵件開頭請團隊協助轉交負責人。
3. **零幻覺與護域紅線**：
   - \`companyDomain\` 必須是該招募企業的**自家官方主域名**，嚴禁填寫 \`104.com.tw\`、\`1111.com.tw\`、\`jobsdb.com\`、\`cake.me\`、\`linkedin.com\`！
   - \`email\` 必須原樣出現在你本輪抓到的網頁中，嚴禁 \`@biznetvigator.com\` / \`@netvigator.com\` 及 \`.con.cn\` 等網頁錯字域名。
4. **用戰線 A 結構撰寫 \`leadReason\`（供生成精準開發信與 1 頁驗收核對單，嚴守港台用詞與零簡體！）**：
   - \`leadReason\` 必須寫明三項具體事實：**① 近期在招職缺名稱與招聘來源/平台（及是否為 Contract/單兵開發）；② 該職缺對應的真實待建業務系統／工作流（如經銷商訂貨、多語型錄詢價、ERP/倉儲對接、內部自動化報表）；③ 適合拆分為 2–4 週一期獨立驗收工作包的切入點（附參考 URL）**。
   - **港台詞彙嚴格隔離**：香港分片只用「數碼／軟件／源碼／聯絡／查詢」，台灣分片只用「數位／軟體／原始碼／聯繫／洽詢」，**全欄位禁止簡體字**！
5. **JSON 提交格式（寫入 \`${outJsonPath}\`，\`companyCode\` 固定填 \`"auto"\`！）**：
\`\`\`json
[
  {
    "fullName": "真實姓名",
    "title": "真實職位（如 Managing Director / 董事長 / 總經理 / 營運總監）",
    "email": "官網原文出現的商業郵箱（絕非 hr@/jobs@）",
    "phone": "+852 ... 或 +886 ...（如有）",
    "linkedinUrl": "https://www.linkedin.com/in/...（如有，否則 null）",
    "companyLinkedinUrl": "https://www.linkedin.com/company/...（如有，否則 null）",
    "companyName": "公司全稱",
    "companyDomain": "company.com.hk",
    "companyRegion": "${shard.regionLabel}｜具體地區與行業",
    "companyCode": "auto",
    "leadReason": "繁體中文說明：① 近期在招職缺與來源；② 該職缺背後要做的業務系統／工作流；③ 適合作為一期獨立驗收工作包的模組建議（附職缺/官網URL）",
    "verificationNote": "繁體中文說明：在招信號核驗自 <職缺URL>，聯絡人姓名職稱與企業郵箱核驗自 <官網URL>"
  }
]
\`\`\`

現在立即開始 Step A 並發 \`search\`，用最少輪次完成 **${quota} 家** 戰線 A 合格潛客提交並輸出簡短匯總！`;
}

const TRANSIENT_ERROR_RE =
  /(\b503\b|UNAVAILABLE|No capacity available|resource_exhausted|overloaded|ETIMEDOUT|ECONNRESET|EAI_AGAIN)/i;

function spawnWorkerAttempt({ shard, prompt, waveWorkDir, evidenceFile, claimsDir, experimentArm, attempt }) {
  return new Promise((resolve) => {
    const startTs = Date.now();
    const workerCwd = path.join(waveWorkDir, `cwd-${shard.id}`);
    fs.mkdirSync(workerCwd, { recursive: true });
    // Prefer repo root as --workspace so project .cursor/cli.json allowlist applies;
    // keep a per-shard cwd for relative artifacts the agent may write.
    const logPath = path.join(waveWorkDir, `worker-${shard.id}.log`);

    let agentArgs;
    try {
      agentArgs = buildCursorAgentArgs({
        model: MODEL,
        prompt,
        workspace: REPO_ROOT,
        trustWorkspace: true,
        outputFormat: "text",
      });
    } catch (e) {
      resolve({
        shardId: shard.id,
        code: 1,
        elapsedSec: 0,
        logPath,
        stdoutTail: "",
        stderrTail: e.message,
        modelCompatNote: null,
        isTransientFailure: false,
      });
      return;
    }

    const child = spawn(AGENT_BIN, agentArgs, {
      cwd: workerCwd,
      env: {
        ...process.env,
        PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.cursor/bin:${os.homedir()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
        // CURSOR_API_KEY already in process.env when present — do not log it.
        EXA_API_KEY,
        FIRECRAWL_API_KEY,
        AGENTSDR_URL,
        AGENTSDR_API_KEY,
        PROSPECT_EVIDENCE_FILE: evidenceFile,
        PROSPECT_CLAIMS_DIR: claimsDir,
        PROSPECT_SHARD_ID: shard.id,
        OUTREACH_DELIVERY_MODE: DELIVERY_MODE,
        OUTREACH_PACE_MS: String(PACE_MS),
        OUTREACH_EXPERIMENT_ARM: experimentArm,
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(
      `\n--- [Attempt ${attempt} started ${new Date().toISOString()} bin=${AGENT_BIN} model=${MODEL}] ---\n`,
    );

    const killTimer = setTimeout(() => {
      timedOut = true;
      logStream.write(`\n[timeout] killing worker after ${WORKER_TIMEOUT_SEC}s\n`);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 5_000).unref?.();
    }, WORKER_TIMEOUT_SEC * 1000);
    killTimer.unref?.();

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      logStream.write(s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      logStream.write(s);
    });

    child.on("error", (err) => {
      clearTimeout(killTimer);
      logStream.write(`\n[spawn error] ${err.message}\n`);
      logStream.end();
      const elapsedSec = Math.round((Date.now() - startTs) / 1000);
      resolve({
        shardId: shard.id,
        code: 1,
        elapsedSec,
        logPath,
        stdoutTail: stdout.slice(-1200),
        stderrTail: `${stderr}\n${err.message}`.slice(-800),
        modelCompatNote: detectUnsupportedModelMessage(`${stdout}\n${stderr}\n${err.message}`, MODEL),
        isTransientFailure: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      logStream.end();
      const elapsedSec = Math.round((Date.now() - startTs) / 1000);
      const combined = `${stdout}\n${stderr}`;
      resolve({
        shardId: shard.id,
        code: timedOut ? 124 : code,
        elapsedSec,
        logPath,
        stdoutTail: stdout.slice(-1200),
        stderrTail: stderr.slice(-800),
        modelCompatNote: detectUnsupportedModelMessage(combined, MODEL),
        isTransientFailure: !timedOut && code !== 0 && TRANSIENT_ERROR_RE.test(combined),
      });
    });
  });
}

async function runSingleWorker({ shard, quota, waveWorkDir, evidenceFile, claimsDir, waveEpoch, experimentArm }) {
  const backoffMsList = [25_000, 55_000];
  let totalElapsedSec = 0;
  let lastResult = null;
  let retriedTransient = 0;

  for (let attempt = 1; attempt <= backoffMsList.length + 1; attempt++) {
    const basePrompt = buildWorkerPrompt(shard, quota, waveWorkDir, waveEpoch, experimentArm);
    const prompt =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\n【重试提示（第 ${attempt} 次尝试）】上一轮因模型瞬时容量拥堵中断。\`prospect-tool search\` 会自动过滤已入库（\`alreadyInCrm\`）域名；请继续搜集核验并补充提交差额直至达成 **${quota} 家**！`;

    const res = await spawnWorkerAttempt({
      shard,
      prompt,
      waveWorkDir,
      evidenceFile,
      claimsDir,
      experimentArm,
      attempt,
    });
    totalElapsedSec += res.elapsedSec;
    lastResult = { ...res, attempts: attempt, retriedTransient, elapsedSec: totalElapsedSec };

    if (res.modelCompatNote) {
      console.warn(`[compat] ${res.modelCompatNote}`);
    }

    if (res.code === 0) {
      console.log(`[Worker ${shard.id}] exited code=0 in ${totalElapsedSec}s (attempts=${attempt})`);
      return lastResult;
    }

    if (res.isTransientFailure && attempt <= backoffMsList.length) {
      const waitMs = backoffMsList[attempt - 1];
      retriedTransient += 1;
      console.warn(
        `[Worker ${shard.id}] hit transient 503/capacity failure (attempt ${attempt}, code=${res.code}); waiting ${Math.round(waitMs / 1000)}s before retrying same model ${MODEL}...`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    console.log(`[Worker ${shard.id}] exited code=${res.code} in ${totalElapsedSec}s (attempts=${attempt})`);
    return lastResult;
  }

  return lastResult;
}

async function querySentSince(isoSince) {
  const res = await fetch(`${AGENTSDR_URL}/api/crm/drafts?status=all`, {
    headers: { Authorization: `Bearer ${AGENTSDR_API_KEY}` },
  });
  const data = await res.json();
  const drafts = data.drafts ?? [];
  return drafts.filter((d) => d.updatedAt >= isoSince);
}

function collectCliTelemetrySince(startMs) {
  const brainDir = path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");
  if (!fs.existsSync(brainDir)) return [];
  const entries = fs.readdirSync(brainDir);
  const sessions = [];
  for (const id of entries) {
    const tPath = path.join(brainDir, id, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(tPath)) continue;
    const stat = fs.statSync(tPath);
    if (stat.mtimeMs < startMs) continue;
    const lines = fs.readFileSync(tPath, "utf8").trim().split("\n").filter(Boolean);
    if (!lines.length) continue;
    const first = JSON.parse(lines[0]);
    const createdMs = Date.parse(first.created_at || "");
    if (Number.isFinite(createdMs) && createdMs < startMs - 5000) continue;
    const firstContent = first.content || "";
    if (!firstContent.includes("prospect-tool.mjs")) continue;

    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let toolSteps = 0;
    for (const l of lines) {
      const o = JSON.parse(l);
      inputTokens += o.input_tokens || 0;
      cacheTokens += o.cache_read_tokens || 0;
      outputTokens += o.output_tokens || 0;
      if (o.tool_calls?.length) toolSteps += 1;
    }
    const shardMatch = firstContent.match(/分片【([^】]+)】/);
    sessions.push({
      sessionId: id,
      shard: shardMatch ? shardMatch[1] : "unknown",
      totalLines: lines.length,
      toolSteps,
      inputTokens,
      cacheTokens,
      outputTokens,
    });
  }
  return sessions;
}

async function main() {
  const waveStartMs = Date.now();
  const waveStartIso = new Date(waveStartMs).toISOString();
  const waveWorkDir = path.join(WORKDIR_ROOT, `wave-${waveStartMs}`);
  const claimsDir = path.join(waveWorkDir, "claims");
  fs.mkdirSync(claimsDir, { recursive: true });
  const evidenceFile = path.join(waveWorkDir, "evidence.ndjson");

  // Plan rotating shard assignments + dynamic Track A query window + A/B arm across waves
  const activeShardCount = Math.min(CONCURRENCY, Math.max(1, Math.ceil(TARGET_COUNT / 2)), SHARDS.length);
  const { waveEpoch, shardOffset } = loadAndAdvanceWaveEpoch(activeShardCount);
  const experimentArm = resolveExperimentArm(waveEpoch);
  const baseQuota = Math.floor(TARGET_COUNT / activeShardCount);
  const remainder = TARGET_COUNT % activeShardCount;

  console.log(`=== Starting Outreach Wave (epoch=${waveEpoch}, shardOffset=${shardOffset}, arm=${experimentArm}) ===`);
  console.log(`Target: ${TARGET_COUNT} leads | Concurrency: ${CONCURRENCY} | Model: ${MODEL} | Delivery: ${DELIVERY_MODE} (pace=${PACE_MS}ms)`);
  console.log(`Workspace: ${waveWorkDir}`);

  const initialTasks = Array.from({ length: activeShardCount }, (_, idx) => {
    const shard = SHARDS[(shardOffset + idx) % SHARDS.length];
    return {
      shard,
      quota: baseQuota + (idx < remainder ? 1 : 0),
    };
  });

  let shardCursor = shardOffset + activeShardCount;
  const workerResults = [];

  // Run initial wave with concurrency limit and 2.5s launch stagger to avoid Firecrawl burst rate-limits
  let idx = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, initialTasks.length) }, async (_, runnerIdx) => {
    if (runnerIdx > 0) await new Promise((r) => setTimeout(r, runnerIdx * 2500));
    while (true) {
      const cur = idx++;
      if (cur >= initialTasks.length) break;
      const t = initialTasks[cur];
      console.log(`[Launch] Worker ${t.shard.id} (quota=${t.quota})`);
      const r = await runSingleWorker({ shard: t.shard, quota: t.quota, waveWorkDir, evidenceFile, claimsDir, waveEpoch, experimentArm });
      workerResults.push(r);
    }
  });
  await Promise.all(runners);

  // Check if we hit TARGET_COUNT; if slightly short, run top-up shards while within 55-minute budget
  const targetStatus = DELIVERY_MODE === "draft_only" ? "awaiting_review" : DELIVERY_MODE === "queue_working_hours" ? "awaiting_review" : "sent";
  for (let round = 1; round <= 2; round++) {
    const recentDrafts = await querySentSince(waveStartIso);
    const completedCount = recentDrafts.filter((d) =>
      DELIVERY_MODE === "queue_working_hours" ? Boolean(d.autoSendAt) : d.status === targetStatus,
    ).length;
    const elapsedMin = (Date.now() - waveStartMs) / 60_000;
    console.log(`[Check Round ${round}] Completed=${completedCount}/${TARGET_COUNT} | Elapsed=${elapsedMin.toFixed(1)}m`);
    if (completedCount >= TARGET_COUNT || elapsedMin >= 52) break;

    const deficit = TARGET_COUNT - completedCount;
    const topupCount = Math.min(3, Math.ceil(deficit / 4));
    const topupTasks = [];
    for (let k = 0; k < topupCount; k++) {
      const shard = SHARDS[shardCursor % SHARDS.length];
      shardCursor += 1;
      const q = Math.ceil(deficit / topupCount);
      topupTasks.push({ shard: { ...shard, id: `${shard.id}-topup${round}-${k + 1}` }, quota: q });
    }
    console.log(`[Top-up Round ${round}] Launching ${topupTasks.length} shard(s) for remaining ${deficit} leads...`);
    const topupRes = await Promise.all(
      topupTasks.map((t, k) =>
        new Promise((r) => setTimeout(r, k * 2000)).then(() =>
          runSingleWorker({ shard: t.shard, quota: t.quota, waveWorkDir, evidenceFile, claimsDir, waveEpoch: waveEpoch + round, experimentArm }),
        ),
      ),
    );
    workerResults.push(...topupRes);
  }

  const totalElapsedSec = Math.round((Date.now() - waveStartMs) / 1000);
  const recentDrafts = await querySentSince(waveStartIso);
  const telemetry = collectCliTelemetrySince(waveStartMs);
  const inFlightClaimedCount = fs.existsSync(claimsDir) ? fs.readdirSync(claimsDir).filter((f) => f.endsWith(".json")).length : 0;

  const report = {
    waveWorkDir,
    waveEpoch,
    shardOffset,
    experimentArm,
    inFlightClaimedCount,
    target: TARGET_COUNT,
    deliveryMode: DELIVERY_MODE,
    model: MODEL,
    totalElapsedSec,
    totalElapsedMin: Number((totalElapsedSec / 60).toFixed(2)),
    counts: {
      sent: recentDrafts.filter((d) => d.status === "sent").length,
      queued: recentDrafts.filter((d) => d.status === "awaiting_review" && d.autoSendAt).length,
      awaitingReview: recentDrafts.filter((d) => d.status === "awaiting_review" && !d.autoSendAt).length,
      failed: recentDrafts.filter((d) => d.status === "failed").length,
    },
    telemetryTotals: {
      sessions: telemetry.length,
      toolSteps: telemetry.reduce((s, x) => s + x.toolSteps, 0),
      inputTokens: telemetry.reduce((s, x) => s + x.inputTokens, 0),
      cacheTokens: telemetry.reduce((s, x) => s + x.cacheTokens, 0),
      outputTokens: telemetry.reduce((s, x) => s + x.outputTokens, 0),
    },
    telemetryBySession: telemetry,
    executor: "cursor-agent",
    agentBin: AGENT_BIN,
    workers: workerResults.map((w) => ({
      shardId: w.shardId,
      code: w.code,
      elapsedSec: w.elapsedSec,
      attempts: w.attempts ?? 1,
      retriedTransient: w.retriedTransient ?? 0,
      logPath: w.logPath,
      modelCompatNote: w.modelCompatNote || null,
    })),
    leads: recentDrafts.map((d) => ({
      code: d.company?.code,
      company: d.company?.name,
      domain: d.company?.domain,
      person: d.person?.fullName,
      title: d.person?.title,
      toEmail: d.toEmail,
      fromEmail: d.fromEmail,
      status: d.status,
      subject: d.subject,
    })),
  };

  const reportPath = path.join(waveWorkDir, "wave-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`=== Wave Finished in ${totalElapsedSec}s (${report.totalElapsedMin} min) ===`);
  console.log(`Report saved to: ${reportPath}`);
  console.log(JSON.stringify({ counts: report.counts, telemetryTotals: report.telemetryTotals, totalElapsedSec }, null, 2));
}

main().catch((err) => {
  console.error("Wave fatal error:", err);
  process.exit(1);
});
