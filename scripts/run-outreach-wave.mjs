#!/usr/bin/env node
/**
 * Autonomous AGY Outreach Wave Orchestrator & Telemetry Auditor
 *
 * Guides parallel sharded `agy` CLI workers to discover, verify, import, draft,
 * quality-audit, and send personalized outreach emails via AgentSDR within < 1 hour.
 *
 * Usage:
 *   node scripts/run-outreach-wave.mjs --target 25 --concurrency 5 --model gemini-3.8-flash-medium --delivery send_paced --pace-ms 8000
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
function getArg(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const TARGET_COUNT = Number(getArg("--target", "25"));
const CONCURRENCY = Number(getArg("--concurrency", "5"));
const MODEL = getArg("--model", "gemini-3.8-flash-medium");
const DELIVERY_MODE = getArg("--delivery", "send_paced");
const PACE_MS = Number(getArg("--pace-ms", "8000"));
const WORKER_TIMEOUT_SEC = Number(getArg("--worker-timeout", "900"));

const AGENTSDR_URL = process.env.AGENTSDR_URL || "http://127.0.0.1:13031";
const AGENTSDR_API_KEY = process.env.AGENTSDR_API_KEY || "agentsdr_test_api_key_for_automation_2026";
const PROSPECT_TOOL = "/Users/ivan/projects/AgentSDR/scripts/prospect-tool.mjs";

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || (() => {
  try {
    const envText = fs.readFileSync("/Users/ivan/projects/lumina-labs-agent/.env.local", "utf8");
    const m = envText.match(/^FIRECRAWL_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
  } catch {
    return "";
  }
})();

if (!FIRECRAWL_API_KEY) {
  console.error("Missing FIRECRAWL_API_KEY");
  process.exit(1);
}

const SHARDS = [
  {
    id: "hk-machinery-metal",
    regionLabel: "香港",
    vertical: "香港传统机械设备、精密五金、模具压铸及工业制品制造厂（独占名录：hkmma.org.hk）",
    queryPool: [
      `site:hkmma.org.hk/co-detail-en.php "Director" OR "Manager" "@" `,
      `site:hkmma.org.hk/co-detail.php "董事" OR "經理" "@" `,
      `"Managing Director" "Hong Kong" ("Machinery" OR "Mould" OR "Die Casting" OR "Metalware") "Limited" "@"`,
      `"香港" ("五金製品" OR "精密模具" OR "壓鑄" OR "機械製造") ("董事" OR "總經理") ("觀塘" OR "葵涌" OR "荃灣") "@"`,
      `"Executive Director" "Hong Kong" ("Stamping" OR "CNC" OR "Spring" OR "Fastener" OR "Metal") "Ltd" email "@"`,
      `"香港" ("金屬製品有限公司" OR "機械有限公司") ("董事總經理" OR "創辦人") ("屯門" OR "火炭" OR "粉嶺") "@"`,
    ],
  },
  {
    id: "tw-machinery-pack",
    regionLabel: "台湾",
    vertical: "台湾包装机械、食品机械、木工/塑胶机械或自动化加工设备制造厂",
    queryPool: [
      `("包裝機械" OR "食品機械") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("木工機械" OR "塑膠機械" OR "射出成型機") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("台中" OR "神岡" OR "豐原" OR "大里") "機械工業股份有限公司" ("董事長" OR "總經理" OR "負責人") "@"`,
      `("桃園" OR "中壢" OR "蘆竹" OR "樹林") "機械股份有限公司" ("董事長" OR "總經理") ("信箱" OR "Email") site:.tw`,
      `("台南" OR "永康" OR "仁德") ("機械有限公司" OR "自動化設備") ("負責人" OR "總經理") "@" site:.com.tw`,
      `("製袋機" OR "貼標機" OR "充填機" OR "輸送機") ("股份有限公司" OR "有限公司") ("董事長" OR "總經理") "@"`,
    ],
  },
  {
    id: "hk-food-consumer",
    regionLabel: "香港",
    vertical: "香港食品餐饮原料进出口批发、烘焙酱料制造、家居厨具或美妆个护品牌（独占名录：fhki.org.hk）",
    queryPool: [
      `site:fhki.org.hk "Director" OR "General Manager" ("Food" OR "Beverage" OR "Trading" OR "Consumer") "@"`,
      `"Managing Director" OR "Founder" "Hong Kong" ("Food" OR "Bakery" OR "Beverage" OR "Sauce" OR "Catering") "@" `,
      `"Managing Director" "Hong Kong" ("Houseware" OR "Kitchenware" OR "Tableware" OR "Home Products") "Ltd" "@"`,
      `"香港" ("食品有限公司" OR "餐飲供應" OR "食材批發" OR "醬料") ("董事" OR "創辦人" OR "總經理") "@"`,
      `"香港" ("家品" OR "廚具" OR "化妝品" OR "個人護理") "有限公司" ("董事" OR "總經理") ("葵涌" OR "荃灣" OR "長沙灣") "@"`,
      `"Founder" OR "Director" "Hong Kong" ("Cosmetics" OR "Skincare" OR "Personal Care" OR "Health Food") "Limited" "@"`,
    ],
  },
  {
    id: "tw-hardware-mold",
    regionLabel: "台湾",
    vertical: "台湾手工具五金、精密模具、螺丝扣件、阀门管件、气动工具或工业耗材制造厂",
    queryPool: [
      `("手工具" OR "氣動工具" OR "五金工業") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("螺絲" OR "扣件" OR "彈簧" OR "鍛造") "工業股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("閥門" OR "管件" OR "油壓" OR "空壓") "股份有限公司" ("董事長" OR "總經理" OR "負責人") "@" site:.tw`,
      `("彰化" OR "鹿港" OR "和美" OR "太平") ("五金" OR "金屬" OR "精密") "股份有限公司" ("董事長" OR "總經理") "@"`,
      `("高雄" OR "岡山" OR "路竹" OR "仁武") ("工業股份有限公司" OR "企業股份有限公司") ("董事長" OR "總經理") "@" site:.com.tw`,
      `("精密模具" OR "壓鑄" OR "表面處理" OR "研磨材料") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
    ],
  },
  {
    id: "hk-logistics-eng",
    regionLabel: "香港",
    vertical: "香港国际货运物流仓储、冷链配送、机电冷气工程、环保水处理或检测认证服务商（独占名录：haffa.com.hk）",
    queryPool: [
      `site:haffa.com.hk "Director" OR "General Manager" "@"`,
      `"Managing Director" "Hong Kong" ("Logistics" OR "Freight Forwarding" OR "Warehousing" OR "Cold Chain") "Ltd" "@"`,
      `"Managing Director" "Hong Kong" ("E&M" OR "HVAC" OR "Air Conditioning" OR "Fire Engineering" OR "Environmental") "Limited" "@"`,
      `"香港" ("國際貨運" OR "物流有限公司" OR "冷鏈" OR "倉儲") ("董事" OR "總經理") "@"`,
      `"香港" ("機電工程" OR "冷氣工程" OR "消防工程" OR "環保工程") "有限公司" ("董事" OR "總經理") "@"`,
      `"Director" "Hong Kong" ("Testing" OR "Inspection" OR "Laboratory" OR "Marine Engineering") "Limited" "@"`,
    ],
  },
  {
    id: "tw-food-biotech",
    regionLabel: "台湾",
    vertical: "台湾食品加工出口、茶业饮品、烘焙餐饮原物料供应链、生技保健品OEM代工厂或农水产贸易商",
    queryPool: [
      `("食品工業" OR "食品股份有限公司" OR "冷凍食品") ("董事長" OR "總經理") "@" site:.com.tw`,
      `("生技股份有限公司" OR "保健食品" OR "營養品") ("OEM" OR "代工") ("董事長" OR "總經理") "@" site:.com.tw`,
      `("茶業" OR "咖啡" OR "飲品原料" OR "烘焙原料") ("股份有限公司" OR "有限公司") ("董事長" OR "總經理" OR "負責人") "@" site:.tw`,
      `("水產" OR "農產" OR "調味料" OR "醬油") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("嘉義" OR "雲林" OR "屏東" OR "南投") ("食品" OR "生技" OR "農產") "股份有限公司" ("董事長" OR "總經理") "@"`,
      `("餐飲設備" OR "中央廚房" OR "食品原料") "有限公司" ("負責人" OR "總經理") "@" site:.com.tw`,
    ],
  },
  {
    id: "hk-packaging-optical",
    regionLabel: "香港",
    vertical: "香港印刷包装纸品、钟表眼镜制造、珠宝首饰出口或工业包装材料厂（独占名录：cma.org.hk）",
    queryPool: [
      `site:cma.org.hk "Director" OR "董事" "@"`,
      `"Managing Director" "Hong Kong" ("Packaging" OR "Printing" OR "Paper Products" OR "Label") "Limited" "@"`,
      `"Managing Director" OR "Director" "Hong Kong" ("Optical" OR "Eyewear" OR "Watch" OR "Timepiece") "Ltd" "@"`,
      `"香港" ("印刷有限公司" OR "包裝有限公司" OR "紙品廠" OR "彩印") ("董事" OR "總經理") "@"`,
      `"香港" ("眼鏡製造" OR "鐘錶有限公司" OR "首飾製造") ("董事" OR "創辦人") ("觀塘" OR "新蒲崗" OR "紅磡") "@"`,
      `"Executive Director" "Hong Kong" ("Jewellery" OR "Gift Box" OR "Corrugated" OR "Plastic Packaging") "Limited" "@"`,
    ],
  },
  {
    id: "tw-building-medical",
    regionLabel: "台湾",
    vertical: "台湾建材卫浴五金、办公/商用家具制造、医疗耗材复健器材制造批发或专业照明厂",
    queryPool: [
      `("醫療器材" OR "復健器材" OR "醫材") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("衛浴" OR "水龍頭" OR "建築材料" OR "門窗") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("家具" OR "辦公家具" OR "照明" OR "燈飾") ("股份有限公司" OR "工業有限公司") ("董事長" OR "總經理") "@" site:.tw`,
      `("醫用耗材" OR "牙科材料" OR "輔具" OR "實驗室設備") ("股份有限公司" OR "有限公司") ("董事長" OR "總經理") "@"`,
      `("磁磚" OR "石材" OR "防火建材" OR "隔音建材") ("股份有限公司" OR "實業有限公司") ("董事長" OR "總經理") "@" site:.com.tw`,
      `("苗栗" OR "新竹" OR "彰化" OR "台中") ("建材" OR "家具" OR "衛浴") "股份有限公司" ("董事長" OR "總經理") "@"`,
    ],
  },
  {
    id: "hk-apparel-toys-elec",
    regionLabel: "香港",
    vertical: "香港纺织制衣辅料、玩具礼品制造出口、家用电器照明或电子零组件贸易（非软件）（独占名录：hketa.org.hk）",
    queryPool: [
      `site:hketa.org.hk "Director" OR "Manager" "@"`,
      `"Managing Director" "Hong Kong" ("Garment" OR "Textile" OR "Apparel" OR "Knitting") "Limited" "@"`,
      `"Managing Director" "Hong Kong" ("Toys" OR "Gifts" OR "Premiums" OR "Stationery") "Ltd" "@"`,
      `"Managing Director" "Hong Kong" ("Home Appliances" OR "Lighting" OR "Cable" OR "Power Supply") "Limited" "@"`,
      `"香港" ("製衣有限公司" OR "紡織" OR "玩具" OR "禮品有限公司") ("董事" OR "總經理") "@"`,
      `"香港" ("電器製品" OR "燈飾有限公司" OR "電子零件" OR "電線") ("董事" OR "總經理") "@"`,
    ],
  },
  {
    id: "tw-auto-chem-textile",
    regionLabel: "台湾",
    vertical: "台湾汽机车/自行车零配件、橡塑胶与化工新材料、机能纺织织带或运动器材OEM制造厂",
    queryPool: [
      `("汽車零件" OR "車燈" OR "機車零件" OR "自行車零件") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("塑膠工業" OR "橡膠工業" OR "矽膠" OR "複合材料") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("化工" OR "塗料" OR "樹脂" OR "接著劑") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("紡織" OR "織帶" OR "不織布" OR "運動器材" OR "健身器材") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
      `("台南" OR "彰化" OR "台中") ("車業" OR "車材" OR "運動用品") "股份有限公司" ("董事長" OR "總經理") "@" site:.tw`,
      `("精密塑膠" OR "包裝材料" OR "膠帶" OR "薄膜") "股份有限公司" ("董事長" OR "總經理") "@" site:.com.tw`,
    ],
  },
];

const WAVE_CURSOR_FILE = "/tmp/agy-outreach-workdir/wave-cursor.json";

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

function buildWorkerPrompt(shard, quota, waveWorkDir, waveEpoch) {
  const outJsonPath = path.join(waveWorkDir, `leads-${shard.id}.json`);
  const activeSearchHints = selectQueriesForShard(shard, waveEpoch, 3);
  return `你是高效精准的 B2B 拓客执行 Agent。本轮你的唯一任务是为分片【${shard.id}】（方向：${shard.vertical}）寻获、核验并成功提交 **${quota} 家** 全新合格潜在客户（系统会自动完成入库、生成繁体中文开发信并按节流节奏发出邮件）。

### 一、工具与极速执行纪律（严省耗时与 Token！）
1. **绝对禁止触碰系统与容器**：严禁读取或修改 \`/Users/ivan/projects/AgentSDR\` 源码、严禁执行任何 \`docker\` / \`psql\` / \`lsof\` / \`curl\` 命令、严禁使用浏览器或 MCP 工具！全程**只允许**调用 \`node ${PROSPECT_TOOL}\`（与写 JSON 文件）。
2. **所有命令已内置 API Key、CRM 批量查重与跨分片在途防撞锁（Claim Lock）**：
   - **并发搜索（自动剔除已入库 \`alreadyInCrm\` 及其他并行分片已认领的域名，只返回全新候选！）**：
     \`node ${PROSPECT_TOOL} search ${activeSearchHints.map((q) => `'${q}'`).join(" ")}\`
     （一次传入 3–4 个查询词！若首轮候选不足，请结合你的分片垂直方向自拟更细分的子品类/工业区关键词再搜一轮，**严禁跨出本分片行业方向**去搜其他行业！）
   - **并发抓取网页（一次传 4–8 个 URL；自动原子抢占该企业域名锁，若返回 \`skippedClaimedByShard\` 说明其他分片正在处理，直接换下一家）**：
     \`node ${PROSPECT_TOOL} scrape "https://..." "https://..." ...\`
   - **批量提交入库+生成开发信+发送（一步完成！）**：
     先用 \`write_file\` 将核验完毕的客户数组写入 \`${outJsonPath}\`，然后执行：
     \`node ${PROSPECT_TOOL} submit ${outJsonPath}\`
     ⚠️ **重要**：\`submit\` 会并发生成邮件并按间隔节流发送，耗时约 25–60 秒；当命令转为后台任务运行时，**严禁调用 \`manage_task\` 轮询**，直接简短回复一句话结束当前回合，系统会在发送完毕后自动唤醒你！
3. **2-Hop 快速止损原则（严禁恋战！）**：
   - 若某公司抓完官网首页 + About/Contact 页（或商会详情页）仍无**真实高管/负责人姓名+职务**或无**公开邮箱**，**立即放弃**！绝不对同一家公司搜索超过 2 次！
   - 为了稳妥一次性达成 **${quota} 家** \`status: "sent"\`，建议一次搜集核验 **${quota + 1} 家** 候选一并写入 JSON 后执行一次 \`submit\`；若某条被跳过或拦截导致 \`sent < ${quota}\`，直接换新候选补齐差额再 \`submit\`（绝不排查原因），一旦累计 \`sent >= ${quota}\` 立即结束汇报！

### 二、客户画像与真实性硬红线（系统 API 会自动拦截违规项！）
1. **严禁开拓软件 / IT / AI / 科技方案商，且避开大型上市集团**：凡软件开发、SaaS、AI、系统集成、MarTech、数码港/科学园纯技术公司一律排除！同时避开跨国或港股/台股大型综合上市集团（如其士集团、龙记集团等千人级集团），只聚焦**员工 <150 人的中小型实体制造、B2B贸易批发、消费品牌、物流货代、医疗器械等传统/垂直企业**。
2. **实名决策/负责人必填**：\`fullName\`（真实人名，严禁填 Desk/Team/客服/负责人等代称）+ \`title\`（如 Managing Director / Director / Founder / 董事長 / 總經理 / 負責人）必须有公开页面原文印证（可结合商会名录/台湾工商公开信息与官网交叉印证）。
3. **100% 原文公开邮箱（系统会核验抓取证据库！）**：
   - \`email\` **必须原样出现在你本轮 \`search\` 或 \`scrape\` 抓到的页面中**（严禁猜测拼凑个人邮箱前缀！优先选择企业独立域名邮箱或 \`@hibox.hinet.net\`/\`@netvigator.com\` 商务邮箱，尽量少用免费 \`@gmail.com\` 除非是香港工业总会/金属制造业协会等官方名录登记邮箱）。
   - 优先实名高管邮箱；若官网仅公开 \`info@\` / \`sales@\` / \`enquiry@\` / \`service@\` 等官方商务邮箱但已核实明确的董事/总经理姓名与职务，可用该实名负责人搭配该官方商务邮箱，并在 \`verificationNote\` 如实写明。**严禁使用 \`support@\`、\`cs@\`、\`hr@\`、\`jobs@\`、\`careers@\`、\`ir@\`、\`privacy@\`**。
4. **JSON 提交格式（写入 \`${outJsonPath}\`）**：
\`\`\`json
[
  {
    "fullName": "真实姓名",
    "title": "真实职位",
    "email": "页面原文出现的邮箱",
    "phone": "+852 ... 或 +886 ...（如有）",
    "linkedinUrl": null,
    "companyName": "公司全称",
    "companyDomain": "company.com.hk",
    "companyRegion": "${shard.regionLabel}｜具体地区或行业",
    "companyCode": "auto",
    "leadReason": "中文说明：该公司具体实体主业是什么，为何自身非软件企业但在海外B2B产品目录/询盘报价系统/客户门户或业务数字化上有明确合作切入空间（附参考URL）",
    "verificationNote": "中文说明：联系人姓名与职位核验自 <具体URL1>，邮箱与电话核验自 <具体URL2>"
  }
]
\`\`\`

现在立即开始第 1 步并发 \`search\`，用最少轮次完成 **${quota} 家** 有效发送并输出简短汇总！`;
}

function runSingleWorker({ shard, quota, waveWorkDir, evidenceFile, claimsDir, waveEpoch }) {
  return new Promise((resolve) => {
    const startTs = Date.now();
    const workerCwd = path.join(waveWorkDir, `cwd-${shard.id}`);
    fs.mkdirSync(workerCwd, { recursive: true });
    const prompt = buildWorkerPrompt(shard, quota, waveWorkDir, waveEpoch);
    const logPath = path.join(waveWorkDir, `worker-${shard.id}.log`);

    const child = spawn(
      "/Users/ivan/.local/bin/agy",
      [
        "--model",
        MODEL,
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
        "--print-timeout",
        `${WORKER_TIMEOUT_SEC}s`,
        "--print",
        prompt,
      ],
      {
        cwd: workerCwd,
        env: {
          ...process.env,
          PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          FIRECRAWL_API_KEY,
          AGENTSDR_URL,
          AGENTSDR_API_KEY,
          PROSPECT_EVIDENCE_FILE: evidenceFile,
          PROSPECT_CLAIMS_DIR: claimsDir,
          PROSPECT_SHARD_ID: shard.id,
          OUTREACH_DELIVERY_MODE: DELIVERY_MODE,
          OUTREACH_PACE_MS: String(PACE_MS),
        },
      },
    );

    let stdout = "";
    let stderr = "";
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

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

    child.on("close", (code) => {
      logStream.end();
      const elapsedSec = Math.round((Date.now() - startTs) / 1000);
      console.log(`[Worker ${shard.id}] exited code=${code} in ${elapsedSec}s`);
      resolve({ shardId: shard.id, code, elapsedSec, logPath, stdoutTail: stdout.slice(-800), stderrTail: stderr.slice(-400) });
    });
  });
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
  const waveWorkDir = `/tmp/agy-outreach-workdir/wave-${waveStartMs}`;
  const claimsDir = path.join(waveWorkDir, "claims");
  fs.mkdirSync(claimsDir, { recursive: true });
  const evidenceFile = path.join(waveWorkDir, "evidence.ndjson");

  // Plan rotating shard assignments + dynamic sub-vertical query window across waves
  const activeShardCount = Math.min(CONCURRENCY, Math.max(1, Math.ceil(TARGET_COUNT / 5)), SHARDS.length);
  const { waveEpoch, shardOffset } = loadAndAdvanceWaveEpoch(activeShardCount);
  const baseQuota = Math.floor(TARGET_COUNT / activeShardCount);
  const remainder = TARGET_COUNT % activeShardCount;

  console.log(`=== Starting Outreach Wave (epoch=${waveEpoch}, shardOffset=${shardOffset}) ===`);
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
      const r = await runSingleWorker({ shard: t.shard, quota: t.quota, waveWorkDir, evidenceFile, claimsDir, waveEpoch });
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
          runSingleWorker({ shard: t.shard, quota: t.quota, waveWorkDir, evidenceFile, claimsDir, waveEpoch: waveEpoch + round }),
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
    workers: workerResults.map((w) => ({ shardId: w.shardId, code: w.code, elapsedSec: w.elapsedSec, logPath: w.logPath })),
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
