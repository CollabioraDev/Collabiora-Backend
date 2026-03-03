import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2;

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const genAI2 = apiKey2 ? new GoogleGenerativeAI(apiKey2) : null;

let keyPointsKeyCounter = 0;

function getGenAIForKeyPoints() {
  if (!genAI && !genAI2) return null;
  if (!genAI2) return genAI;
  if (!genAI) return genAI2;
  keyPointsKeyCounter = (keyPointsKeyCounter + 1) % 2;
  return keyPointsKeyCounter === 0 ? genAI : genAI2;
}

const keyPointsCache = new Map();

async function fetchArticleBody(url) {
  if (!url) return "";
  try {
    const res = await axios.get(url, { timeout: 8000 });
    const html = res.data || "";
    // Very lightweight HTML → text
    const text = String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Keep a reasonable chunk for the model (more room for detail)
    return text.slice(0, 9000);
  } catch {
    return "";
  }
}

export async function getKeyPointsForArticle(article) {
  const instance = getGenAIForKeyPoints();
  if (!instance) {
    return {
      keyPoints: null,
      error: "AI not configured (missing GOOGLE_AI_API_KEY)",
    };
  }

  const safeUrl = article.url || "";
  const cacheKey = `keypoints:v2:${safeUrl}`;
  if (keyPointsCache.has(cacheKey)) {
    return { keyPoints: keyPointsCache.get(cacheKey), error: null };
  }

  const bodyText = await fetchArticleBody(safeUrl);

  const sourceText = [
    safeUrl && `URL: ${safeUrl}`,
    article.title && `Title: ${article.title}`,
    article.description && `Description: ${article.description}`,
    bodyText && `Full article text (truncated): ${bodyText}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `You are a careful medical news explainer for a patient support platform.

You will receive structured information about a health-related article (URL, title, description) plus, when available, raw page text.

Read it closely and produce 4–5 sections. Each section should have:
- A clear heading that captures the main idea of that section (for example: "What this is about", "Who this matters for", "Key results from the study", "Risks and side effects", "What this might mean for care").
- 2–4 plain‑language sentences underneath that heading explaining the idea in simple, patient‑friendly terms with enough detail that a careful reader really understands the point.

Content rules:
- Capture the most important findings, claims, or updates from the article.
- Highlight who the article is most relevant for (condition, age group, severity, etc.).
- Mention key details when present: study type (randomized trial, meta‑analysis, case report, etc.), approximate population size, comparison groups, primary outcomes, major numbers or effect sizes, and the strength/limitations of the evidence.
- Call out changes to guidelines, approvals/recalls, or new risks/side‑effects that matter to patients.
- Focus on what this could mean for a patient or caregiver in practical terms, but DO NOT give personalized medical advice.

Style rules:
- Use plain, patient‑friendly language. Briefly explain any unavoidable jargon.
- DO NOT speculate or invent facts that are not clearly supported by the article.
- DO NOT be sensational (no "miracle cure", "game changer", etc.).
 - Use **bold markdown** around a few of the most important medical terms, condition names, or key numbers so they stand out visually (for example: **ADHD**, **cognitive behavioral therapy (CBT)**, **1 in 5 adults**).

Output format (IMPORTANT):
- Output ONLY the sections, one per line.
- Each line MUST follow this exact pattern: Heading: explanation
  Example: Key results: In a trial of 500 adults with type 2 diabetes, the new drug lowered A1C by about 1% compared with standard care.
- Do NOT add bullets, numbers, stars, or extra formatting.
- Do NOT add any intro or conclusion text before or after the list.

Source article:
${sourceText}`;

  try {
    const model = instance.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    if (text && text.length > 10) {
      keyPointsCache.set(cacheKey, text);
      return { keyPoints: text, error: null };
    }
    return { keyPoints: null, error: "Empty response from AI" };
  } catch (err) {
    const msg = err?.message || String(err);
    console.warn("Gemini key-points service error:", msg.substring(0, 160));
    return { keyPoints: null, error: msg };
  }
}
