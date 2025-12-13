import fs from "fs";
import path from "path";
import OpenAI from "openai";
import he from "he";
import Parser from "rss-parser";

/** Configuration */
const CONFIG = {
  openaiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "",
  model: "gpt-5.2",
  outDir: path.join(process.cwd(), "public"),
  cacheDir: path.join(process.cwd(), ".cache"),
  timezone: "Europe/Bucharest",
  feeds: [
    "https://news.yam.ro/ro/rss",
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
    "news.yam.ro": 0.5,
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

/** Entity definitions with descriptions for GPT classification */
const ENTITIES = [
  {
    name: "Președinție",
    description: "Articole despre Președintele României (Nicușor Dan), Administrația Prezidențială, Palatul Cotroceni, decrete prezidențiale, sau activitatea oficială a președintelui.",
    keywords: ["Nicușor Dan", "Administrația Prezidențială", "Cotroceni", "președintele", "decret prezidențial"]
  },
  {
    name: "Guvern",
    description: "Articole despre Guvernul României, Premierul Ilie Bolojan, Palatul Victoria, miniștri, ministere, ordonanțe de urgență (OUG), decizii guvernamentale. Miniștrii actuali: Marian Neacșu, Cătălin Predoiu, Ionuț Moșteanu, Tanczos Barna, Dragoș Anastasiu, Alexandru Nazare, Radu Marinescu, Ciprian Șerban, Alexandru Rogobete, Oana Țoiu, Daniel David, Cseke Attila, Florin Barbu, Bogdan Ivan, Diana Buzoianu, Florin Petre Manole, Dragoș Pîslaru, Mihai Jurca.",
    keywords: ["Guvernul", "Premierul", "Bolojan", "Palatul Victoria", "executivul", "ministru", "minister", "OUG"]
  },
  {
    name: "Parlament",
    description: "Articole despre activitatea Parlamentului României, Camera Deputaților, Senat, legi votate în plen, dezbateri parlamentare, comisii parlamentare, deputați și senatori în funcția lor legislativă.",
    keywords: ["Parlamentul", "Camera Deputaților", "Senatul", "plen", "legislativ", "deputat", "senator", "lege votată"]
  },
  {
    name: "Coaliție (Putere)",
    description: "Articole despre partidele din coaliția de guvernare (PSD, PNL, USR, UDMR) - decizii de partid, conflicte interne, negocieri politice, declarații ale liderilor de partid în context politic.",
    keywords: ["PSD", "PNL", "USR", "UDMR", "coaliția", "coaliție"]
  },
  {
    name: "Opoziție",
    description: "Articole PRIMORDIAL despre partidele de opoziție sau liderii lor: AUR, George Simion, SOS România, Diana Șoșoacă, Partidul POT, Călin Georgescu. Articolul trebuie să fie DESPRE opoziție, nu doar să menționeze aceste nume în treacăt.",
    keywords: ["AUR", "Simion", "SOS România", "Șoșoacă", "Partidul POT", "Călin Georgescu"]
  },
  {
    name: "Local (Primării)",
    description: "Articole despre administrația locală: primari, primării, consilii locale, decizii ale autorităților locale din orașe și comune.",
    keywords: ["primar", "primăria", "consiliul local", "administrație locală"]
  },
];

/** STOP WORDS ROMANIAN */
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
    .replace(/[^\w\săîâșț]/g, "")
    .split(/\s+/)
    .map(w => stemRomanian(w)) // Apply basic stemming
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/** Basic Romanian stemming - removes common suffixes */
function stemRomanian(word) {
  // Remove common Romanian suffixes to normalize word forms
  const suffixes = [
    'ului', 'ului', 'elor', 'ilor', 'ații', 'ația', 'ație',
    'urilor', 'ilor', 'lor', 'ele', 'ele', 'ii', 'ei', 'ul', 'ua', 'ea',
    'ă', 'e', 'i', 'u', 'a'
  ];
  
  let stem = word.toLowerCase();
  
  // Only stem words longer than 4 characters
  if (stem.length <= 4) return stem;
  
  for (const suffix of suffixes) {
    if (stem.endsWith(suffix) && stem.length - suffix.length >= 3) {
      return stem.slice(0, -suffix.length);
    }
  }
  
  return stem;
}

function calculateSimilarity(str1, str2) {
  const set1 = new Set(getTokens(str1));
  const set2 = new Set(getTokens(str2));
  
  if (set1.size === 0 || set2.size === 0) return 0;
  
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  
  return intersection.size / union.size;
}

/** Clean GPT output - remove markdown artifacts */
function cleanGPTOutput(text) {
  if (!text) return "";
  return text
    .replace(/\*\*/g, '')      // Remove bold **
    .replace(/\*/g, '')        // Remove italic *
    .replace(/^#+\s*/gm, '')   // Remove headers #
    .replace(/`/g, '')         // Remove code backticks
    .replace(/\n+/g, ' ')      // Collapse newlines
    .trim();
}

/** Group articles by Topic Similarity */
function clusterBySimilarity(articles) {
  const clusters = [];
  const sortedArticles = [...articles].sort((a, b) => b.title.length - a.title.length);

  for (const article of sortedArticles) {
    let bestClusterIndex = -1;
    let bestSimilarity = 0;

    for (let i = 0; i < clusters.length; i++) {
      const cluster = clusters[i];
      
      // Compare against ALL articles in cluster, take the max similarity
      for (const clusterArticle of cluster) {
        const sim = calculateSimilarity(article.title, clusterArticle.title);
        if (sim > bestSimilarity) {
          bestSimilarity = sim;
          bestClusterIndex = i;
        }
      }
    }

    // Lowered threshold from 0.20 to 0.15 for better grouping
    if (bestSimilarity >= 0.15 && bestClusterIndex !== -1) {
      clusters[bestClusterIndex].push(article);
    } else {
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
  
  const enriched = articles.map(a => {
    const cred = CONFIG.sourceCredibility[domainOf(a.link)] || 0.5;
    return { ...a, credibility: cred };
  });

  return enriched;
}

/** GPT-based Romania Relevance Check */
async function checkRomaniaRelevance(articles) {
  console.log(`🇷🇴 Checking Romania relevance for ${articles.length} articles via GPT...`);
  
  const BATCH_SIZE = 20;
  const relevantArticles = [];
  
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    
    const payload = batch.map((a, idx) => ({
      id: idx,
      title: a.title,
      snippet: a.snippet.slice(0, 100),
    }));
    
    const prompt = `For each article below, answer YES or NO: Is this article about Romania or something significant involving Romania?

Return ONLY a JSON array of objects with "id" and "relevant" (boolean).

Articles:
${JSON.stringify(payload, null, 2)}`;

    try {
      const response = await openai.chat.completions.create({
        model: CONFIG.model,
        messages: [
          { 
            role: "system", 
            content: "You are a news classifier. Be concise. Output only valid JSON." 
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
      });
      
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const results = JSON.parse(jsonMatch[0]);
        results.forEach(r => {
          if (r.relevant === true) {
            relevantArticles.push(batch[r.id]);
          }
        });
      }
    } catch (err) {
      console.error(`  ⚠️  GPT Romania check failed for batch ${i}:`, err.message);
      // Fallback: include all articles from failed batch
      relevantArticles.push(...batch);
    }
    
    // Small delay to avoid rate limiting
    if (i + BATCH_SIZE < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  
  console.log(`  ✓ ${relevantArticles.length}/${articles.length} articles are Romania-relevant`);
  return relevantArticles;
}

/** GPT-based Entity Classification - classifies articles by PRIMARY topic */
async function classifyArticlesByEntity(articles) {
  console.log(`🏷️  Classifying ${articles.length} articles by political entity via GPT...`);
  
  // Build entity descriptions for the prompt
  const entityDescriptions = ENTITIES.map((e, idx) => 
    `${idx + 1}. ${e.name}: ${e.description}`
  ).join("\n");
  
  const BATCH_SIZE = 15;
  const classified = {}; // { entityName: [articles] }
  const unclassified = [];
  
  // Initialize
  ENTITIES.forEach(e => classified[e.name] = []);
  
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    
    const payload = batch.map((a, idx) => ({
      id: idx,
      title: a.title,
      snippet: a.snippet.slice(0, 150),
    }));
    
    const prompt = `Clasifică fiecare articol în UNA dintre categoriile politice de mai jos, bazat pe SUBIECTUL PRINCIPAL al articolului.

IMPORTANT: 
- Alege categoria doar dacă articolul este PRIMORDIAL despre acel subiect
- Dacă articolul doar MENȚIONEAZĂ un politician sau partid, dar nu este despre ei, NU îl clasifica acolo
- Dacă articolul nu se potrivește clar în nicio categorie politică, răspunde "none"

Categorii:
${entityDescriptions}

Pentru fiecare articol, răspunde cu JSON: {"id": number, "category": "numele categoriei" sau "none"}

Articole:
${JSON.stringify(payload, null, 2)}

Răspunde DOAR cu un array JSON valid.`;

    try {
      const response = await openai.chat.completions.create({
        model: CONFIG.model,
        messages: [
          { 
            role: "system", 
            content: "Ești un clasificator de știri politice. Fii precis și concis. Output doar JSON valid." 
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.1,
      });
      
      const content = response.choices[0].message.content;
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      
      if (jsonMatch) {
        const results = JSON.parse(jsonMatch[0]);
        results.forEach(r => {
          const article = batch[r.id];
          if (!article) return;
          
          const categoryName = r.category;
          
          if (categoryName && categoryName !== "none" && classified[categoryName]) {
            classified[categoryName].push(article);
          } else {
            unclassified.push(article);
          }
        });
      } else {
        // If parsing fails, add to unclassified
        unclassified.push(...batch);
      }
    } catch (err) {
      console.error(`  ⚠️  GPT classification failed for batch ${i}:`, err.message);
      unclassified.push(...batch);
    }
    
    // Progress indicator
    const progress = Math.min(i + BATCH_SIZE, articles.length);
    console.log(`  → Classified ${progress}/${articles.length} articles...`);
    
    // Small delay to avoid rate limiting
    if (i + BATCH_SIZE < articles.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  // Log results
  ENTITIES.forEach(e => {
    console.log(`  ✓ ${e.name}: ${classified[e.name].length} articles`);
  });
  console.log(`  ○ Unclassified: ${unclassified.length} articles`);
  
  return { classified, unclassified };
}

function deduplicateByUrl(articles) {
  const seen = new Map();
  articles.forEach(article => {
    const url = canonicalizeUrl(article.link);
    if (!seen.has(url)) seen.set(url, article);
  });
  return Array.from(seen.values());
}

/** GPT: Generate title, summary, and context */
async function generateTitleSummary(articles) {
  if (!articles.length) return { title: "", summary: "", context: "", sentiment: "neutral" };
  
  const sorted = articles.sort((a, b) => (b.credibility || 0.5) - (a.credibility || 0.5));
  
  const payload = sorted.map(a => ({
    title: a.title,
    snippet: a.snippet.slice(0, 150),
    source: a.source,
  }));
  
  const prompt = `Analizează articolele (ACELAȘI subiect). Creează:
TITLU: max 10 cuvinte
SUMAR: max 25 cuvinte, obiectiv
CONTEXT: o propoziție scurtă sau "N/A"
SENTIMENT: pozitiv|negativ|neutru|controversat

Articole:
${JSON.stringify(payload, null, 2)}`;

  try {
    const response = await openai.chat.completions.create({
      model: CONFIG.model,
      messages: [
        { role: "system", content: "Editor de știri. Răspunde concis în română. NU folosi markdown (fără **, #, `, etc)." },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
    });
    
    const content = response.choices[0].message.content;
    const title = cleanGPTOutput(content.match(/TITLU:\s*(.+)/)?.[1]) || sorted[0].title;
    const summary = cleanGPTOutput(content.match(/SUMAR:\s*(.+)/)?.[1]) || "";
    const context = cleanGPTOutput(content.match(/CONTEXT:\s*(.+)/)?.[1]) || "";
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
  console.log("\n🚀 Starting report generation (Logic V3 - GPT Classification)...\n");
  
  const today = new Date().toLocaleDateString("ro-RO").replaceAll(".", "-");
  const cacheFile = path.join(CONFIG.cacheDir, `report-v3-${today}.json`);
  
  await fs.promises.mkdir(CONFIG.cacheDir, { recursive: true });
  
  // 1. Fetch & Dedupe Global
  let allArticles = await fetchRSS();
  allArticles = allArticles.filter(a => withinLast24h(a.date));
  allArticles = deduplicateByUrl(allArticles);
  
  console.log(`✓ Fetched ${allArticles.length} recent articles.\n`);

  // 2. GPT-based Romania relevance check
  allArticles = await checkRomaniaRelevance(allArticles);
  
  // 3. GPT-based entity classification
  const { classified, unclassified } = await classifyArticlesByEntity(allArticles);

  const usedUrls = new Set();
  const entitiesOutput = [];
  const allUsedSources = new Set();

  // 4. Process each entity
  for (const entity of ENTITIES) {
    console.log(`\n📂 Processing: ${entity.name}`);
    
    let entityArticles = classified[entity.name] || [];
    
    // Remove articles already used in previous entities (shouldn't happen with GPT classification, but safety check)
    entityArticles = entityArticles.filter(a => !usedUrls.has(a.link));

    if (entityArticles.length === 0) {
      console.log(`   → No articles found.`);
      continue;
    }

    // Cluster by similarity
    const rawClusters = clusterBySimilarity(entityArticles);
    console.log(`   → Found ${rawClusters.length} topic clusters.`);

    const subjects = [];

    // Process each cluster
    for (const cluster of rawClusters) {
      const maxCred = Math.max(...cluster.map(c => c.credibility));
      
      // Filter: require 2+ articles OR high credibility source
      if (cluster.length < 2 && maxCred < 0.5) continue; 

      const items = cluster.slice(0, 5);
      
      // Mark as used
      items.forEach(i => {
        usedUrls.add(i.link);
        allUsedSources.add(domainOf(i.link));
      });

      const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
      const viralScore = cluster.length;
      const isViral = uniqueSources >= 3;

      const meta = await generateTitleSummary(items);
      
      const primaryLink = items[0]?.link || "";
      
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
        isViral: isViral,
        primaryLink: primaryLink
      });
    }

    subjects.sort((a, b) => b.viralScore - a.viralScore);
    const finalSubjects = subjects.slice(0, 6);

    if (finalSubjects.length > 0) {
      entitiesOutput.push({ name: entity.name, subjects: finalSubjects });
    }
  }

  // 5. Collect "Alte Știri" (Other News) from unclassified articles
  console.log("\n📰 Collecting Other News...");
  
  // Combine unclassified with any leftover classified articles not yet used
  let leftovers = [
    ...unclassified.filter(a => !usedUrls.has(a.link)),
    ...allArticles.filter(a => !usedUrls.has(a.link))
  ];
  
  // Dedupe leftovers
  leftovers = deduplicateByUrl(leftovers);
  
  const leftoverClusters = clusterBySimilarity(leftovers);
  const otherNewsCandidates = [];

  for (const cluster of leftoverClusters) {
    const maxCred = Math.max(...cluster.map(c => c.credibility));
    
    if (cluster.length < 2 && maxCred < 0.4) continue;

    const items = cluster;
    const uniqueSources = new Set(items.map(it => domainOf(it.link))).size;
    
    items.sort((a, b) => (b.credibility * 100 + b.title.length) - (a.credibility * 100 + a.title.length));
    const rep = items[0];

    // Track sources
    items.forEach(i => allUsedSources.add(domainOf(i.link)));

    otherNewsCandidates.push({
      title: rep.title,
      link: rep.link,
      source: rep.source,
      thumbnail: pickBestThumbnail(items) || rep.thumbnail,
      viralScore: uniqueSources
    });
  }

  otherNewsCandidates.sort((a, b) => b.viralScore - a.viralScore);
  const otherNews = otherNewsCandidates.slice(0, 12);

  const report = {
    generatedAt: new Date().toISOString(),
    timezone: CONFIG.timezone,
    entities: entitiesOutput,
    otherNews: otherNews,
    sources: Array.from(allUsedSources).sort()
  };

  await fs.promises.mkdir(CONFIG.outDir, { recursive: true });
  await fs.promises.writeFile(path.join(CONFIG.outDir, "data.json"), JSON.stringify(report, null, 2));
  await fs.promises.writeFile(cacheFile, JSON.stringify(report, null, 2));
  
  console.log("\n✅ Report generated successfully!");
  return report;
}

/** HTML Generator */
function generateHTML(report) {
  const date = new Date(report.generatedAt);
  const when = date.toLocaleString("ro-RO", {
    timeZone: CONFIG.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });
  
  const sourcesListHTML = report.sources ? report.sources.map(s => `<span class="source-tag">${he.encode(s)}</span>`).join(" ") : "";
  
  return `<!doctype html>
<html lang="ro">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Raport Politic – ${he.encode(when)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --bg: #fafafa;
  --surface: #ffffff;
  --ink: #111111;
  --ink-secondary: #444444;
  --ink-tertiary: #888888;
  --border: #e0e0e0;
  --border-dark: #cccccc;
  --accent: #111111;
}
*{box-sizing:border-box}
body{
  margin:0;padding:0;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg);
  color: var(--ink);
  line-height: 1.5;
}
a{color:inherit;text-decoration:none;transition:opacity 0.2s}
a:hover{opacity:0.7}

.wrap{max-width:1100px;margin:0 auto;padding:40px 20px 60px}

/* Timestamp */
.timestamp{
  font-size:0.75rem;
  color:var(--ink-tertiary);
  text-align:right;
  margin-bottom:40px;
  padding-bottom:16px;
  border-bottom:1px solid var(--border);
}

/* Entity Section */
.entity{margin-bottom:56px}
.entity-header{
  margin-bottom:20px;
  padding-bottom:8px;
  border-bottom:2px solid var(--ink);
}
.entity-title{
  font-size:0.85rem;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:0.1em;
  margin:0;
  color:var(--ink);
}

/* Grid Layout */
.cards-grid{
  display:grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap:20px;
}

/* Card Style */
.card{
  background:var(--surface);
  border:1px solid var(--border);
  overflow:hidden;
  display:flex;flex-direction:column;
  transition:border-color 0.2s;
}
.card:hover{border-color:var(--border-dark)}

.card--viral{
  border-width:2px;
  border-color:var(--ink);
  grid-column: 1 / -1;
}
.card--viral .card-content{
  display:grid;
  grid-template-columns: 1fr 1.2fr;
  gap:24px;
}
@media(max-width: 768px){ .card--viral .card-content{ grid-template-columns: 1fr; } }

/* Thumbnail */
.thumb-container{
  position:relative;
  width:100%;
  aspect-ratio: 16/9;
  background:#f0f0f0;
  overflow:hidden;
}
.thumb-container a{display:block;width:100%;height:100%}
.card--viral .thumb-container{
  height:100%;
  min-height:220px;
}
@media(max-width: 768px){ .card--viral .thumb-container{ height:200px; } }

.thumb{width:100%;height:100%;object-fit:cover;display:block;filter:grayscale(30%);transition:filter 0.3s}
.thumb:hover{filter:grayscale(0%)}

/* Content */
.body{padding:16px;flex:1;display:flex;flex-direction:column}
.meta-top{display:flex;gap:6px;margin-bottom:10px;font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
.badge{padding:3px 6px;border:1px solid var(--border-dark);color:var(--ink-secondary)}
.badge-viral{background:var(--ink);color:white;border-color:var(--ink)}

h3{
  font-size:1rem;
  font-weight:600;
  line-height:1.4;
  margin:0 0 8px;
}
h3 a{display:block}
.card--viral h3{font-size:1.25rem}

.context{font-size:0.75rem;color:var(--ink-tertiary);font-style:italic;margin-bottom:6px}
.summary{font-size:0.85rem;color:var(--ink-secondary);margin-bottom:12px;line-height:1.5}

/* Links List */
.links{list-style:none;padding:0;margin:auto 0 0;border-top:1px solid var(--border);padding-top:10px}
.links li{margin-bottom:4px;font-size:0.8rem;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.links a{font-weight:500;color:var(--ink-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.links span{font-size:0.65rem;color:var(--ink-tertiary);white-space:nowrap}

/* Other News Section */
.other-news-section{margin-top:60px;padding-top:32px;border-top:2px solid var(--ink)}
.other-news-title{font-size:0.85rem;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin:0 0 20px}
.other-list{display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:16px}
.other-item{display:flex;gap:12px;align-items:start;padding:12px;border:1px solid var(--border);background:var(--surface)}
.other-item:hover{border-color:var(--border-dark)}
.other-thumb{width:70px;height:50px;object-fit:cover;background:#f0f0f0;filter:grayscale(40%);flex-shrink:0}
.other-content{flex:1;min-width:0}
.other-link{font-weight:500;font-size:0.85rem;display:block;margin-bottom:2px;line-height:1.3}
.other-source{font-size:0.7rem;color:var(--ink-tertiary)}

/* Footer */
footer{
  margin-top:80px;
  padding-top:24px;
  border-top:1px solid var(--border);
  font-size:0.75rem;
  color:var(--ink-tertiary);
}
.footer-sources{margin-bottom:16px}
.footer-sources-title{font-weight:600;color:var(--ink-secondary);margin-bottom:8px}
.source-tag{
  display:inline-block;
  padding:2px 6px;
  margin:2px;
  background:#f5f5f5;
  border:1px solid var(--border);
  font-size:0.7rem;
}
.footer-coffee{
  margin-top:16px;
  padding:12px;
  background:#f9f9f9;
  border:1px solid var(--border);
  text-align:center;
}
.footer-coffee a{font-weight:600;color:var(--ink)}

@media(max-width: 600px){
  .cards-grid{grid-template-columns:1fr}
  .other-list{grid-template-columns:1fr}
}
</style>
</head>
<body>
<main class="wrap">
  <div class="timestamp">Raport generat: ${he.encode(when)}</div>
  <div id="content"></div>
  <footer>
    <div class="footer-sources">
      <div class="footer-sources-title">Surse utilizate</div>
      ${sourcesListHTML}
    </div>
    <div class="footer-coffee">
      ☕ Dacă ți-a fost util, poți să-mi dai o cafea: <a href="https://revolut.me/haurbalaur" target="_blank">revolut.me/haurbalaur</a>
    </div>
  </footer>
</main>
<script>
const data=${JSON.stringify(report)};
const content=document.getElementById("content");
const fmtDomain=u=>{try{return new URL(u).hostname.replace(/^www\\./,"")}catch{return""}};

// Helper pentru plural/singular
const fmtSources = n => n === 1 ? "1 sursă" : n + " surse";

// Render Entities
const entitiesHTML=data.entities.map(e=>{
  if(!e.subjects.length)return "";
  
  const cards=e.subjects.map(s=>{
    const isViral = s.isViral;
    const primaryLink = s.primaryLink || (s.items[0] ? s.items[0].link : "#");
    
    // Exclude first item from the links list since it's the primary link
    const otherItems = s.items.slice(1, isViral ? 5 : 4);
    const items = otherItems.map(it=>
      \`<li><a href="\${it.link}" target="_blank" title="\${it.title}">\${it.title}</a><span>\${fmtDomain(it.link)}</span></li>\`
    ).join("");
    
    const thumbSrc = s.thumbnail || "";
    const thumbHTML = thumbSrc ? \`<div class="thumb-container"><a href="\${primaryLink}" target="_blank"><img src="\${thumbSrc}" class="thumb" loading="lazy" onerror="this.parentElement.style.display='none'" /></a></div>\` : '';
    
    const viralBadge = s.isViral ? \`<span class="badge badge-viral">Viral</span>\` : '';
    const sourceBadge = \`<span class="badge">\${fmtSources(s.sourceDiversity)}</span>\`;
    
    const contextHTML = s.context_ro ? \`<div class="context">\${s.context_ro}</div>\` : '';
    
    // Viral layout vs Standard layout
    if(isViral && thumbSrc) {
       return \`
       <div class="card card--viral">
         <div class="card-content">
           \${thumbHTML}
           <div class="body">
             <div class="meta-top">\${viralBadge}\${sourceBadge}</div>
             <h3><a href="\${primaryLink}" target="_blank">\${s.titlu_ro}</a></h3>
             \${contextHTML}
             <div class="summary">\${s.sumar_ro}</div>
             \${items ? \`<ul class="links">\${items}</ul>\` : ''}
           </div>
         </div>
       </div>\`;
    }

    return \`
    <div class="card">
      \${thumbSrc ? thumbHTML : ''}
      <div class="body">
        <div class="meta-top">\${viralBadge}\${sourceBadge}</div>
        <h3><a href="\${primaryLink}" target="_blank">\${s.titlu_ro}</a></h3>
        \${contextHTML}
        <div class="summary">\${s.sumar_ro}</div>
        \${items ? \`<ul class="links">\${items}</ul>\` : ''}
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
    <h2 class="other-news-title">Alte Știri</h2>
    <div class="other-list">
      \${data.otherNews.map(item => \`
        <a href="\${item.link}" target="_blank" class="other-item">
          \${item.thumbnail ? \`<img src="\${item.thumbnail}" class="other-thumb" loading="lazy" onerror="this.style.display='none'" />\` : ''}
          <div class="other-content">
            <div class="other-link">\${item.title}</div>
            <div class="other-source">\${fmtDomain(item.link)}</div>
          </div>
        </a>
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
    console.log(`   - Sources: ${report.sources?.length || 0}`);
  } catch(e) {
    console.error("FATAL ERROR:", e);
  }
}

main().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
