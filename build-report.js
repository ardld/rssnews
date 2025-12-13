import fs from "fs";
import path from "path";
import OpenAI from "openai";
import he from "he";
import Parser from "rss-parser";

/** Configuration */
const CONFIG = {
  openaiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
  model: "gpt-4.1", // Ensure you use a valid model ID (e.g. gpt-4, gpt-4-turbo, gpt-4o)
  outDir: path.join(process.cwd(), "public"),
  cacheDir: path.join(process.cwd(), ".cache"),
  timezone: "Europe/Bucharest",
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
    "https://romania.europalibera.org/api/zvo_mml-vomx_-tpeukvm_",
    "https://adevarul.ro/rss/index",
  ],
  sourceCredibility: {
    "recorder.ro": 1.0,
    "pressone.ro": 1.0,
    "g4media.ro": 0.9,
    "hotnews.ro": 0.9,
    "adevarul.ro": 0.8,
    "digi24.ro": 0.8,
    "libertatea.ro": 0.7,
    "spotmedia.ro": 0.8,
    "biziday.ro": 0.7,
    "b365.ro": 0.6,
    "europalibera.org": 0.9,
  },
};

const openai = new OpenAI({ apiKey: CONFIG.openaiKey });
const parser = new Parser();

/** Entity definitions */
const ENTITIES = [
  "Președinție",
  "Guvern",
  "Parlament",
  "Coaliție (Putere)",
  "Opoziție",
  "Local (Primării)",
];

const QUERIES = {
  "Președinție": [
    "Nicușor Dan", "Nicusor Dan", "Administrația Prezidențială", "Administratia Prezidentiala"
  ],
  "Guvern": [
    "Guvernul României", "Guvernul Romaniei", "Premierul României", "Premierul Romaniei",
    "prim-ministru", "ministerul", "ministrul", "ministra", "guvernul", "Bolojan",
  ],
  "Parlament": [
    "Parlamentul României", "Parlamentul Romaniei", "Camera Deputaților", "Senatul",
    "deputatul", "senatorul", "senatoarea", "deputații", "senatorii", "votul din plen",
  ],
  "Coaliție (Putere)": [
    "PSD", "Partidul Social Democrat", "PNL", "Partidul Național Liberal",
    "UDMR", "USR", "Uniunea Salvați România"
  ],
  "Opoziție": [
    "AUR", "George Simion", "SOS România", "Diana Șoșoacă", "Partidul Oamenilor Tineri", "Anamaria Gavrilă"
  ],
  "Local (Primării)": [
    "primar", "primăria", "primaria", "primarul"
  ],
};

/** Helper functions */
const canonicalizeUrl = (url) => {
  try {
    const u = new URL(url);
    u.hash = "";
    ["utm_", "gclid", "fbclid"].forEach(p => {
      Array.from(u.searchParams.keys()).forEach(k => {
        if (k.toLowerCase().startsWith(p)) u.searchParams.delete(k);
      });
    });
    return u.toString();
  } catch {
    return url;
  }
};

const domainOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const withinLast24h = (dateStr) => {
  if (!dateStr) return true;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return true;
  return Date.now() - d.getTime() <= 24 * 60 * 60 * 1000;
};

/** String Similarity for Deduplication */
function getJaccardSimilarity(str1, str2) {
  const set1 = new Set(str1.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  const set2 = new Set(str2.toLowerCase().split(/\s+/).filter(w => w.length > 3));
  
  if (set1.size === 0 || set2.size === 0) return 0;
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/** Fetch RSS feeds */
async function fetchRSS() {
  console.log("📡 Fetching RSS feeds...");
  const articles = [];
  
  for (const feedUrl of CONFIG.feeds) {
    try {
      const feed = await parser.parseURL(feedUrl);
      feed.items.forEach(item => {
        articles.push({
          title: item.title || "",
          link: canonicalizeUrl(item.link || ""),
          source: item.creator || feed.title || domainOf(feedUrl),
          date: item.pubDate || item.isoDate || "",
          snippet: item.contentSnippet || item.content || "",
          thumbnail: item.enclosure?.url || "",
        });
      });
      console.log(`  ✓ ${feed.title}: ${feed.items.length} articles`);
    } catch (err) {
      console.error(`  ⚠️  Failed: ${feedUrl}`);
    }
  }
  
  const enriched = await Promise.all(articles.map(enrichArticle));
  const withViral = calculateViralScores(enriched);
  
  return withViral.filter(a => {
    if (a.hasDisinfo && a.credibility < 0.9) {
      return false;
    }
    return true;
  });
}

function getCredibilityScore(article) {
  const domain = domainOf(article.link);
  return CONFIG.sourceCredibility[domain] || 0.5;
}

const DISINFO_SIGNALS = [
  "fake news", "mainstream media", "globaliști", "globalisti",
  "deep state", "elita", "tradatori", "trădători",
  "soroș", "soros", "bill gates", "klaus schwab",
  "masonii", "mason", "iluminati", "illuminati",
  "dacii", "daci liberi", "imperiu colonial",
  "schengen e o conspirație", "ne vând țara",
];

function hasDisinfoSignals(text) {
  const lower = text.toLowerCase();
  return DISINFO_SIGNALS.some(sig => lower.includes(sig));
}

async function enrichArticle(article) {
  const credibility = getCredibilityScore(article);
  const hasDisinfo = hasDisinfoSignals(`${article.title} ${article.snippet}`);
  return { ...article, credibility, hasDisinfo };
}

function calculateViralScores(articles) {
  const storyGroups = new Map();
  
  articles.forEach(article => {
    const words = article.title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const key = words.slice(0, 3).sort().join('_');
    if (!storyGroups.has(key)) storyGroups.set(key, []);
    storyGroups.get(key).push(article);
  });
  
  articles.forEach(article => {
    const words = article.title.toLowerCase().split(/\s+/).filter(w => w.length > 4);
    const key = words.slice(0, 3).sort().join('_');
    const group = storyGroups.get(key) || [];
    const uniqueSources = new Set(group.map(a => domainOf(a.link))).size;
    
    article.viralScore = uniqueSources;
    article.isViral = uniqueSources >= 3;
  });
  return articles;
}

const ROMANIA_SIGNALS = [
  "românia", "romania", "românesc", "romanesc", "bucuresti", "bucurești",
  "cluj", "timișoara", "timisoara", "iași", "iasi", "constanța", "constanta",
  "brașov", "brasov", "sibiu", "craiova", "galați", "galati", "ploiești", "ploiesti"
];

const IRRELEVANT_SIGNALS = [
  "budapesta", "budapest", "ungaria", "maghiar", "orban",
  "venezuela", "machado", "oslo", "veneția", "rialto",
  "tezaur", "colosseum mall", "inaugurare", "oferte speciale",
  "edituri", "manuale", "academiei române", "ioan-aurel pop"
];

function isAboutRomania(article) {
  const text = `${article.title} ${article.snippet}`.toLowerCase();
  if (IRRELEVANT_SIGNALS.some(sig => text.includes(sig))) return false;
  return ROMANIA_SIGNALS.some(sig => text.includes(sig));
}

function filterByKeywords(articles, entityName) {
  const keywords = QUERIES[entityName] || [];
  return articles
    .filter(isAboutRomania)
    .filter(article => {
      const text = `${article.title} ${article.snippet}`.toLowerCase();
      return keywords.some(kw => text.includes(kw.toLowerCase()));
    });
}

function deduplicateByUrl(articles) {
  const seen = new Map();
  articles.forEach(article => {
    const url = canonicalizeUrl(article.link);
    if (!seen.has(url)) seen.set(url, article);
  });
  return Array.from(seen.values());
}

async function clusterArticles(entityName, articles) {
  if (!articles.length) return [];
  
  const payload = articles.slice(0, 50).map((a, i) => ({
    i,
    title: a.title,
    source: a.source,
  }));
  
  const prompt = `Grupează aceste articole românești în maximum 3 subiecte principale (topic-uri).
Pentru fiecare subiect, selectează până la 5 articole relevante.
Returnează JSON strict în acest format:
[
  {"label": "Titlu subiect 1", "indices": [0, 3, 5]},
  {"label": "Titlu subiect 2", "indices": [1, 4, 7]}
]
Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Răspunde DOAR cu JSON valid." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    const content = response.choices[0].message.content.trim();
    const clusters = JSON.parse(content);
    return Array.isArray(clusters) ? clusters.slice(0, 3) : [];
  } catch (err) {
    console.error(`  ⚠️  Clustering failed for ${entityName}:`, err.message);
    return [];
  }
}

async function generateTitleSummary(articles) {
  if (!articles.length) return { title: "", summary: "", context: "", sentiment: "neutral" };
  const sorted = articles.sort((a, b) => (b.credibility || 0.5) - (a.credibility || 0.5));
  
  const payload = sorted.map(a => ({
    title: a.title,
    snippet: a.snippet.slice(0, 200),
    source: a.source,
    credibility: a.credibility,
  }));
  
  const prompt = `Analizează aceste articole românești și creează:
1. TITLU: Un titlu scurt și jurnalistic (maxim 12 cuvinte)
2. SUMAR: Un sumar obiectiv de maxim 2 propoziții
3. CONTEXT: O propoziție de context dacă e necesar (de ex: "Vine după..." sau "În contextul...")
4. SENTIMENT: Tonul general (pozitiv/negativ/neutru/controversat)
5. VERIFICARE: Notează dacă există afirmații neconfirmate sau contradictorii între surse

Format răspuns:
TITLU: <titlu>
SUMAR: <sumar>
CONTEXT: <context sau "N/A">
SENTIMENT: <pozitiv|negativ|neutru|controversat>
VERIFICARE: <"Confirmat de multiple surse" sau "Necesită verificare: [motiv]">

Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Răspunde în limba română, obiectiv și precis." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    const title = content.match(/TITLU:\s*(.+)/)?.[1]?.trim() || "";
    const summary = content.match(/SUMAR:\s*(.+)/)?.[1]?.trim() || "";
    const context = content.match(/CONTEXT:\s*(.+)/)?.[1]?.trim() || "";
    const sentiment = content.match(/SENTIMENT:\s*(\w+)/)?.[1]?.trim() || "neutral";
    const verification = content.match(/VERIFICARE:\s*(.+)/)?.[1]?.trim() || "";
    
    return { title, summary, context: context === "N/A" ? "" : context, sentiment, verification };
  } catch (err) {
    return { title: "", summary: "", context: "", sentiment: "neutral", verification: "" };
  }
}

async function classifyAndDeduplicate(entitiesData) {
  console.log("\n🔍 Classifying and deduplicating across entities...");
  const allArticles = [];
  entitiesData.forEach(entity => {
    entity.articles.forEach(article => {
      allArticles.push({
        ...article,
        currentEntity: entity.name,
        id: canonicalizeUrl(article.link),
      });
    });
  });
  
  const uniqueArticles = new Map();
  allArticles.forEach(article => {
    if (!uniqueArticles.has(article.id)) uniqueArticles.set(article.id, article);
  });
  const articles = Array.from(uniqueArticles.values());
  if (articles.length === 0) return entitiesData;
  
  const batches = [];
  const BATCH_SIZE = 40;
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }
  
  const classifications = new Map();
  for (const batch of batches) {
    const payload = batch.map((a, i) => ({
      i, title: a.title, snippet: a.snippet.slice(0, 200), currentEntity: a.currentEntity,
    }));
    
    const prompt = `Clasifică aceste articole în:
1. "Opoziție" (AUR, SOS, George Simion, Diana Șoșoacă)
2. "Guvern" (ministere, justiție, spitale, instituții centrale)
3. "Parlament" (legi, voturi plen, senat, camera)
4. "Coaliție (Putere)" (PSD, PNL, USR, UDMR)
5. "Președinție" (Cotroceni, Nicușor Dan)
6. "Local (Primării)" (primari, consilii locale)
7. "EXCLUDE" (externe, meteo, sport, monden)

Răspunde JSON: [{"i": 0, "entity": "Guvern"}]
Articole:
${JSON.stringify(payload, null, 2)}`;

    try {
      const response = await openai.chat.completions.create({
        model: CONFIG.model,
        messages: [{ role: "system", content: "JSON only." }, { role: "user", content: prompt }],
        temperature: 0.2,
      });
      const results = JSON.parse(response.choices[0].message.content.trim());
      if (Array.isArray(results)) {
        results.forEach(result => {
          const article = batch[result.i];
          if (article && result.entity !== "EXCLUDE") classifications.set(article.id, result.entity);
        });
      }
    } catch (err) {
      batch.forEach(article => classifications.set(article.id, article.currentEntity));
    }
  }
  
  const newEntitiesData = ENTITIES.map(name => ({ name, articles: [] }));
  articles.forEach(article => {
    const assignedEntity = classifications.get(article.id);
    if (assignedEntity) {
      const entity = newEntitiesData.find(e => e.name === assignedEntity);
      if (entity) entity.articles.push(article);
    }
  });
  return newEntitiesData;
}

function pickBestThumbnail(items) {
  for (const item of items) {
    if (item.thumbnail && item.thumbnail.length > 10 && 
        !/logo|sprite|icon|avatar|default/i.test(item.thumbnail)) {
      return item.thumbnail;
    }
  }
  return null;
}

/** Collect "Alte știri de interes" with DEDUPLICATION */
async function collectOtherNews(allArticles, usedArticleIds) {
  console.log("\n📰 Collecting other interesting news...");
  
  // 1. Initial filter: unused, recent, decent credibility
  const unused = allArticles.filter(a => !usedArticleIds.has(canonicalizeUrl(a.link)));
  const candidates = unused
    .filter(a => withinLast24h(a.date))
    .filter(a => (a.credibility || 0.5) >= 0.7)
    .filter(a => a.isViral || (a.viralScore || 1) >= 2);
  
  if (candidates.length === 0) return [];
  
  // 2. Sort by impact
  candidates.sort((a, b) => {
    const scoreA = (a.viralScore || 1) * (a.credibility || 0.5);
    const scoreB = (b.viralScore || 1) * (b.credibility || 0.5);
    return scoreB - scoreA;
  });
  
  // 3. Selection with Similarity Check to avoid duplicate topics
  const selectedArticles = [];
  const selectedTitles = [];

  for (const candidate of candidates) {
    if (selectedArticles.length >= 10) break;

    // Check similarity against already selected "other news"
    const isDuplicate = selectedTitles.some(t => getJaccardSimilarity(t, candidate.title) > 0.4); // 0.4 threshold implies significant overlap

    if (!isDuplicate) {
      selectedArticles.push(candidate);
      selectedTitles.push(candidate.title);
    }
  }
  
  console.log(`  → Found ${selectedArticles.length} other interesting news items (deduplicated)`);
  
  return selectedArticles.map(a => ({
    title: a.title,
    link: a.link,
    source: a.source,
    thumbnail: a.thumbnail,
    viralScore: a.viralScore || 1,
  }));
}

async function buildReport() {
  console.log("\n🚀 Starting report generation...\n");
  const today = new Date().toLocaleDateString("ro-RO").replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.cacheDir, `report-${today}.json`);
  
  await fs.promises.mkdir(CONFIG.cacheDir, { recursive: true });
  if (fs.existsSync(cacheFile)) {
    console.log("✓ Using cached report");
    return JSON.parse(await fs.promises.readFile(cacheFile, "utf-8"));
  }
  
  const allArticles = await fetchRSS();
  const entitiesData = [];
  
  for (const entityName of ENTITIES) {
    let articles = filterByKeywords(allArticles, entityName);
    articles = articles.filter(a => withinLast24h(a.date));
    articles = deduplicateByUrl(articles);
    entitiesData.push({ name: entityName, articles });
  }
  
  const classifiedData = await classifyAndDeduplicate(entitiesData);
  const usedArticleIds = new Set();
  const entities = [];
  
  for (const entityData of classifiedData) {
    if (!entityData.articles.length) continue;
    const clusters = await clusterArticles(entityData.name, entityData.articles);
    const subjects = [];
    
    for (const cluster of clusters) {
      const items = cluster.indices.map(i => entityData.articles[i]).filter(Boolean).slice(0, 5);
      if (!items.length) continue;
      items.forEach(item => usedArticleIds.add(canonicalizeUrl(item.link)));
      
      const { title, summary, context, sentiment, verification } = await generateTitleSummary(items);
      const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
      const maxViralScore = Math.max(...items.map(it => it.viralScore || 1));
      
      subjects.push({
        label: cluster.label || title,
        titlu_ro: title,
        sumar_ro: summary,
        context_ro: context,
        sentiment,
        verification,
        items,
        thumbnail: pickBestThumbnail(items),
        sourceDiversity: uniqueSources,
        viralScore: maxViralScore,
        isViral: maxViralScore >= 3,
      });
    }
    
    subjects.sort((a, b) => {
      if (a.isViral !== b.isViral) return b.isViral - a.isViral;
      return b.sourceDiversity - a.sourceDiversity;
    });
    
    entities.push({ name: entityData.name, subjects });
  }
  
  const otherNews = await collectOtherNews(allArticles, usedArticleIds);
  
  const report = {
    generatedAt: new Date().toISOString(),
    timezone: CONFIG.timezone,
    entities,
    otherNews,
  };
  
  await fs.promises.mkdir(CONFIG.outDir, { recursive: true });
  await fs.promises.writeFile(path.join(CONFIG.outDir, "data.json"), JSON.stringify(report, null, 2));
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  return report;
}

/** Enhanced HTML generation */
function generateHTML(report) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", { timeZone: CONFIG.timezone, dateStyle: "long", timeStyle: "short" });
  
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CONTEXTPOLITIC.ro – ${he.encode(when)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
<style>
:root{
  --bg: #f8fafc;
  --surface: #ffffff;
  --ink: #1e293b;
  --ink-secondary: #475569;
  --ink-tertiary: #94a3b8;
  --accent: #0f172a;
  --border: #e2e8f0;
  --primary: #2563eb;
  --danger: #dc2626;
  --warning: #ca8a04;
  --success: #16a34a;
}
*{box-sizing:border-box}
body{
  margin:0;padding:0;
  font-family: 'Inter', sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.5;
}
a{color:inherit;text-decoration:none;transition:color 0.2s}
a:hover{color:var(--primary)}

.wrap{max-width:1100px;margin:0 auto;padding:40px 20px}

/* Header */
header{text-align:center;margin-bottom:60px;padding-bottom:20px;border-bottom:1px solid var(--border)}
h1{font-size:2rem;font-weight:900;letter-spacing:-0.05em;margin:0;color:var(--accent)}
.date{font-size:0.9rem;color:var(--ink-secondary);margin-top:8px;font-weight:500}

/* Entity Section */
.entity{margin-bottom:60px}
.entity-header{
  display:flex;align-items:center;gap:12px;margin-bottom:24px;
  border-bottom: 2px solid var(--accent);padding-bottom:8px;
}
.entity-title{
  font-size:1.25rem;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;margin:0;
}

/* Grid Layout */
.cards-grid{
  display:grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap:24px;
}

/* Card Style */
.card{
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:12px;
  overflow:hidden;
  display:flex;flex-direction:column;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  transition:transform 0.2s, box-shadow 0.2s;
}
.card:hover{transform:translateY(-2px);box-shadow:0 10px 15px -3px rgba(0,0,0,0.1)}

.card--viral{
  border: 1px solid var(--ink-secondary);
  box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
  grid-column: 1 / -1; /* Viral spans full width */
}
.card--viral .card-content{
  display:grid;
  grid-template-columns: 1fr 1.2fr;
  gap:32px;
}
@media(max-width: 768px){ .card--viral .card-content{ grid-template-columns: 1fr; } }

/* Thumbnail */
.thumb-container{
  position:relative;
  width:100%;
  aspect-ratio: 16/9;
  background:#f1f5f9;
  border-bottom:1px solid var(--border);
}
.card--viral .thumb-container{
  height:100%;
  border-bottom:none;
  border-right:1px solid var(--border);
}
@media(max-width: 768px){ .card--viral .thumb-container{ height:250px; border-right:none; border-bottom:1px solid var(--border); } }

.thumb{width:100%;height:100%;object-fit:cover;display:block}

/* Content */
.body{padding:20px;flex:1;display:flex;flex-direction:column}
.meta-top{display:flex;gap:8px;margin-bottom:12px;font-size:0.75rem;font-weight:700;text-transform:uppercase}
.badge{padding:4px 8px;border-radius:4px;letter-spacing:0.05em}
.badge-viral{background:var(--danger);color:white}
.badge-sources{background:#e0f2fe;color:#0369a1}
.badge-sentiment{background:#f1f5f9;color:var(--ink-secondary)}

h3{
  font-family:'Merriweather', serif;
  font-size:1.1rem;
  font-weight:700;
  line-height:1.4;
  margin:0 0 12px;
}
.card--viral h3{font-size:1.5rem}

.context{font-size:0.8rem;color:var(--ink-tertiary);font-style:italic;margin-bottom:8px}
.summary{font-size:0.9rem;color:var(--ink-secondary);margin-bottom:16px;line-height:1.6}

/* Links List */
.links{list-style:none;padding:0;margin:auto 0 0;border-top:1px solid var(--border);padding-top:12px}
.links li{margin-bottom:6px;font-size:0.85rem;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.links a{font-weight:500;color:var(--ink);overflow: hidden; text-overflow: ellipsis; white-space: nowrap;}
.links span{font-size:0.7rem;color:var(--ink-tertiary);white-space:nowrap}

/* Other News Section */
.other-news-section{margin-top:80px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px}
.other-news-title{font-size:1.25rem;font-weight:800;margin:0 0 24px;border-bottom:1px solid var(--border);padding-bottom:12px}
.other-list{display:grid;grid-template-columns:repeat(auto-fill, minmax(400px, 1fr));gap:20px}
.other-item{display:flex;gap:16px;align-items:start}
.other-thumb{width:80px;height:60px;border-radius:6px;object-fit:cover;background:#f1f5f9}
.other-content{flex:1}
.other-link{font-weight:600;font-size:0.95rem;display:block;margin-bottom:4px;line-height:1.4}
.other-source{font-size:0.75rem;color:var(--ink-tertiary)}

@media(max-width: 600px){
  .cards-grid{grid-template-columns:1fr}
  .other-list{grid-template-columns:1fr}
}
</style>
</head>
<body>
<main class="wrap">
  <header>
    <h1>CONTEXTPOLITIC.ro</h1>
    <div class="date">${he.encode(when)}</div>
  </header>
  <div id="content"></div>
</main>
<script>
const data=${JSON.stringify(report)};
const content=document.getElementById("content");
const fmtDomain=u=>{try{return new URL(u).hostname.replace(/^www\\./,"")}catch{return""}};

// Render Entities
const entitiesHTML=data.entities.map(e=>{
  if(!e.subjects.length)return "";
  
  const cards=e.subjects.map(s=>{
    const isViral = s.isViral;
    const items = s.items.slice(0, isViral ? 5 : 3).map(it=>
      \`<li><a href="\${it.link}" target="_blank" title="\${it.title}">\${it.title}</a><span>\${fmtDomain(it.link)}</span></li>\`
    ).join("");
    
    const thumbSrc = s.thumbnail || "";
    const thumbHTML = thumbSrc ? \`<div class="thumb-container"><img src="\${thumbSrc}" class="thumb" loading="lazy" onerror="this.style.display='none'" /></div>\` : '';
    
    const viralBadge = s.isViral ? \`<span class="badge badge-viral">Subiect Viral</span>\` : '';
    const sentimentBadge = \`<span class="badge badge-sentiment">\${s.sentiment}</span>\`;
    const sourceBadge = \`<span class="badge badge-sources">\${s.sourceDiversity} surse</span>\`;
    
    const contextHTML = s.context_ro ? \`<div class="context">\${s.context_ro}</div>\` : '';
    
    // Viral layout vs Standard layout
    if(isViral && thumbSrc) {
       return \`
       <div class="card card--viral">
         <div class="card-content">
           \${thumbHTML}
           <div class="body">
             <div class="meta-top">\${viralBadge}\${sourceBadge}\${sentimentBadge}</div>
             <h3>\${s.titlu_ro}</h3>
             \${contextHTML}
             <div class="summary">\${s.sumar_ro}</div>
             <ul class="links">\${items}</ul>
           </div>
         </div>
       </div>\`;
    }

    return \`
    <div class="card">
      \${thumbSrc ? thumbHTML : ''}
      <div class="body">
        <div class="meta-top">\${viralBadge}\${sourceBadge}</div>
        <h3>\${s.titlu_ro}</h3>
        \${contextHTML}
        <div class="summary">\${s.sumar_ro}</div>
        <ul class="links">\${items}</ul>
      </div>
    </div>\`;
  }).join("");

  return \`
    <section class="entity">
      <div class="entity-header"><h2 class="entity-title">\${e.name}</h2></div>
      <div class="cards-grid">\${cards}</div>
    </section>
  \`;
}).join("");

// Render Other News
const otherNewsHTML = data.otherNews && data.otherNews.length ? \`
  <section class="other-news-section">
    <h2 class="other-news-title">Alte Știri de Interes</h2>
    <div class="other-list">
      \${data.otherNews.map(item => \`
        <div class="other-item">
          \${item.thumbnail ? \`<img src="\${item.thumbnail}" class="other-thumb" loading="lazy" />\` : ''}
          <div class="other-content">
            <a href="\${item.link}" target="_blank" class="other-link">\${item.title}</a>
            <div class="other-source">\${fmtDomain(item.link)}</div>
          </div>
        </div>
      \`).join('')}
    </div>
  </section>
\` : "";

content.innerHTML = entitiesHTML + otherNewsHTML;
</script>
</body>
</html>`;
}

/** Main execution */
async function main() {
  if (!CONFIG.openaiKey) {
    console.error("❌ OPENAI_API_KEY required");
    process.exit(1);
  }
  
  const report = await buildReport();
  const html = generateHTML(report);
  
  await fs.promises.writeFile(path.join(CONFIG.outDir, "index.html"), html, "utf-8");
  
  console.log(`✅ HTML saved to ${path.join(CONFIG.outDir, "index.html")}`);
  console.log(`📊 Statistics:`);
  console.log(`   - Entities: ${report.entities.length}`);
  console.log(`   - Other News: ${report.otherNews?.length || 0}`);
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
