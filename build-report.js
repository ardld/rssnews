import fs from "fs";
import path from "path";
import axios from "axios";
import he from "he";

/** =============================================
 *  Minimal Working Configuration
 *  ============================================= */
const CONFIG = {
  rss: {
    feeds: [
      "https://news.yam.ro/ro/rss",
      "https://hotnews.ro/c/actualitate/feed",
      "https://www.g4media.ro/feed",
      "https://libertatea.ro/feed/",
      "https://spotmedia.ro/feed",
      "https://recorder.ro/feed",
      "https://pressone.ro/api/rss",
    ]
  },
  filters: {
    timeWindowHours: 48,
    maxArticlesPerEntity: 20,
  },
  paths: {
    outDir: path.join(process.cwd(), "public"),
  }
};

const OUT_HTML = path.join(CONFIG.paths.outDir, "index.html");
const OUT_JSON = path.join(CONFIG.paths.outDir, "data.json");

/** =============================================
 *  RSS Feed Integration - MINIMAL
 *  ============================================= */
async function fetchAllRSSFeeds() {
  console.log("📡 Fetching RSS feeds...");
  const allItems = [];
  
  for (const feedUrl of CONFIG.rss.feeds) {
    try {
      const response = await axios.get(feedUrl, { 
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      
      const data = response.data;
      const itemMatches = data.matchAll(/<item>([\s\S]*?)<\/item>/g);
      
      for (const match of itemMatches) {
        const content = match[1];
        
        const extract = (regex) => {
          const m = content.match(regex);
          return m ? he.decode(m[1] || m[2] || '').trim() : '';
        };
        
        const title = extract(/<title>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/title>)/s);
        const link = extract(/<link>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/link>)/s);
        const description = extract(/<description>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/description>)/s);
        const pubDate = extract(/<pubDate>(?:<!\[CDATA\[(.*?)\]\]>|(.*?)<\/pubDate>)/s);
        
        let thumbnail = null;
        const imgMatch = description.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (imgMatch) thumbnail = imgMatch[1];
        
        const snippet = description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        
        if (title && link) {
          allItems.push({
            title,
            link: link.split('#')[0],
            source: new URL(link).hostname.replace('www.', ''),
            date: pubDate,
            snippet: snippet || title,
            thumbnail,
          });
        }
      }
    } catch (err) {
      console.error(`    ❌ Failed ${feedUrl}: ${err.message}`);
    }
  }
  
  console.log(`✓ Total items: ${allItems.length}`);
  return allItems;
}

/** =============================================
 *  Date Filter - MINIMAL
 *  ============================================= */
function withinTimeWindow(dateStr) {
  if (!dateStr) return true;
  
  const d = new Date(dateStr);
  if (!isNaN(d.getTime())) {
    const hoursDiff = (Date.now() - d.getTime()) / (1000 * 60 * 60);
    return hoursDiff <= CONFIG.filters.timeWindowHours;
  }
  
  return true; // Accept if can't parse
}

/** =============================================
 *  Entity Queries - SIMPLIFIED
 *  ============================================= */
const ENTITY_ORDER = ["guvern", "parlament", "putere", "opozitie", "presedintie", "local"];

const QUERIES = {
  "presedintie": ["președinte", "iohannis", "cotroceni"],
  "guvern": ["guvern", "premier", "ministru"],
  "parlament": ["parlament", "deputat", "senator"],
  "putere": ["psd", "pnl", "usr", "udmr"],
  "opozitie": ["aur", "simion", "sosoacă"],
  "local": ["primar", "consiliu județean"],
};

async function fetchEntityPool(name) {
  const queries = QUERIES[name] || [];
  const allItems = await fetchAllRSSFeeds();
  const results = [];
  
  for (const query of queries) {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    for (const item of allItems) {
      const text = `${item.title} ${item.snippet}`.toLowerCase();
      if (keywords.every(kw => text.includes(kw))) {
        if (!results.some(r => r.link === item.link)) {
          results.push(item);
        }
      }
    }
  }
  
  return results.filter(i => withinTimeWindow(i.date)).slice(0, CONFIG.filters.maxArticlesPerEntity);
}

/** =============================================
 *  Simple Clustering (NO GPT)
 *  ============================================= */
function simpleClustering(items) {
  const clusters = [];
  const used = new Set();
  
  // If we have items but no clusters, create one cluster with first 3 items
  if (items.length > 0) {
    clusters.push({
      label: "Știri de actualitate",
      indices: items.slice(0, 3).map((_, i) => i)
    });
  }
  
  return clusters.slice(0, 2);
}

/** =============================================
 *  HTML Generation - MINIMAL
 *  ============================================= */
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateHTML(report) {
  const entities = report.entities || [];
  
  if (!entities.length) {
    return `<div style="padding:20px;background:#f8d7da;border:2px solid #dc3545;">
      <h2>⚠️ No content found</h2>
      <p>Check build logs above. Feeds may be unreachable.</p>
    </div>`;
  }
  
  const content = entities.map(e => {
    const subs = e.subjects || [];
    if (!subs.length) return '';
    
    const cards = subs.map(s => {
      const items = (s.items || []).slice(0, 5).map(it => 
        `<li>
          <a href="${esc(it.link)}" target="_blank">${esc(it.title)}</a>
          <span style="font-size:11px;color:#666;margin-left:8px;">${esc(it.source)}</span>
        </li>`
      ).join('');
      
      const thumbnailHtml = s.thumbnail ? 
        `<div style="margin-bottom:10px;">
           <img src="${esc(s.thumbnail)}" style="max-width:100%;height:auto;border:1px solid #ccc;" alt="">
           <p style="font-size:11px;color:#999;margin-top:4px;">sursa: ${esc(s.thumbnailSource || '')}</p>
         </div>` : '';
      
      return `
        <div style="border-bottom:2px solid #000;padding:15px 0;">
          ${thumbnailHtml}
          <h3 style="font-size:20px;margin:0 0 8px;">${esc(s.titlu_ro || s.label || 'Subiect')}</h3>
          ${s.sumar_ro ? `<p style="color:#555;margin:8px 0;">${esc(s.sumar_ro)}</p>` : ''}
          <ul style="margin:0;padding-left:20px;">${items}</ul>
        </div>`;
    }).join('');
    
    return `
      <section style="margin:30px 0;">
        <h2 style="background:#ffd400;display:inline-block;padding:5px 10px;border:2px solid #000;font-size:18px;font-weight:bold;margin:0 0 15px;text-transform:uppercase;">
          ${esc(e.name)}
        </h2>
        ${cards}
      </section>`;
  }).join('');
  
  return `<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CONTEXTPOLITIC.ro</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
<style>
body{font-family:Inter,system-ui,sans-serif;line-height:1.6;color:#000;max-width:1200px;margin:0 auto;padding:20px;background:#fff}
a{color:#000;text-decoration:none;border-bottom:2px solid #ffd400}
a:hover{border-bottom-color:#000}
</style>
</head>
<body>
  ${content}
  <footer style="margin-top:40px;padding-top:20px;border-top:2px solid #000;text-align:center;font-size:12px;">
    <p>Generat la: ${new Date().toLocaleString("ro-RO")}</p>
  </footer>
</body>
</html>`;
}

/** =============================================
 *  Build Pipeline - MINIMAL
 *  ============================================= */
async function build() {
  console.log("\n🚀 Building report...");
  
  const entities = [];
  
  for (const name of ENTITY_ORDER) {
    console.log(`\n📥 Processing: ${name}`);
    const items = await fetchEntityPool(name);
    console.log(`   Found ${items.length} items`);
    
    if (items.length === 0) continue;
    
    const clusters = simpleClustering(items);
    console.log(`   Created ${clusters.length} clusters`);
    
    const subjects = clusters.map(cl => {
      const subset = cl.indices.map(i => items[i]).filter(Boolean);
      return {
        label: cl.label,
        titlu_ro: subset[0]?.title || "Subiect",
        sumar_ro: subset[0]?.snippet?.substring(0, 150) || "",
        items: subset,
        thumbnail: subset[0]?.thumbnail || null,
        thumbnailSource: subset[0]?.source || '',
      };
    });
    
    if (subjects.length > 0) {
      entities.push({ name, subjects });
      console.log(`   ✓ Added ${subjects.length} subjects`);
    }
  }
  
  const report = { 
    generatedAt: new Date().toISOString(), 
    entities,
    stats: {
      totalEntities: entities.length,
      totalSubjects: entities.reduce((sum, e) => sum + (e.subjects?.length || 0), 0)
    }
  };
  
  console.log(`\n✅ Build complete! ${report.stats.totalEntities} sections, ${report.stats.totalSubjects} stories`);
  return report;
}

// Run
async function run() {
  try {
    const report = await build();
    
    // Save JSON
    await fs.promises.mkdir(CONFIG.paths.outDir, { recursive: true });
    await fs.promises.writeFile(OUT_JSON, JSON.stringify(report, null, 2));
    
    // Save HTML
    const html = generateHTML(report);
    await fs.promises.writeFile(OUT_HTML, html, "utf-8");
    
    console.log(`\n✅ SUCCESS! ${OUT_HTML} written`);
    console.log(`📊 ${html.length} bytes, ${report.stats.totalEntities} sections, ${report.stats.totalSubjects} stories`);
    
  } catch (err) {
    console.error("\n❌ FATAL ERROR:", err.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}
