import fs from "fs";
import path from "path";
import OpenAI from "openai";
import he from "he";
import Parser from "rss-parser";

/** Configuration */
const CONFIG = {
  openaiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
  model: "gpt-4-turbo", // Recomandat pentru precizie mai mare
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
  "Președinție": ["Nicușor Dan", "Administrația Prezidențială", "Iohannis", "Cotroceni", "Lasconi", "Geoana"],
  "Guvern": ["Guvernul", "Premierul", "Ciolacu", "Ministrul", "Ministerul", "Bolojan", "Minesterul", "OUG"],
  "Parlament": ["Parlamentul", "Camera Deputaților", "Senatul", "Senator", "Deputat", "Plen", "Legislativ"],
  "Coaliție (Putere)": ["PSD", "PNL", "UDMR", "USR", "Coalitia", "Ciuca"],
  "Opoziție": ["AUR", "Simion", "SOS România", "Șoșoacă", "Sosoaca", "Partidul POT", "Georgescu"],
  "Local (Primării)": ["primar", "primăria", "consiliul local", "București", "Cluj", "locală"],
};

/** STOP WORDS ROMANIAN (pentru curățarea titlurilor înainte de comparare) */
const STOP_WORDS = new Set([
  "de", "la", "si", "și", "in", "în", "cu", "o", "un", "mai", "pentru", "pe", "nu", "sa", "să", "din",
  "ale", "lui", "al", "ai", "fost", "este", "sunt", "au", "fi", "ca", "că", "ce", "cine", "cand", "când",
  "cum", "unde", "care", "doar", "tot", "toti", "toți", "dupa", "după", "prin", "peste", "sub", "fara", "fără"
]);

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

/** Jaccard Similarity Logic for Grouping */
function getTokens(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\săîâșț]/g, "") // remove punctuation
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function calculateSimilarity(str1, str2) {
  const set1 = new Set(getTokens(str1));
  const set2 = new Set(getTokens(str2));
  
  if (set1.size === 0 || set2.size === 0) return 0;
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/** Group articles by Topic Similarity */
function clusterBySimilarity(articles) {
  const clusters = []; // Array of arrays of articles

  // Sort by length desc (longer titles usually have more info to match against)
  const sortedArticles = [...articles].sort((a, b) => b.title.length - a.title.length);

  for (const article of sortedArticles) {
    let bestClusterIndex = -1;
    let bestSimilarity = 0;

    // Try to find a matching cluster
    for (let i = 0; i < clusters.length; i++) {
      // Check similarity against the first (representative) article of the cluster
      // Or check against all and take average/max. Max is safer for chain-linking.
      const cluster = clusters[i];
      
      // We check against the first article in the cluster (the seed)
      const sim = calculateSimilarity(article.title, cluster[0].title);
      
      if (sim > bestSimilarity) {
        bestSimilarity = sim;
        bestClusterIndex = i;
      }
    }

    // Threshold: 0.25 (approx 1 in 4 meaningful words match)
    // E.g. "Ciucu primar bucuresti" vs "Ciprian Ciucu castiga primaria" -> Overlap: Ciucu, primar/primaria -> High match
    if (bestSimilarity >= 0.20 && bestClusterIndex !== -1) {
      clusters[bestClusterIndex].push(article);
    } else {
      // Create new cluster
      clusters.push([article]);
    }
  }

  return clusters;
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
  
  // Enrich and Filter Disinfo
  const enriched = articles.map(a => {
    const cred = CONFIG.sourceCredibility[domainOf(a.link)] || 0.5;
    return { ...a, credibility: cred };
  });

  return enriched;
}

const ROMANIA_SIGNALS = [
  "românia", "romania", "românesc", "romanesc", "bucuresti", "bucurești",
  "cluj", "timișoara", "timisoara", "iași", "iasi", "constanța", "constanta",
  "brașov", "brasov", "sibiu", "craiova", "galați", "galati", "ploiești", "ploiesti",
  "ciolacu", "ciucă", "iohannis", "simion", "sosoaca", "lasconi", "geoana", "bolojan"
];

const IRRELEVANT_SIGNALS = [
  "budapesta", "ungaria", "maghiar", "orban viktor",
  "venezuela", "machado", "oslo", "veneția", "rialto",
  "tezaur", "colosseum mall", "inaugurare", "oferte speciale",
  "edituri", "manuale", "academiei române", "ioan-aurel pop",
  "horoscop", "meteo", "sport", "fotbal", "simona halep"
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

/** GPT: Generate title, summary, and context based on a CLEAN cluster */
async function generateTitleSummary(articles) {
  if (!articles.length) return { title: "", summary: "", context: "", sentiment: "neutral" };
  
  // Sort by credibility so GPT sees trustworthy sources first
  const sorted = articles.sort((a, b) => (b.credibility || 0.5) - (a.credibility || 0.5));
  
  const payload = sorted.map(a => ({
    title: a.title,
    snippet: a.snippet.slice(0, 150),
    source: a.source,
  }));
  
  const prompt = `Analizează acest grup de articole (care sunt despre ACELAȘI subiect) și creează:
1. TITLU: Un titlu scurt, informativ, jurnalistic (max 10 cuvinte).
2. SUMAR: Un sumar obiectiv de max 25 cuvinte.
3. CONTEXT: O propoziție scurtă de context ("Vine după...", "În contextul..."). Dacă nu e clar, scrie "N/A".
4. SENTIMENT: <pozitiv|negativ|neutru|controversat>

Format răspuns strict:
TITLU: ...
SUMAR: ...
CONTEXT: ...
SENTIMENT: ...

Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Ești un editor de știri experimentat. Răspunde în română." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    const title = content.match(/TITLU:\s*(.+)/)?.[1]?.trim() || sorted[0].title;
    const summary = content.match(/SUMAR:\s*(.+)/)?.[1]?.trim() || "";
    const context = content.match(/CONTEXT:\s*(.+)/)?.[1]?.trim() || "";
    const sentiment = content.match(/SENTIMENT:\s*(\w+)/)?.[1]?.trim() || "neutral";
    
    return { 
      title, 
      summary, 
      context: context === "N/A" ? "" : context,
      sentiment
    };
  } catch (err) {
    console.error("  ⚠️  GPT Summary failed:", err.message);
    return { title: sorted[0].title, summary: "", context: "", sentiment: "neutral" };
  }
}

/** Pick best thumbnail */
function pickBestThumbnail(items) {
  for (const item of items) {
    if (item.thumbnail && item.thumbnail.length > 10 && 
        !/logo|sprite|icon|avatar|default/i.test(item.thumbnail)) {
      return item.thumbnail;
    }
  }
  return null;
}

/** Main Report Builder */
async function buildReport() {
  console.log("\n🚀 Starting report generation (Logic V2)...\n");
  
  // Setup cache
  const today = new Date().toLocaleDateString("ro-RO").replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.cacheDir, `report-v2-${today}.json`);
  
  await fs.promises.mkdir(CONFIG.cacheDir, { recursive: true });
  // Uncomment to use cache during dev:
  // if (fs.existsSync(cacheFile)) return JSON.parse(await fs.promises.readFile(cacheFile, "utf-8"));
  
  // 1. Fetch & Dedupe Global
  let allArticles = await fetchRSS();
  allArticles = allArticles.filter(a => withinLast24h(a.date));
  allArticles = deduplicateByUrl(allArticles);
  
  console.log(`✓ Fetched ${allArticles.length} recent articles.`);

  const usedUrls = new Set(); // To prevent same article in multiple entities/sections
  const entitiesOutput = [];

  // 2. Process Entities
  for (const entityName of ENTITIES) {
    console.log(`\n📂 Processing: ${entityName}`);
    
    // a. Filter strictly by keywords
    let entityArticles = filterByKeywords(allArticles, entityName);
    
    // b. Remove articles already used in previous entities (optional, but keeps things clean)
    // entityArticles = entityArticles.filter(a => !usedUrls.has(a.link));

    if (entityArticles.length === 0) continue;

    // c. CLUSTER BY SIMILARITY (The Fix)
    const rawClusters = clusterBySimilarity(entityArticles);
    console.log(`   → Found ${rawClusters.length} raw clusters (topics).`);

    const subjects = [];

    // d. Process each cluster
    for (const cluster of rawClusters) {
      // Filter trivial clusters (single articles from low credibility sources) unless viral
      const maxCred = Math.max(...cluster.map(c => c.credibility));
      
      // Keep cluster if: >1 article OR (1 article but high credibility > 0.8)
      if (cluster.length < 2 && maxCred < 0.8) continue; 

      // Take top 5 items per cluster
      const items = cluster.slice(0, 5);
      
      // Mark as used
      items.forEach(i => usedUrls.add(i.link));

      // Calculate stats
      const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
      const viralScore = cluster.length; // Raw count in cluster matches popularity
      const isViral = uniqueSources >= 3;

      // Generate Summary
      const meta = await generateTitleSummary(items);
      
      subjects.push({
        label: meta.title,
        titlu_ro: meta.title,
        sumar_ro: meta.summary,
        context_ro: meta.context,
        sentiment: meta.sentiment,
        items: items,
        thumbnail: pickBestThumbnail(items),
        sourceDiversity: uniqueSources,
        viralScore: viralScore,
        isViral: isViral
      });
    }

    // e. Sort subjects by Viral Score then Diversity
    subjects.sort((a, b) => b.viralScore - a.viralScore);

    // Keep top 6 topics per entity
    const finalSubjects = subjects.slice(0, 6);

    if (finalSubjects.length > 0) {
      entitiesOutput.push({ name: entityName, subjects: finalSubjects });
    }
  }

  // 3. Collect "Alte Știri" (Other News)
  // Logic: Must NOT be in usedUrls. Must be high viral/credibility.
  console.log("\n📰 Collecting Other News...");
  
  let leftovers = allArticles.filter(a => !usedUrls.has(a.link));
  
  // Cluster leftovers to find significant missing stories
  const leftoverClusters = clusterBySimilarity(leftovers);
  const otherNewsCandidates = [];

  for (const cluster of leftoverClusters) {
    // Only care about clusters with at least 2 sources OR 1 very high cred source
    const maxCred = Math.max(...cluster.map(c => c.credibility));
    if (cluster.length < 2 && maxCred < 0.9) continue;

    const items = cluster;
    const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
    
    // We just pick the "best" article from the cluster to display
    // Sort by credibility + length
    items.sort((a, b) => (b.credibility * 100 + b.title.length) - (a.credibility * 100 + a.title.length));
    const rep = items[0];

    otherNewsCandidates.push({
      title: rep.title,
      link: rep.link,
      source: rep.source,
      thumbnail: pickBestThumbnail(items) || rep.thumbnail,
      viralScore: uniqueSources // approximated by sources in cluster
    });
  }

  // Sort by score
  otherNewsCandidates.sort((a, b) => b.viralScore - a.viralScore);
  const otherNews = otherNewsCandidates.slice(0, 12);

  const report = {
    generatedAt: new Date().toISOString(),
    timezone: CONFIG.timezone,
    entities: entitiesOutput,
    otherNews: otherNews
  };

  // Write to disk
  await fs.promises.mkdir(CONFIG.outDir, { recursive: true });
  await fs.promises.writeFile(path.join(CONFIG.outDir, "data.json"), JSON.stringify(report, null, 2));
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  
  console.log("\n✅ Report generated successfully!");
  return report;
}

/** HTML Generator (Updated Layout) */
function generateHTML(report) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", {
    timeZone: CONFIG.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });
  
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
  
  try {
    const report = await buildReport();
    const html = generateHTML(report);
    
    await fs.promises.writeFile(path.join(CONFIG.outDir, "index.html"), html, "utf-8");
    
    console.log(`✅ HTML saved to ${path.join(CONFIG.outDir, "index.html")}`);
    console.log(`📊 Statistics:`);
    console.log(`   - Entities: ${report.entities.length}`);
    console.log(`   - Other News: ${report.otherNews?.length || 0}`);
  } catch(e) {
    console.error("FATAL ERROR:", e);
  }
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
