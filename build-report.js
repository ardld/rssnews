import fs from "fs";
import path from "path";
import OpenAI from "openai";
import he from "he";
import Parser from "rss-parser";

/** Configuration */
const CONFIG = {
  openaiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
  model: "gpt-5.1",
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
  ],
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
    "Nicușor Dan", 
    "Nicusor Dan", 
    "Administrația Prezidențială", 
    "Administratia Prezidentiala"
  ],
  "Guvern": [
    "Guvernul României",
    "Guvernul Romaniei",
    "Premierul României",
    "Premierul Romaniei",
    "prim-ministru României",
    "prim-ministru Romaniei",
    "ministerul",
    "ministrul",
    "ministra",
    "guvernul",
    "Bolojan",
  ],
  "Parlament": [
    "Parlamentul României",
    "Parlamentul Romaniei",
    "Camera Deputaților",
    "Camera Deputatilor",
    "Senatul României",
    "Senatul Romaniei",
    "deputatul",
    "senatorul",
    "senatoarea",
    "deputații",
    "senatorii",
    "votul din plen",
  ],
  "Coaliție (Putere)": [
    "PSD",
    "Partidul Social Democrat",
    "PNL",
    "Partidul Național Liberal",
    "Partidul National Liberal",
    "UDMR",
    "Uniunea Democrată Maghiară din România",
    "Uniunea Democrat Maghiar din Romania",
    "USR",
    "Uniunea Salvați România",
    "Uniunea Salvati Romania",
  ],
  "Opoziție": [
    "AUR",
    "Alianța pentru Unirea Românilor",
    "Alianta pentru Unirea Romanilor",
    "George Simion",
    "SOS România",
    "SOS Romania",
    "Diana Șoșoacă",
    "Diana Sosoaca",
    "Partidul Oamenilor Tineri",
    "Partidul POT",
    "Anamaria Gavrilă",
    "Anamaria Gavrila",
  ],
  "Local (Primării)": [
    "primar",
    "primăria",
    "primaria",
    "primarul"
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
  
  return articles;
}

/** Filter articles by keywords */
function filterByKeywords(articles, entityName) {
  const keywords = QUERIES[entityName] || [];
  return articles.filter(article => {
    const text = `${article.title} ${article.snippet}`.toLowerCase();
    return keywords.some(kw => text.includes(kw.toLowerCase()));
  });
}

/** Deduplicate by URL */
function deduplicateByUrl(articles) {
  const seen = new Map();
  articles.forEach(article => {
    const url = canonicalizeUrl(article.link);
    if (!seen.has(url)) seen.set(url, article);
  });
  return Array.from(seen.values());
}

/** GPT-5.1: Cluster articles into topics */
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

/** GPT-5.1: Generate title and summary */
async function generateTitleSummary(articles) {
  if (!articles.length) return { title: "", summary: "" };
  
  const payload = articles.map(a => ({
    title: a.title,
    snippet: a.snippet.slice(0, 200),
  }));
  
  const prompt = `Analizează aceste articole și creează:
1. Un titlu scurt și jurnalistic în limba română
2. Un sumar de maxim 2 propoziții

Format răspuns:
TITLU: <titlu>
SUMAR: <sumar>

Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Răspunde în limba română." },
        { role: "user", content: prompt },
      ],
      temperature: 0.5,
    });
    
    const content = response.choices[0].message.content;
    const title = content.match(/TITLU:\s*(.+)/)?.[1]?.trim() || "";
    const summary = content.match(/SUMAR:\s*(.+)/)?.[1]?.trim() || "";
    
    return { title, summary };
  } catch (err) {
    console.error("  ⚠️  Title/summary generation failed:", err.message);
    return { title: "", summary: "" };
  }
}

/** Main build function */
async function buildReport() {
  console.log("\n🚀 Starting report generation...\n");
  
  // Check cache
  const today = new Date().toLocaleDateString("ro-RO").replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.cacheDir, `report-${today}.json`);
  
  await fs.promises.mkdir(CONFIG.cacheDir, { recursive: true });
  if (fs.existsSync(cacheFile)) {
    console.log("✓ Using cached report");
    return JSON.parse(await fs.promises.readFile(cacheFile, "utf-8"));
  }
  
  // Fetch articles
  const allArticles = await fetchRSS();
  console.log(`\n✓ Total articles: ${allArticles.length}\n`);
  
  // Process each entity
  const entities = [];
  
  for (const entityName of ENTITIES) {
    console.log(`📊 Processing ${entityName}...`);
    
    // Filter and deduplicate
    let articles = filterByKeywords(allArticles, entityName);
    articles = articles.filter(a => withinLast24h(a.date));
    articles = deduplicateByUrl(articles);
    
    console.log(`  → ${articles.length} unique articles`);
    
    if (!articles.length) continue;
    
    // Cluster into topics
    const clusters = await clusterArticles(entityName, articles);
    console.log(`  → ${clusters.length} topics found`);
    
    // Generate summaries for each topic
    const subjects = [];
    for (const cluster of clusters) {
      const items = cluster.indices
        .map(i => articles[i])
        .filter(Boolean)
        .slice(0, 5);
      
      if (!items.length) continue;
      
      const { title, summary } = await generateTitleSummary(items);
      
      subjects.push({
        label: cluster.label || title,
        titlu_ro: title,
        sumar_ro: summary,
        items,
      });
    }
    
    entities.push({ name: entityName, subjects });
  }
  
  // Create report
  const report = {
    generatedAt: new Date().toISOString(),
    timezone: CONFIG.timezone,
    entities,
  };
  
  // Save
  await fs.promises.mkdir(CONFIG.outDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(CONFIG.outDir, "data.json"),
    JSON.stringify(report, null, 2)
  );
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  
  console.log("\n✅ Report generated successfully!\n");
  return report;
}

/** HTML generation */
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#1a1a1a;--bg:#fff;--muted:#6b7280;--line:#e5e7eb;--accent:#005a95;--accent-ink:#fff}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:Inter,sans-serif;color:var(--ink);background:var(--bg);line-height:1.6}
.wrap{max-width:1200px;margin:0 auto;padding:40px 20px}
.entity{margin:40px 0 32px}
.entity__t{display:inline-block;background:var(--accent);color:var(--accent-ink);padding:8px 16px;font:800 16px/1 Space Grotesk,sans-serif;text-transform:uppercase;margin:0 0 16px;border-radius:4px}
.card{border-bottom:1px solid var(--line);padding:24px 0;margin:0 0 16px}
.card__t{font:800 24px/1.2 Space Grotesk,sans-serif;margin:0 0 12px}
.sub__sum{font-size:16px;color:var(--muted);margin:12px 0 16px;line-height:1.5}
.items{margin:0;padding:0;list-style:none}
.items li{margin:8px 0;font-size:14px;display:flex;gap:8px}
.items a{color:inherit;text-decoration:none;border-bottom:1px solid rgba(10,10,10,.1)}
.items a:hover{border-bottom-color:var(--accent)}
.src{font-size:11px;padding:2px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted)}
</style>
</head>
<body>
<main class="wrap">
  <div id="content"></div>
</main>
<script>
const data=${JSON.stringify(report)};
const content=document.getElementById("content");
const fmtDomain=u=>{try{return new URL(u).hostname.replace(/^www\\./,"")}catch{return""}};
content.innerHTML=data.entities.map(e=>{
  if(!e.subjects.length)return "";
  const cards=e.subjects.map(s=>{
    const items=s.items.slice(0,5).map(it=>
      \`<li><a href="\${it.link}" target="_blank">\${it.title}</a><span class="src">\${fmtDomain(it.link)}</span></li>\`
    ).join("");
    const sum=s.sumar_ro?\`<p class="sub__sum">\${s.sumar_ro}</p>\`:"";
    return\`<div class="card"><h3 class="card__t">\${s.titlu_ro||s.label}</h3>\${sum}<ul class="items">\${items}</ul></div>\`;
  }).join("");
  return\`<section class="entity"><h2 class="entity__t">\${e.name}</h2>\${cards}</section>\`;
}).join("");
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
  
  await fs.promises.writeFile(
    path.join(CONFIG.outDir, "index.html"),
    html,
    "utf-8"
  );
  
  console.log(`✅ HTML saved to ${path.join(CONFIG.outDir, "index.html")}`);
  console.log(`📊 Statistics:`);
  console.log(`   - Entities: ${report.entities.length}`);
  console.log(`   - Topics: ${report.entities.reduce((s,e)=>s+e.subjects.length,0)}`);
  console.log(`   - Articles: ${report.entities.reduce((s,e)=>s+e.subjects.reduce((ss,sub)=>ss+sub.items.length,0),0)}`);
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
