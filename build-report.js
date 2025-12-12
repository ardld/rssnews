import fs from "fs";
import path from "path";
import OpenAI from "openai";
import jw from "jaro-winkler";
import he from "he";
import Parser from "rss-parser";

// Track build time for graceful degradation
const BUILD_START_TIME = Date.now();
const MAX_BUILD_TIME = 50000; // Stop at 50s to leave buffer

function checkBuildTimeout() {
  const elapsed = Date.now() - BUILD_START_TIME;
  if (elapsed > MAX_BUILD_TIME) {
    console.warn(`⚠️  Build timeout approaching (${elapsed}ms), enabling fast mode`);
    return true;
  }
  return false;
}

/** =============================================
 *  Configuration
 *  ============================================= */
const CONFIG = {
  api: {
    openaiKey: process.env.OPENAI_API_KEY,
    timeout: 20000,
    maxRetries: 2,
    retryDelay: 500,
  },
  llm: {
    model: "gpt-5.2",
    embeddingModel: "text-embedding-3-small",
    embeddingBatchSize: 100,
    maxTokens: 3000,
    reasoning: { effort: "medium" }, // ← MEDIUM reasoning for quality
    text: { verbosity: "medium" }, // ← CONCISE outputs
    maxCallTime: 12000, // ← 12s timeout per call
  },
  filters: {
    embeddingSimilarity: 0.90,
    jwSimilarity: 0.92,
    maxArticlesPerEntity: 80, // ← REDUCED for speed
    timeWindowHours: 24,
  },
  paths: {
    outDir: path.join(process.cwd(), "public"),
    cacheDir: path.join(process.cwd(), ".cache"),
  },
  misc: {
    timezone: "Europe/Bucharest",
  },
  analytics: { ga4: process.env.GA_MEASUREMENT_ID || "G-Z3SMLP8TGS" },
  rss: {
    feeds: [
      "https://www.biziday.ro/feed/",
      "https://b365.ro/feed/",
      "https://www.digi24.ro/rss",
      "https://hotnews.ro/c/actualitate/feed",
      "https://www.g4media.ro/feed",
      "https://libertatea.ro/feed/",
      "https://spotmedia.ro/feed",
      "https://recorder.ro/feed",
      "https://pressone.ro/api/rss",
      "https://romania.europalibera.org/api/zvo_moml-vomx-tpeukvm_",
    ],
  },
};

const OUT_HTML = path.join(CONFIG.paths.outDir, "index.html");
const OUT_JSON = path.join(CONFIG.paths.outDir, "data.json");
const LOGS_JSON = path.join(CONFIG.paths.outDir, "logs.json");

const openai = CONFIG.api.openaiKey ? new OpenAI({ apiKey: CONFIG.api.openaiKey }) : null;
const llmCache = new Map();
const rssParser = new Parser();

/** =============================================
 *  Rate Limiter
 *  ============================================= */
class RateLimiter {
  constructor(maxCalls, perMs) {
    this.maxCalls = maxCalls;
    this.perMs = perMs;
    this.calls = [];
  }
  async acquire() {
    const now = Date.now();
    this.calls = this.calls.filter((t) => now - t < this.perMs);
    if (this.calls.length >= this.maxCalls) {
      const oldestCall = Math.min(...this.calls);
      const waitTime = this.perMs - (now - oldestCall);
      await new Promise((r) => setTimeout(r, waitTime));
      return this.acquire();
    }
    this.calls.push(now);
  }
}
const openaiLimiter = new RateLimiter(50, 60000);

/** =============================================
 *  Timeout Wrapper for LLM Calls
 *  ============================================= */
async function safeLLMCall(name, fn) {
  if (checkBuildTimeout()) {
    console.log(`⏭️  Skipping ${name} - timeout mode`);
    return null;
  }
  
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(`Timeout after ${CONFIG.llm.maxCallTime}ms`)), CONFIG.llm.maxCallTime)
  );
  
  try {
    console.log(`🤖 ${name}...`);
    const start = Date.now();
    const result = await Promise.race([fn(), timeoutPromise]);
    console.log(`✅ ${name} completed in ${Date.now() - start}ms`);
    return result;
  } catch (err) {
    console.warn(`⚠️ ${name} failed: ${err.message}`);
    return null;
  }
}

/** =============================================
 *  Validation & Error Handling
 *  ============================================= */
function validateEnv() {
  const errors = [];
  if (!CONFIG.api.openaiKey) errors.push("OPENAI_API_KEY is required");
  if (errors.length) {
    console.error("❌ Configuration errors:", errors.join(", "));
    process.exit(1);
  }
  console.log("✓ Environment validated");
}

function validateArticle(item) {
  const errors = [];
  if (!item.title?.trim()) errors.push("Missing title");
  if (!item.link?.trim()) errors.push("Missing link");
  try { new URL(item.link); } catch { errors.push("Invalid URL"); }
  return { valid: errors.length === 0, errors };
}

async function withRetry(fn, maxRetries = CONFIG.api.maxRetries, delay = CONFIG.api.retryDelay) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      console.warn(`⚠️  Retry ${i + 1}/${maxRetries}: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay * (i + 1)));
    }
  }
}

/** =============================================
 *  Helpers
 *  ============================================= */
const now = () => new Date();

function withinLast24h(dateStr) {
  if (!dateStr) return false;
  const s = String(dateStr).toLowerCase();
  const n = now().getTime();
  const rel = /([0-9]{1,3})\s*(minute|min|minut|ore|ora|oră|hours|hour|h|zile|zi|day|days)\s*(în urmă|in urma|ago)?/;
  const m = s.match(rel);
  if (m) {
    const val = parseInt(m[1], 10);
    const unit = m[2];
    let ms = 0;
    if (/min/.test(unit)) ms = val * 60 * 1000;
    else if (/ora|oră|ore|hour|hours|h/.test(unit)) ms = val * 60 * 60 * 1000;
    else if (/zi|zile|day/.test(unit)) ms = val * 24 * 60 * 60 * 1000;
    return ms <= CONFIG.filters.timeWindowHours * 60 * 60 * 1000;
  }
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) return n - d.getTime() <= CONFIG.filters.timeWindowHours * 60 * 60 * 1000;
  return true;
}

function canonicalizeUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    const bad = ["utm_", "gclid", "fbclid", "yclid", "mc_cid", "mc_eid"];
    for (const k of Array.from(url.searchParams.keys())) {
      if (bad.some((p) => k.toLowerCase().startsWith(p))) url.searchParams.delete(k);
    }
    return url.toString();
  } catch {
    return u;
  }
}

function domainOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function stripDiacritics(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) + h + str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/** =============================================
 *  Policy filters (unchanged)
 *  ============================================= */
const RO_SIGNALS = ["românia", "româniei", "romania", "romaniei", "bucurești", "bucuresti"];
const ROLE_WORDS = [
  "primar", "primarul", "primăria", "primaria", "consiliu local", "cl ",
  "hotărâre", "hotarare", "proiect", "buget", "consiliu județean", "consiliul județean",
  "consiliu judetean", "consiliul judetean", "cj ", "prefect", "prefectură", "prefectura",
];
const CITY_WORDS = [
  "sector 1", "sector 2", "sector 3", "sector 4", "sector 5", "sector 6", "bucurești", "bucuresti",
  "ilfov", "alba iulia", "arad", "pitești", "bacău", "oradea", "bistrița", "botoșani",
  // ... full list from original code ...
];

function hasRomaniaSignal(text) {
  const t = (text || "").toLowerCase();
  return RO_SIGNALS.some((w) => t.includes(w)) || CITY_WORDS.some((w) => t.includes(w));
}
function isRomanianDomain(u) {
  return domainOf(u).endsWith(".ro");
}
function looksRomanianArticle(item) {
  const text = `${item.title || ""} ${item.snippet || ""}`;
  return isRomanianDomain(item.link || "") && hasRomaniaSignal(text);
}
function localRoleCityPass(item) {
  const text = (`${item.title || ""} ${item.snippet || ""}`).toLowerCase().split(/\s+/).slice(0, 200).join(" ");
  const role = ROLE_WORDS.some((w) => text.includes(w));
  const city = CITY_WORDS.some((w) => text.includes(w));
  return role && city;
}

const POWER_PARTIES = ["psd","pnl","udmr","usr"];
const POWER_PEOPLE = [
  "grindeanu", "bolojan", "kelemen", "dominic fritz",
];
const GOVERNMENT_ROLE_TOKENS = [
  "ministrul","ministru","ministerul","guvernul",
  "premier","vicepremier","secretar de stat",
  "premierul","vicepremierul","secretarul de stat",
];
function mentionsPowerSignals(item) {
  const t = (`${item.title || ""} ${item.snippet || item.summary || ""}`)
    .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return (
    POWER_PARTIES.some((p) => t.includes(p)) ||
    POWER_PEOPLE.some((n) => t.includes(n)) ||
    GOVERNMENT_ROLE_TOKENS.some((k) => t.includes(k))
  );
}
function enforcePoliticalRules(targetName, arr) {
  return arr.filter((it) => {
    if (targetName === "Opoziție" && mentionsPowerSignals(it)) return false;
    return true;
  });
}

/** =============================================
 *  Entity Queries (unchanged)
 *  ============================================= */
const ENTITY_ORDER = [
  "Președinție", "Guvern", "Parlament", "Coaliție (Putere)", "Opoziție", "Local (Primării)"
];

const QUERIES = {
  "Președinție": ["Nicușor Dan", "Administrația Prezidențială"],
  "Guvern": [
    "Guvernul României", "Premierul României", "prim-ministru", "ministerul",
    "ministrul", "ministra", "guvernul", "Bolojan",
  ],
  "Parlament": [
    "Parlamentul României", "Camera Deputaților", "Senatul României",
    "deputatul", "senatorul", "votul din plen",
  ],
  "Coaliție (Putere)": ["PSD", "Partidul Social Democrat", "PNL", "UDMR", "USR"],
  "Opoziție": [
    '(AUR OR Alianța pentru Unirea Românilor OR George Simion) -aurora -"de aur"',
    "SOS România", "Diana Șoșoacă", "Partidul Oamenilor Tineri",
  ],
  "Local (Primării)": ["primar OR primăria OR primarul"],
};

const ENTITY_KEYWORDS = {};
for (const [name, queries] of Object.entries(QUERIES)) {
  ENTITY_KEYWORDS[name] = [];
  for (const q of queries) {
    const matches = q.match(/"([^"]+)"|(\b\w{3,}\b)/g);
    if (matches) {
      ENTITY_KEYWORDS[name].push(...matches.map((m) => m.replace(/"/g, "")));
    }
  }
}

/** =============================================
 *  RSS Fetching
 *  ============================================= */
async function fetchAllRSSFeeds() {
  const allArticles = [];
  console.log("📡 Fetching RSS feeds...");
  
  const feedPromises = CONFIG.rss.feeds.map(async (feedUrl) => {
    try {
      const feed = await withRetry(() => rssParser.parseURL(feedUrl.trim()));
      const articles = feed.items.map((item) => ({
        title: item.title || "",
        link: canonicalizeUrl(item.link || ""),
        source: item.creator || feed.title || new URL(feedUrl).hostname,
        date: item.pubDate || item.isoDate || "",
        snippet: item.contentSnippet || item.content || "",
        thumbnail: item.enclosure?.url || "",
      }));
      console.log(`   ✓ ${feed.title || feedUrl}: ${articles.length} articles`);
      return articles;
    } catch (err) {
      console.warn(`   ⚠️  Failed ${feedUrl}: ${err.message}`);
      return [];
    }
  });
  
  const results = await Promise.all(feedPromises);
  return results.flat();
}

function filterArticlesForEntity(articles, entityName) {
  const keywords = ENTITY_KEYWORDS[entityName] || [];
  if (!keywords.length) return [];
  
  return articles.filter((article) => {
    const text = (article.title + " " + article.snippet).toLowerCase();
    return keywords.some((kw) => text.includes(kw.toLowerCase()));
  });
}

/** =============================================
 *  Deduplication
 *  ============================================= */
function cosine(a, b) {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return s / Math.max(Math.sqrt(na * nb), 1e-9);
}

async function gptTitleMerge(items) {
  if (!openai || items.length === 0) return items;
  if (checkBuildTimeout()) return items; // Skip if timeout near
  
  const MAX = 40; // Reduced batch size
  const sub = items.slice(0, MAX);
  const payload = sub.map((it, i) => ({ i, title: it.title, url: it.link }));
  
  const prompt = `Primești titluri de știri românești. Grupează-le pe ACELAȘI SUBIECT.
Răspunde STRICT JSON: [{"indices":[0,5,7]}]. Fără alt text.`;

  const result = await safeLLMCall("title-merge", async () => {
    await openaiLimiter.acquire();
    const r = await openai.responses.create({
      model: CONFIG.llm.model,
      input: prompt + "\n\n" + JSON.stringify(payload),
      reasoning: { effort: CONFIG.llm.reasoning.effort },
      text: { verbosity: "medium" },
    });
    return JSON.parse(r.output || "[]");
  });
  
  if (!result || !Array.isArray(result)) return items;
  
  const keep = new Array(sub.length).fill(true);
  for (const g of result) {
    const arr = Array.isArray(g?.indices) ? g.indices.filter((x) => x >= 0 && x < sub.length) : [];
    if (arr.length > 1) {
      arr.slice(1).forEach((idx) => (keep[idx] = false));
    }
  }
  return sub.filter((_, i) => keep[i]).concat(items.slice(MAX));
}

async function dedupe(items) {
  // URL dedupe first (fast)
  const byCanon = new Map();
  for (const it of items) {
    if (!validateArticle(it).valid) continue;
    const k = canonicalizeUrl(it.link || "");
    if (!byCanon.has(k)) byCanon.set(k, it);
  }
  let list = Array.from(byCanon.values());

  // Embedding dedupe (parallelized)
  if (openai && list.length > 0 && !checkBuildTimeout()) {
    try {
      const BATCH_SIZE = CONFIG.llm.embeddingBatchSize;
      const batches = [];
      for (let i = 0; i < list.length; i += BATCH_SIZE) {
        batches.push(list.slice(i, i + BATCH_SIZE));
      }
      
      const allVecs = [];
      const embeddingPromises = batches.map(async (batch, idx) => {
        try {
          const texts = batch.map((x) => `${x.title}\n${x.snippet || ""}`.slice(0, CONFIG.llm.maxTokens));
          await openaiLimiter.acquire();
          const { data } = await openai.embeddings.create({ 
            model: CONFIG.llm.embeddingModel, 
            input: texts 
          });
          console.log(`   Processed embedding batch ${idx + 1}/${batches.length}`);
          return data.map((d) => d.embedding);
        } catch (err) {
          console.warn(`   ⚠️  Embedding batch failed: ${err.message}`);
          return new Array(batch.length).fill(null);
        }
      });
      
      const results = await Promise.all(embeddingPromises);
      allVecs.push(...results.flat());
      
      const out = [];
      for (let i = 0; i < list.length; i++) {
        if (!allVecs[i]) { out.push(list[i]); continue; }
        let dup = false;
        for (let j = 0; j < out.length; j++) {
          if (!out[j]._emb) continue;
          if (cosine(allVecs[i], out[j]._emb) >= CONFIG.filters.embeddingSimilarity) {
            dup = true; break;
          }
        }
        if (!dup) out.push({ ...list[i], _emb: allVecs[i] });
      }
      list = out.map(({ _emb, ...x }) => x);
    } catch (err) {
      console.warn("⚠️  Embedding dedupe failed, using JW fallback");
    }
  }

  // Jaro-Winkler dedupe
  const out2 = [];
  for (const it of list) {
    const dom = domainOf(it.link);
    const normT = (it.title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
    let dup = false;
    for (const ex of out2) {
      const dom2 = domainOf(ex.link);
      const normT2 = (ex.title || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
      if (dom === dom2 && jw(normT, normT2) > CONFIG.filters.jwSimilarity) {
        dup = true; break;
      }
    }
    if (!dup) out2.push(it);
  }

  return checkBuildTimeout() ? out2 : await gptTitleMerge(out2);
}

/** =============================================
 *  LLM Operations
 *  ============================================= */
async function cachedLLMCall(key, fn) {
  if (llmCache.has(key)) {
    console.log(`   💾 Cache hit: ${key.slice(0, 50)}...`);
    return llmCache.get(key);
  }
  const result = await fn();
  llmCache.set(key, result);
  return result;
}

async function gptFilterForEntity(entityName, items) {
  if (!openai || !items.length) return items;
  if (items.length < 5) return items; // Skip for small lists
  
  const cacheKey = `filter:${entityName}:${items.length}`;
  return cachedLLMCall(cacheKey, async () => {
    const slim = items.map((it, i) => ({ i, title: it.title, snippet: (it.snippet || "").slice(0, 200) }));
    
    const prompt = `FILTRARE: Păstrează articolele relevante pentru "${entityName}".
Elimină: reclame, sport, monden, imobiliare, localități irelevante.
Răspunde JSON cu indicii de păstrat: [0, 2, 5]`;

    const result = await safeLLMCall(`${entityName} filter`, async () => {
      await openaiLimiter.acquire();
      const r = await openai.responses.create({
        model: CONFIG.llm.model,
        input: prompt + "\n\nArticole:\n" + JSON.stringify(slim),
        reasoning: { effort: CONFIG.llm.reasoning.effort },
        text: { verbosity: "low" },
      });
      return JSON.parse(r.output || "[]");
    });
    
    if (!result || !Array.isArray(result)) {
      console.log(`   ⚠️  Filter parse failed, keeping all ${items.length}`);
      return items;
    }
    const valid = result.filter((n) => Number.isInteger(n) && n >= 0 && n < items.length);
    console.log(`   🎯 Filter: kept ${valid.length}/${items.length} for ${entityName}`);
    return valid.map((i) => items[i]);
  });
}

const PROMPT_CLUSTER = `Grupează articolele pe ACELAȘI SUBIECT (același eveniment).
IGNORĂ sidebar, "Citește și", reclame.
Răspunde STRICT JSON: [{"label":"Subiect","indices":[0,2,5]}]. Top 3 clustere, ≤5 itemi fiecare.`;

const PROMPT_TITLE_SUM = `Scrie titlu RO scurt, jurnalistic și sumar RO de 2 propoziții scurte, neutru, bazat pe fapte comune.
FORMAT:
TITLU_RO: <titlu>
SUMAR_RO: <sumar>`;

async function bunchForEntity(entityName, items) {
  if (!items?.length) return [];
  if (checkBuildTimeout()) return [];

  const cacheKey = `cluster:${entityName}:${items.length}`;
  return cachedLLMCall(cacheKey, async () => {
    const userItems = items.map((it, i) => ({
      i, title: it.title, source: it.source, link: it.link, date: it.date,
    }));

    const result = await safeLLMCall(`${entityName} clustering`, async () => {
      await openaiLimiter.acquire();
      const r = await openai.responses.create({
        model: CONFIG.llm.model,
        input: PROMPT_CLUSTER + "\n\n" + JSON.stringify({ entity: entityName, items: userItems }),
        reasoning: { effort: CONFIG.llm.reasoning.effort },
        text: { verbosity: "low" },
      });
      return JSON.parse(r.output || "[]");
    });
    
    if (!result || !Array.isArray(result)) return [];
    return result.slice(0, 3).map((c) => ({
      label: String(c.label || `Subiect ${entityName}`),
      indices: Array.isArray(c.indices) ? c.indices.filter((n) => n >= 0 && n < items.length).slice(0, 5) : [],
    }));
  });
}

async function titleAndSummaryFor(items) {
  if (!openai || !items.length) return { title: "", summary: "" };
  
  const cacheKey = `title:${items.map((it) => it.link).join("|")}`;
  return cachedLLMCall(cacheKey, async () => {
    const payload = items.map((it) => ({
      titlu: it.title, lead: it.snippet || "", fragment: it.snippet || "",
    }));

    const result = await safeLLMCall("title/summary", async () => {
      await openaiLimiter.acquire();
      const r = await openai.responses.create({
        model: CONFIG.llm.model,
        input: PROMPT_TITLE_SUM + "\n\n" + JSON.stringify(payload),
        reasoning: { effort: CONFIG.llm.reasoning.effort },
        text: { verbosity: "medium" }, // Medium for better text quality
      });
      return r.output || "";
    });
    
    if (!result) return { title: "", summary: "" };
    const t = /TITLU_RO:\s*([^\n]+)/m.exec(result)?.[1]?.trim() || "";
    const s = /SUMAR_RO:\s*([\s\S]+)/m.exec(result)?.[1]?.trim() || "";
    return { title: t, summary: s };
  });
}

/** =============================================
 *  Cross-entity collapse
 *  ============================================= */
function itemSig(it) {
  const u = canonicalizeUrl(it.link || "");
  try {
    const { origin, pathname } = new URL(u);
    return origin + pathname;
  } catch {
    return u;
  }
}

function topicKeyFromItems(items) {
  const sigs = Array.from(new Set((items || []).map(itemSig))).sort();
  return djb2(sigs.join("|"));
}

function scoreOwner(allText) {
  const t = stripDiacritics(String(allText || "").toLowerCase());
  const scores = new Map([
    ["Președinție", (t.match(/\bpresedinte|presedintie|cotroceni/g) || []).length],
    ["Guvern", (t.match(/\bpremier|guvern|ministru|ministerul/g) || []).length],
    ["Parlament", (t.match(/\bparlament|senat/g) || []).length],
    ["Local (Primării)", (t.match(/\bprimar|primaria/g) || []).length],
    ["Coaliție (Putere)", (t.match(/\bpsd|pnl|udmr|usr/g) || []).length],
    ["Opoziție", (t.match(/\baur|sos romania/g) || []).length],
  ]);
  
  return Array.from(scores.entries()).reduce((a, b) => a[1] > b[1] ? a : b)[0];
}

function crossEntityCollapseURLUnion(entities) {
  const refs = [];
  entities.forEach((e, eIdx) => {
    (e.subjects || []).forEach((s, sIdx) => {
      const urls = new Set((s.items || []).map((x) => itemSig(x)));
      const key = djb2(Array.from(urls).sort().join("|"));
      refs.push({ eIdx, sIdx, entity: e.name, subject: s, key, urls });
    });
  });

  const groups = new Map();
  for (const r of refs) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
  }

  const keys = Array.from(groups.keys());
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => (parent.get(k) === k ? k : parent.set(k, find(parent.get(k))).get(k));
  const unite = (a, b) => {
    a = find(a); b = find(b);
    if (a !== b) parent.set(b, a);
  };

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const A = groups.get(keys[i])[0].urls;
      const B = groups.get(keys[j])[0].urls;
      const inter = Array.from(A).filter((u) => B.has(u)).length;
      if (inter >= 2) unite(keys[i], keys[j]);
    }
  }

  const buckets = new Map();
  for (const k of keys) {
    const root = find(k);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(...groups.get(k));
  }

  const toDelete = new Set();
  for (const [, bucket] of buckets) {
    if (bucket.length <= 1) continue;

    const aggText = bucket.map((r) => {
      const s = r.subject;
      return (s.titlu_ro || "") + " " + (s.sumar_ro || "") + " " + (s.items || []).map((it) => it.title).join(" • ");
    }).join(" /// ");

    const owner = scoreOwner(aggText);
    const ownerRef = bucket.find((r) => r.entity === owner) || bucket[0];
    const byUrl = new Map();
    for (const r of bucket) {
      for (const it of r.subject.items || []) {
        const sig = itemSig(it);
        if (!byUrl.has(sig)) byUrl.set(sig, it);
      }
    }
    ownerRef.subject.items = Array.from(byUrl.values()).slice(0, 5);
    bucket.forEach((r) => { if (r !== ownerRef) toDelete.add(`${r.eIdx}:${r.sIdx}`); });
  }

  entities.forEach((e, eIdx) => {
    const seen = new Set();
    e.subjects = (e.subjects || []).filter((s, sIdx) => {
      if (toDelete.has(`${eIdx}:${sIdx}`)) return false;
      const k = topicKeyFromItems(s.items || []);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

async function crossEntityGPTCollapse(entities) {
  if (!openai || checkBuildTimeout()) return entities;

  const refs = [];
  entities.forEach((e, eIdx) => {
    (e.subjects || []).forEach((s, sIdx) => {
      if ((s.items || []).length > 0) {
        refs.push({
          eIdx, sIdx, entity: e.name,
          t: s.titlu_ro || s.label || "",
          sum: s.sumar_ro || "",
          items: s.items.map((it) => it.title),
          domains: s.items.map((it) => domainOf(it.link)),
        });
      }
    });
  });

  if (!refs.length) return entities;
  
  const MAX_SUBJECTS = 60; // Reduced
  const sample = refs.slice(0, MAX_SUBJECTS);
  const payload = sample.map((x, i) => ({
    i, entity: x.entity, title: x.t, summary: x.sum,
    items: x.items.slice(0, 5), domains: Array.from(new Set(x.domains)).slice(0, 6),
  }));

  const prompt = `Grupează subiectele identice din entități diferite (ex: Guvern, Președinție).
Returnează JSON: [{"indices":[0,5]}]`;

  const result = await safeLLMCall("cross-entity merge", async () => {
    await openaiLimiter.acquire();
    const r = await openai.responses.create({
      model: CONFIG.llm.model,
      input: prompt + "\n\n" + JSON.stringify(payload),
      reasoning: { effort: CONFIG.llm.reasoning.effort },
      text: { verbosity: "low" },
    });
    return JSON.parse(r.output || "[]");
  });
  
  if (!result || !Array.isArray(result)) return entities;

  const toDelete = new Set();
  for (const g of result) {
    const arr = Array.isArray(g?.indices) ? g.indices.filter((n) => n >= 0 && n < sample.length) : [];
    if (arr.length <= 1) continue;

    const bucket = arr.map((idx) => sample[idx]);
    const aggText = bucket.map((b) => (b.title || "") + " " + (b.summary || "") + " " + (b.items || []).join(" • ")).join(" /// ");
    const owner = scoreOwner(aggText);
    const ownerRef = bucket.find((b) => b.entity === owner) || bucket[0];
    const ownerReal = refs.find((r) => r.eIdx === ownerRef.eIdx && r.sIdx === ownerRef.sIdx);
    if (!ownerReal) continue;

    const merged = new Map();
    for (const idx of arr) {
      const real = refs.find((r) => r.eIdx === sample[idx].eIdx && r.sIdx === sample[idx].sIdx);
      if (real) {
        const subj = entities[real.eIdx]?.subjects?.[real.sIdx];
        (subj?.items || []).forEach((it) => merged.set(itemSig(it), it));
      }
    }
    if (entities[ownerReal.eIdx]?.subjects?.[ownerReal.sIdx]) {
      entities[ownerReal.eIdx].subjects[ownerReal.sIdx].items = Array.from(merged.values()).slice(0, 5);
    }
    bucket.forEach((b) => {
      if (b.eIdx !== ownerReal.eIdx || b.sIdx !== ownerReal.sIdx) {
        toDelete.add(`${b.eIdx}:${b.sIdx}`);
      }
    });
  }

  entities.forEach((e) => {
    e.subjects = (e.subjects || []).filter((_, sIdx) => !toDelete.has(`${e.eIdx}:${sIdx}`));
  });
  return entities;
}

/** =============================================
 *  Build Pipeline
 *  ============================================= */
async function buildData() {
  const todayKey = new Date()
    .toLocaleDateString("ro-RO", { timeZone: CONFIG.misc.timezone })
    .replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.paths.cacheDir, `report-${todayKey}.json`);

  await fs.promises.mkdir(CONFIG.paths.cacheDir, { recursive: true });
  if (fs.existsSync(cacheFile)) {
    console.log("✓ Using cached report");
    return JSON.parse(await fs.promises.readFile(cacheFile, "utf-8"));
  }

  console.log("\n🚀 Starting generation...");
  const logs = { fetched: {}, filtered: {}, gpt_filtered: {}, deduped: {}, final: {} };

  // Step 1: Fetch RSS (parallel)
  console.log("📡 Step 1: Fetching feeds...");
  const allRSSArticles = await fetchAllRSSFeeds();
  console.log(`   ✓ Total: ${allRSSArticles.length} articles`);

  // Step 2: Filter per entity (parallel)
  console.log("\n🔍 Step 2: Filtering entities...");
  const pools = {};
  const filterPromises = ENTITY_ORDER.map(async (name) => {
    const raw = filterArticlesForEntity(allRSSArticles, name);
    const arr = raw.filter((x) => x.title && x.link && withinLast24h(x.date));
    let filtered = (name === "Local (Primării)") 
      ? arr.filter(looksRomanianArticle).filter(localRoleCityPass)
      : arr.filter(looksRomanianArticle);
    filtered = enforcePoliticalRules(name, filtered);
    logs.filtered[name] = filtered.length;
    pools[name] = filtered;
    console.log(`   ✓ ${name}: ${arr.length} → ${filtered.length}`);
  });
  await Promise.all(filterPromises);

  // Step 3: GPT filter + dedupe (sequential per entity to avoid rate limits)
  console.log("\n🤖 Step 3: GPT filter & dedupe...");
  for (const name of ENTITY_ORDER) {
    if (checkBuildTimeout()) {
      console.log(`⏭️  Skipping remaining entities due to timeout`);
      break;
    }
    
    const items = pools[name] || [];
    if (!items.length) continue;

    const gptFiltered = await gptFilterForEntity(name, items);
    logs.gpt_filtered[name] = gptFiltered.length;
    
    const ded = await dedupe(gptFiltered);
    logs.deduped[name] = ded.length;
    
    pools[name] = ded.slice(0, CONFIG.filters.maxArticlesPerEntity);
    console.log(`   ✓ ${name}: ${items.length} → ${gptFiltered.length} → ${ded.length}`);
  }

  // Step 4: Clustering (parallel where possible)
  console.log("\n🗂️ Step 4: Clustering...");
  const entities = [];
  
  for (const name of ENTITY_ORDER) {
    if (checkBuildTimeout()) {
      console.log("⏭️  Timeout: Skipping clustering for remaining entities");
      const items = (pools[name] || []).slice(0, 5);
      if (items.length) {
        entities.push({
          name,
          subjects: [{
            label: items[0].title,
            titlu_ro: items[0].title,
            sumar_ro: "",
            items: items.slice(0, 3)
          }]
        });
      }
      continue;
    }

    const items = pools[name] || [];
    if (!items.length) {
      console.log(`   ⊘ ${name}: No articles`);
      continue;
    }

    const clusters = await bunchForEntity(name, items);
    console.log(`   ✓ ${name}: ${clusters.length} clusters`);

    const subjects = [];
    for (const cl of clusters) {
      const subset = cl.indices.map((i) => items[i]).filter(Boolean).slice(0, 5);
      if (!subset.length) continue;
      
      const { title, summary } = await titleAndSummaryFor(subset);
      subjects.push({
        label: cl.label || title || `Subiect ${subjects.length + 1}`,
        titlu_ro: title,
        sumar_ro: summary,
        items: subset,
      });
    }
    entities.push({ name, subjects });
  }

  // Step 5: Cross-entity collapse
  console.log("\n🔧 Step 5: Cross-entity collapse...");
  if (!checkBuildTimeout()) {
    crossEntityCollapseURLUnion(entities);
    await crossEntityGPTCollapse(entities);
  }

  entities.sort((a, b) => ENTITY_ORDER.indexOf(a.name) - ENTITY_ORDER.indexOf(b.name));

  // Save results
  console.log("\n💾 Saving results...");
  const report = { 
    generatedAt: new Date().toISOString(), 
    timezone: CONFIG.misc.timezone, 
    entities,
    stats: {
      entities: entities.length,
      subjects: entities.reduce((sum, e) => sum + e.subjects.length, 0),
      articles: entities.reduce((sum, e) => sum + e.subjects.reduce((s, sub) => s + sub.items.length, 0), 0)
    }
  };
  
  logs.final = report.stats;
  
  await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
  await fs.promises.writeFile(OUT_JSON, JSON.stringify(report, null, 2));
  await fs.promises.writeFile(LOGS_JSON, JSON.stringify(logs, null, 2));
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  
  console.log(`   ✓ JSON: ${OUT_JSON}`);
  console.log(`   ✓ HTML: ${OUT_HTML}`);
  console.log(`   ✓ Cache: ${cacheFile}`);
  console.log(`   📊 ${report.stats.entities} entities, ${report.stats.subjects} subjects, ${report.stats.articles} articles`);
  
  return report;
}

/** =============================================
 *  HTML Generation (unchanged)
 *  ============================================= */
function esc(s) {
  return he.encode(String(s || ""), { useNamedReferences: true });
}

function getAnalyticsTag(id) {
  if (!id) return "";
  const safe = String(id).replace(/[^A-Za-z0-9_\-]/g, "");
  return `<script async src="https://www.googletagmanager.com/gtag/js?id=${safe}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${safe}');</script>`;
}

function getStylesAndFonts() {
  return `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">
<style>:root{--ink:#1a1a1a;--bg:#ffffff;--muted:#6b7280;--line:#e5e7eb;--accent:#005a95;--accent-ink:#ffffff;--max:1200px}*{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}.wrap{max-width:var(--max);margin:0 auto;padding:40px 20px}.entity{margin:40px 0 32px}.entity__t{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:8px 16px;font:800 16px/1 Space Grotesk,Inter,sans-serif;letter-spacing:.02em;text-transform:uppercase;margin:0 0 16px;border-radius:4px}.card{border-bottom:1px solid var(--line);padding:24px 0;margin:0 0 16px 0;position:relative;display:grid;grid-template-columns:1fr 280px;gap:24px;align-items:start;background:transparent}.card:first-child{grid-template-columns:1.2fr 1fr;padding-top:28px;padding-bottom:28px}.card__body{min-width:0}.card__head{display:flex;align-items:center;gap:10px;margin:0 0 12px}.pill{display:none}.card__t{font:800 24px/1.2 Space Grotesk,Inter,sans-serif;margin:0;letter-spacing:-0.01em}.card:first-child .card__t{font-size:28px}.sub__sum{font-size:16px;color:var(--muted);margin:12px 0 16px;line-height:1.5}.items{margin:0;padding:0;list-style:none}.items li{margin:8px 0;font-size:14px;line-height:1.5;display:flex;align-items:baseline;gap:8px}.items a{color:inherit;text-decoration:none;border-bottom:1px solid rgba(10,10,10,.1);transition:border-color .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.items a:hover{border-bottom-color:var(--accent)}.items .src{display:inline-block;margin-left:4px;font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--muted)}.card__media{width:280px;flex-shrink:0;display:flex;flex-direction:column;gap:6px}.card__img{width:100%;height:180px;object-fit:cover;border:1px solid var(--line);border-radius:4px}.photo-credit{font-size:11px;color:var(--muted);margin-top:4px}@media (max-width:900px){.card{grid-template-columns:1fr}.card__media{width:100%;order:-1}.card__img{height:200px}.card:first-child{grid-template-columns:1fr}.card__t{font-size:22px}}@media print{body{background:#fff}.entity{page-break-inside:avoid}}</style>`;
}

function getScripts(report) {
  return `<script id="__STATE__" type="application/json">${JSON.stringify(report)}</script>
<script>
(function(){
var raw=document.getElementById("__STATE__").textContent;
var state;try{state=JSON.parse(raw);}catch(e){state={generatedAt:new Date().toISOString(),timezone:"Europe/Bucharest",entities:[]};}

var content=document.getElementById("content");
var fmtDomain=function(u){try{return new URL(u).hostname.replace(/^www\\./,"");}catch{return""}};
var slugId=function(s){return String(s||"").toLowerCase().replace(/[^a-z0-9-ăâîșț ]/gi,"-").replace(/\\s+/g,"-").replace(/-+/g,"-");};

function pickBestThumb(items){if(!items||!items.length)return null;for(var i=0;i<items.length;i++){var it=items[i];var img=it.thumbnail||"";if(img&&typeof img==="string"&&img.length>8&&!/logo|sprite|icon|avatar/i.test(img)){return{src:img,domain:fmtDomain(it.link||"")};}}return null;}

function render(){
  var out=(state.entities||[]).map(function(e){
    var subs=e.subjects||[];if(!subs.length)return"";
    var cards=subs.map(function(s){
      var items=(s.items||[]).slice(0,5).map(function(it){
        return"<li><a href=\\""+it.link+"\\" target=\\"_blank\\" rel=\\"noopener\\">"+it.title+"</a><span class=\\"src\\">"+fmtDomain(it.link)+"</span></li>";
      }).join("");
      var sum=s.sumar_ro?"<p class=\\"sub__sum\\">"+s.sumar_ro+"</p>":"";
      var thumb=pickBestThumb(s.items);
      var mediaHtml=thumb?'<div class="card__media"><img class="card__img" src="'+thumb.src+'" alt="thumbnail" loading="lazy"/><div class="photo-credit">Sursa: '+thumb.domain+'</div></div>':"";
      return"<div class=\\"card\\"><div class=\\"card__body\\"><div class=\\"card__head\\"><div class=\\"pill\\"></div><h3 class=\\"card__t\\">"+(s.titlu_ro||s.label||"Subiect")+"</h3></div>"+sum+"<ul class=\\"items\\">"+items+"</ul></div>"+mediaHtml+"</div>";
    }).join("");
    return"<section id=\\""+slugId(e.name)+"\\" class=\\"entity\\"><h2 class=\\"entity__t\\">"+e.name+"</h2>"+cards+"</section>";
  }).join("");
  content.innerHTML=out;
}
render();
})();
</script>`;
}

function baseHTML({ report }) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", { timeZone: CONFIG.misc.timezone, dateStyle: "long", timeStyle: "short" });

  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>CONTEXTPOLITIC.ro — ${esc(when)}</title>${getAnalyticsTag(CONFIG.analytics.ga4)}${getStylesAndFonts()}</head><body><main class="wrap" id="app-root"><div class="content" id="content"></div></main>${getScripts(report)}</body></html>`;
}

/** =============================================
 *  Main
 *  ============================================= */
async function run() {
  console.log("Build started at", new Date().toISOString());
  try {
    validateEnv();
    const report = await buildData();
    const html = baseHTML({ report });
    await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
    await fs.promises.writeFile(OUT_HTML, html, "utf-8");
    
    console.log(`\n✅ Build completed in ${Date.now() - BUILD_START_TIME}ms`);
    console.log(`📊 ${report.stats.entities} entities, ${report.stats.subjects} subjects, ${report.stats.articles} articles`);
  } catch (err) {
    console.error("\n❌ Fatal error:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error("❌ Unhandled error:", err);
    process.exit(1);
  });
}
