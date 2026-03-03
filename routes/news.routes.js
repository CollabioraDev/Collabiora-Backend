import { Router } from "express";
import axios from "axios";
import dotenv from "dotenv";
import { getKeyPointsForArticle } from "../services/newsKeyPoints.service.js";

dotenv.config();

const router = Router();

// ─── In-memory cache ──────────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}
function setCached(key, data) {
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ─── Source credibility registry ────────────────────────────────────────────
// Score A: 0–25
const SOURCE_SCORES = {
  // Government / Academic (25)
  "cdc.gov": 25,
  "nih.gov": 25,
  "who.int": 25,
  "fda.gov": 25,
  "health.canada.ca": 25,
  "mayoclinic.org": 25,
  "hopkinsmedicine.org": 25,
  "stanfordmedicine.org": 25,
  "medlineplus.gov": 25,
  "ucsf.edu": 25,
  "clevelandclinic.org": 25,

  // Established health journalism (20)
  "medscape.com": 20,
  "statnews.com": 20,
  "healthday.com": 20,
  "reuters.com": 20,
  "verywellhealth.com": 20,
  "patient.info": 20,

  // Advocacy / Disease-specific orgs (18)
  "alzheimers.org.uk": 18,
  "alzforum.org": 18,
  "parkinson.org": 18,
  "michaeljfox.org": 18,
  "nationalmssociety.org": 18,
  "msif.org": 18,
  "epilepsy.com": 18,
  "ilae.org": 18,
  "americanmigrainefoundation.org": 18,
  "migrainetrust.org": 18,
  "stroke.org": 18,
  "cancer.org": 18,
  "cancerresearchuk.org": 18,
  "komen.org": 18,
  "lungevity.org": 18,
  "lls.org": 18,
  "heart.org": 18,
  "world-heart-federation.org": 18,
  "aafa.org": 18,
  "copdfoundation.org": 18,
  "cff.org": 18,
  "lupus.org": 18,
  "arthritis.org": 18,
  "crohnscolitisfoundation.org": 18,
  "celiac.org": 18,
  "rarediseases.org": 18,
  "eurordis.org": 18,
  "mda.org": 18,
  "hdsa.org": 18,
  "nami.org": 18,
  "mentalhealthamerica.net": 18,
  "adaa.org": 18,
  "autismspeaks.org": 18,
  "ndss.org": 18,
  "diabetes.org": 18,
  "jdrf.org": 18,
  "thyroid.org": 18,
  "nof.org": 18,
  "uspainfoundation.org": 18,
  "amfar.org": 18,
  "hepb.org": 18,
  "globalgenes.org": 18,
};

function getSourceScore(domain) {
  if (!domain) return 10;
  const lower = domain.toLowerCase().replace(/^www\./, "");
  if (SOURCE_SCORES[lower]) return SOURCE_SCORES[lower];
  // partial match
  for (const [host, score] of Object.entries(SOURCE_SCORES)) {
    if (lower.includes(host) || host.includes(lower)) return score;
  }
  return 10; // default commercial
}

// ─── Disease → search keyword map ──────────────────────────────────────────
const DISEASE_KEYWORDS = {
  // Neurology
  alzheimer: "Alzheimer's disease treatment",
  dementia: "dementia research",
  parkinson: "Parkinson's disease",
  "multiple sclerosis": "multiple sclerosis MS treatment",
  ms: "multiple sclerosis MS",
  epilepsy: "epilepsy seizure treatment",
  migraine: "migraine headache treatment",
  stroke: "stroke brain treatment",
  als: "ALS amyotrophic lateral sclerosis",
  huntington: "Huntington's disease",
  "muscular dystrophy": "muscular dystrophy treatment",

  // Oncology
  cancer: "cancer treatment oncology",
  "breast cancer": "breast cancer treatment",
  "lung cancer": "lung cancer treatment",
  leukemia: "leukemia lymphoma treatment",
  lymphoma: "lymphoma treatment",
  "colon cancer": "colorectal cancer treatment",
  "prostate cancer": "prostate cancer treatment",

  // Cardiology
  "heart disease": "heart disease cardiology treatment",
  hypertension: "high blood pressure hypertension treatment",
  arrhythmia: "heart arrhythmia treatment",
  "heart failure": "heart failure cardiology",

  // Pulmonology
  asthma: "asthma treatment",
  copd: "COPD chronic obstructive pulmonary disease",
  "cystic fibrosis": "cystic fibrosis treatment",

  // Autoimmune
  lupus: "lupus SLE treatment",
  "rheumatoid arthritis": "rheumatoid arthritis treatment",
  crohn: "Crohn's disease treatment",
  colitis: "ulcerative colitis treatment",
  celiac: "celiac disease gluten",

  // Metabolic / Endocrine
  diabetes: "diabetes treatment insulin",
  "type 1 diabetes": "type 1 diabetes treatment",
  "type 2 diabetes": "type 2 diabetes management",
  thyroid: "thyroid disorder treatment",
  obesity: "obesity weight loss treatment",

  // Mental Health
  depression: "depression mental health treatment",
  anxiety: "anxiety disorder treatment",
  bipolar: "bipolar disorder treatment",
  schizophrenia: "schizophrenia treatment",
  ptsd: "PTSD post-traumatic stress treatment",
  adhd: "ADHD attention deficit treatment",
  ocd: "OCD obsessive compulsive disorder treatment",

  // Other
  autism: "autism spectrum disorder treatment",
  "down syndrome": "Down syndrome research",
  hiv: "HIV AIDS treatment",
  hepatitis: "hepatitis treatment",
  osteoporosis: "osteoporosis treatment bone health",
  "chronic pain": "chronic pain management",
  fibromyalgia: "fibromyalgia treatment",
  "rare disease": "rare disease treatment orphan drug",
};

function buildSearchQuery(conditions = []) {
  if (!conditions || conditions.length === 0) {
    return "health medical research treatment breakthrough";
  }

  const keywords = new Set();
  for (const cond of conditions) {
    const lower = (cond || "").toLowerCase().trim();
    // Direct match
    if (DISEASE_KEYWORDS[lower]) {
      keywords.add(DISEASE_KEYWORDS[lower]);
      continue;
    }
    // Partial match
    let matched = false;
    for (const [key, kw] of Object.entries(DISEASE_KEYWORDS)) {
      if (lower.includes(key) || key.includes(lower)) {
        keywords.add(kw);
        matched = true;
        break;
      }
    }
    if (!matched) keywords.add(cond); // fallback to raw condition name
  }

  return [...keywords].slice(0, 3).join(" OR ");
}

// ─── Scoring ────────────────────────────────────────────────────────────────
function scoreArticle(article, conditions) {
  // A: Source credibility (0–25)
  let domain = "";
  try {
    domain = new URL(article.url || "").hostname;
  } catch {
    /* ignore */
  }
  const scoreA = getSourceScore(domain);

  // B: Evidence strength heuristic from title/description (0–25)
  const text =
    `${article.title || ""} ${article.description || ""}`.toLowerCase();
  let scoreB = 10;
  if (
    /(phase [23]|randomized|rct|systematic review|meta-analysis|clinical trial|fda approved|ema approved)/.test(
      text,
    )
  )
    scoreB = 25;
  else if (/(phase 1|observational study|cohort)/.test(text)) scoreB = 15;
  else if (/(expert|consensus|guideline)/.test(text)) scoreB = 10;
  else if (/(preliminary|preprint|early|promise)/.test(text)) scoreB = 5;

  // C: Clinical relevance (0–20)
  let scoreC = 5;
  if (conditions && conditions.length > 0) {
    for (const cond of conditions) {
      const lower = (cond || "").toLowerCase();
      if (text.includes(lower)) {
        scoreC = 20;
        break;
      }
      // partial
      for (const k of Object.keys(DISEASE_KEYWORDS)) {
        if (lower.includes(k) || k.includes(lower)) {
          if (text.includes(k)) {
            scoreC = 15;
            break;
          }
        }
      }
    }
  } else {
    scoreC = 10; // general health
  }

  // D: Patient impact (0–15)
  let scoreD = 5;
  if (
    /(fda approved|ema approved|new treatment|breakthrough|new drug|recall|safety alert|clinical trial recruit)/.test(
      text,
    )
  )
    scoreD = 15;
  else if (/(treatment option|new therapy|approved|phase 3)/.test(text))
    scoreD = 10;

  // Non-sensational penalty
  let penalty = 0;
  if (
    /(miracle cure|secret|they don't want|shocking|destroy cancer|reverse|cure in|100%)/.test(
      text,
    )
  )
    penalty = 15;

  return Math.max(0, scoreA + scoreB + scoreC + scoreD - penalty);
}

// ─── Main route: GET /api/news ───────────────────────────────────────────────
// Query params:
//   ?conditions=Diabetes,Hypertension  (comma-separated user conditions)
//   ?pageSize=10
router.get("/news", async (req, res) => {
  try {
    const rawConditions = req.query.conditions || "";
    const conditions = rawConditions
      ? rawConditions
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : [];
    const pageSize = Math.min(parseInt(req.query.pageSize || "12", 10), 24);

    const cacheKey = `news:${conditions.join("|")}:${pageSize}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const newsApiKey = process.env.NEWS_API_KEY;
    if (!newsApiKey) {
      return res
        .status(503)
        .json({ error: "News API key not configured", articles: [] });
    }

    const query = buildSearchQuery(conditions);

    // Fetch from NewsAPI
    const newsRes = await axios.get("https://newsapi.org/v2/everything", {
      params: {
        q: query,
        language: "en",
        sortBy: "publishedAt",
        pageSize: 30, // fetch more, then filter & sort
        apiKey: newsApiKey,
      },
      timeout: 10000,
    });

    let articles = (newsRes.data?.articles || []).filter(
      (a) =>
        a.title &&
        a.url &&
        a.title !== "[Removed]" &&
        a.url !== "https://removed.com",
    );

    // Score & sort
    articles = articles
      .map((a) => ({ ...a, _score: scoreArticle(a, conditions) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, pageSize);

    // No default AI summary — summaries are generated on demand via POST /news/key-points

    // Build response
    const responseArticles = articles.map((a) => {
      let domain = "";
      try {
        domain = new URL(a.url).hostname.replace(/^www\./, "");
      } catch {
        /* ignore */
      }
      return {
        title: a.title,
        description: a.description,
        url: a.url,
        urlToImage: a.urlToImage,
        publishedAt: a.publishedAt,
        source: a.source?.name || domain,
        sourceDomain: domain,
        author: a.author,
        score: a._score,
      };
    });

    const payload = {
      articles: responseArticles,
      query,
      conditions,
      total: responseArticles.length,
    };

    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error("News route error:", err?.message);
    if (err.response?.status === 401) {
      return res
        .status(503)
        .json({ error: "Invalid News API key", articles: [] });
    }
    if (err.response?.status === 429) {
      return res
        .status(429)
        .json({ error: "News API rate limit exceeded", articles: [] });
    }
    res
      .status(500)
      .json({ error: "Failed to fetch health news", articles: [] });
  }
});

// POST /api/news/key-points — generate AI key points for one article (on demand)
router.post("/news/key-points", async (req, res) => {
  try {
    const { title, description, url } = req.body || {};
    if (!title && !url) {
      return res
        .status(400)
        .json({ error: "Missing title or url", keyPoints: null });
    }
    const article = {
      title: title || "",
      description: description || "",
      url: url || "",
    };
    const { keyPoints, error } = await getKeyPointsForArticle(article);
    if (error) {
      const status = error.includes("not configured") ? 503 : 500;
      return res.status(status).json({ error, keyPoints: null });
    }
    if (!keyPoints) {
      return res
        .status(503)
        .json({ error: "Could not generate key points", keyPoints: null });
    }
    res.json({ keyPoints });
  } catch (err) {
    console.error("Key-points route error:", err?.message);
    res.status(500).json({
      error: err?.message || "Failed to generate key points",
      keyPoints: null,
    });
  }
});

// GET /api/news/sources — return the curated source list for display
router.get("/news/sources", (_req, res) => {
  const sources = [
    // General Health
    {
      name: "CDC",
      domain: "cdc.gov",
      category: "Government",
      url: "https://www.cdc.gov/media/index.html",
    },
    {
      name: "NIH / MedlinePlus",
      domain: "medlineplus.gov",
      category: "Government",
      url: "https://medlineplus.gov/news/",
    },
    {
      name: "WHO",
      domain: "who.int",
      category: "Global Health",
      url: "https://www.who.int/news",
    },
    {
      name: "FDA",
      domain: "fda.gov",
      category: "Government",
      url: "https://www.fda.gov/news-events",
    },
    {
      name: "Mayo Clinic",
      domain: "mayoclinic.org",
      category: "Academic",
      url: "https://newsnetwork.mayoclinic.org/",
    },
    {
      name: "Cleveland Clinic",
      domain: "clevelandclinic.org",
      category: "Academic",
      url: "https://health.clevelandclinic.org/",
    },
    {
      name: "Johns Hopkins",
      domain: "hopkinsmedicine.org",
      category: "Academic",
      url: "https://www.hopkinsmedicine.org/news/",
    },
    {
      name: "Medscape",
      domain: "medscape.com",
      category: "Medical Journalism",
      url: "https://www.medscape.com/news",
    },
    {
      name: "STAT News",
      domain: "statnews.com",
      category: "Medical Journalism",
      url: "https://www.statnews.com/",
    },
    {
      name: "Reuters Health",
      domain: "reuters.com",
      category: "Medical Journalism",
      url: "https://www.reuters.com/news/health/",
    },
    {
      name: "Verywell Health",
      domain: "verywellhealth.com",
      category: "Patient Education",
      url: "https://www.verywellhealth.com/",
    },

    // Disease-specific
    {
      name: "Alzheimer's Association",
      domain: "alz.org",
      category: "Neurology",
      url: "https://alz.org/news/",
    },
    {
      name: "Parkinson's Foundation",
      domain: "parkinson.org",
      category: "Neurology",
      url: "https://www.parkinson.org/news",
    },
    {
      name: "National MS Society",
      domain: "nationalmssociety.org",
      category: "Neurology",
      url: "https://www.nationalmssociety.org/About-the-Society/News",
    },
    {
      name: "American Cancer Society",
      domain: "cancer.org",
      category: "Oncology",
      url: "https://www.cancer.org/latest-news.html",
    },
    {
      name: "Cancer Research UK",
      domain: "cancerresearchuk.org",
      category: "Oncology",
      url: "https://news.cancerresearchuk.org/",
    },
    {
      name: "American Heart Association",
      domain: "heart.org",
      category: "Cardiology",
      url: "https://newsroom.heart.org/",
    },
    {
      name: "AAFA",
      domain: "aafa.org",
      category: "Pulmonology",
      url: "https://www.aafa.org/news-releases/",
    },
    {
      name: "COPD Foundation",
      domain: "copdfoundation.org",
      category: "Pulmonology",
      url: "https://www.copdfoundation.org/Learn-More/I-am-a-Person-with-COPD/COPD-News-Today.aspx",
    },
    {
      name: "American Diabetes Assoc.",
      domain: "diabetes.org",
      category: "Endocrinology",
      url: "https://diabetes.org/newsroom",
    },
    {
      name: "NAMI",
      domain: "nami.org",
      category: "Mental Health",
      url: "https://www.nami.org/Press-Media/Press-Releases",
    },
    {
      name: "Lupus Foundation",
      domain: "lupus.org",
      category: "Autoimmune",
      url: "https://www.lupus.org/news",
    },
    {
      name: "Arthritis Foundation",
      domain: "arthritis.org",
      category: "Autoimmune",
      url: "https://www.arthritis.org/news/",
    },
    {
      name: "Leukemia & Lymphoma Soc.",
      domain: "lls.org",
      category: "Oncology",
      url: "https://www.lls.org/news",
    },
  ];
  res.json({ sources });
});

// GET /api/news/search — search news articles by keyword
// Query params:
//   ?q=keyword
//   ?pageSize=12
router.get("/news/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) {
      return res.status(400).json({ error: "Missing search query", articles: [] });
    }
    const pageSize = Math.min(parseInt(req.query.pageSize || "12", 10), 24);

    const cacheKey = `search:${q.toLowerCase()}:${pageSize}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const newsApiKey = process.env.NEWS_API_KEY;
    if (!newsApiKey) {
      return res.status(503).json({ error: "News API key not configured", articles: [] });
    }

    // Append "health" context to keep results health-related
    const query = `${q} health`;

    const newsRes = await axios.get("https://newsapi.org/v2/everything", {
      params: {
        q: query,
        language: "en",
        sortBy: "relevancy",
        pageSize: 30,
        apiKey: newsApiKey,
      },
      timeout: 10000,
    });

    let articles = (newsRes.data?.articles || []).filter(
      (a) =>
        a.title &&
        a.url &&
        a.title !== "[Removed]" &&
        a.url !== "https://removed.com",
    );

    // Score & sort by credibility
    articles = articles
      .map((a) => ({ ...a, _score: scoreArticle(a, [q]) }))
      .sort((a, b) => b._score - a._score)
      .slice(0, pageSize);

    const responseArticles = articles.map((a) => {
      let domain = "";
      try {
        domain = new URL(a.url).hostname.replace(/^www\./, "");
      } catch {
        /* ignore */
      }
      return {
        title: a.title,
        description: a.description,
        url: a.url,
        urlToImage: a.urlToImage,
        publishedAt: a.publishedAt,
        source: a.source?.name || domain,
        sourceDomain: domain,
        author: a.author,
        score: a._score,
      };
    });

    const payload = { articles: responseArticles, query: q, total: responseArticles.length };
    setCached(cacheKey, payload);
    res.json(payload);
  } catch (err) {
    console.error("News search route error:", err?.message);
    if (err.response?.status === 401) {
      return res.status(503).json({ error: "Invalid News API key", articles: [] });
    }
    if (err.response?.status === 429) {
      return res.status(429).json({ error: "News API rate limit exceeded", articles: [] });
    }
    res.status(500).json({ error: "Failed to search health news", articles: [] });
  }
});

export default router;

