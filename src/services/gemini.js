/**
 * BuildX AI – Gemini AI Service (Frontend)
 * Handles site photo analysis and engineering recommendations using Google Gemini.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

let genAI = null;
const MODEL_CHAIN = ['gemini-2.5-flash'];

function sanitizeApiKey(key) {
  if (!key) return '';
  return key.trim().replace(/[^\x20-\x7E]/g, '');
}

export function initializeGemini(apiKey) {
  const cleanKey = sanitizeApiKey(apiKey);
  genAI = new GoogleGenerativeAI(cleanKey);
}

export async function validateApiKey(apiKey) {
  try {
    const cleanKey = sanitizeApiKey(apiKey);
    if (!cleanKey || cleanKey.length < 10) {
      return { valid: false, error: 'API key is too short or contains invalid characters.' };
    }
    if (!cleanKey.startsWith('AIza') || cleanKey.length < 30) {
      return { valid: false, error: 'This doesn\'t look like a valid Google API key.' };
    }
    return { valid: true, model: MODEL_CHAIN[0] };
  } catch (error) {
    return { valid: false, error: 'Something went wrong while checking your key.' };
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function withTimeout(promise, ms, label = 'API call') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms))
  ]);
}

async function callWithFallback(callFn, maxRetries = 3) {
  let lastError = null;
  let hadRateLimit = false;
  let hadDailyExhaustion = false;

  for (const modelName of MODEL_CHAIN) {
    const model = genAI.getGenerativeModel({ model: modelName });
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await withTimeout(callFn(model), 300000, modelName); // 5 min timeout
        return result;
      } catch (error) {
        lastError = error;
        const msg = error.message || '';
        if (msg.includes('timed out')) break;
        if (msg.includes('404') || msg.includes('NOT_FOUND')) {
          if (!hadRateLimit) lastError = error;
          break;
        }
        if (msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('expired')) {
          throw new Error('API key has expired or is invalid. Please reset your key in the header and try again.');
        }
        if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
          hadRateLimit = true;
          if (msg.includes('limit: 0') && (msg.includes('PerDay') || msg.includes('PerModelPerDay'))) {
            hadDailyExhaustion = true;
            break;
          }
          const delayMatch = msg.match(/retry\s*(?:in|after|delay)?\s*[:\s"]*(\d+(?:\.\d+)?)\s*s/i);
          const waitMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1]) * 1000) + 2000 : 20000;
          if (attempt < maxRetries) {
            await sleep(waitMs);
            continue;
          } else break;
        }
        if (attempt < maxRetries) {
          await sleep(3000);
          continue;
        }
        break;
      }
    }
  }

  const errorMsg = lastError?.message || 'Unknown error';
  if (hadDailyExhaustion) throw new Error(`Your API key's daily free quota is fully used up for today.`);
  if (hadRateLimit) throw new Error(`All models are temporarily rate-limited. Please wait 1-2 minutes and try again.`);
  throw new Error(`Could not connect to any AI model. Technical details: ${errorMsg}`);
}

export async function analyzeSite(imageFiles, specs, siteLocation = null) {
  if (!genAI) throw new Error('Gemini not initialized. Please set your API key.');

  const imageParts = await Promise.all(
    Object.entries(imageFiles).map(async ([side, file]) => ({
      inlineData: { mimeType: file.type, data: await fileToBase64(file) }
    }))
  );

  const buildingType = specs.buildingType || 'residential_house';
  const prompt = `Act as an expert Senior Structural Engineer. You MUST generate the report EXACTLY following the detailed Markdown structure below. DO NOT summarize. Write extremely detailed, long paragraphs. Calculate ALL costs strictly in Sri Lankan Rupees (LKR/Rs).
You MUST include exactly 10 Safety Warnings.
You MUST generate a highly detailed line-by-line mathematical breakdown from F1 to F36 explicitly calculating dimensions, volumes, materials, and geotechnical forces. Use gemini-2.5-flash with maxOutputTokens: 65536.

Analyze the provided construction site photos and user specifications to generate an EXTREMELY DETAILED, EXHAUSTIVE engineering report.
**Building Specifications:**
- Building Type: ${buildingType.replace(/_/g, ' ')}
- Building Area: ${specs.area} ${specs.unit}²
- Dimensions: ${specs.length} × ${specs.width} ${specs.unit}
- Total Height: ${specs.totalHeight} ${specs.unit}
- Number of Floors: ${specs.floors}
- Wall Thickness: ${specs.wallThickness} mm
- Wall Material: ${specs.wallType}
- User Vision: "${specs.description}"

Return your response as a valid JSON object with the following structure:
{
  "siteAssessment": {
    "soilNature": "Provide a detailed technical description of the soil.",
    "terrainAnalysis": "Comprehensive analysis of terrain slope.",
    "safetyConcerns": ["List 2-3 specific site hazards."]
  },
  "foundationEngineering": {
    "recommendedType": "Full engineering name.",
    "depth": "Exact depth.",
    "width": "Exact dimensions.",
    "reinforcement": "Specific steel bar sizing.",
    "formulasUsed": ["List mathematical formulas"]
  },
  "wiringAndElectrical": {
    "layoutStrategy": "Professional layout strategy.",
    "safetyProtocols": "Specific protection advice.",
    "estimatedPoints": "List of points."
  },
  "concreteMixDesign": {
    "targetGrade": "Professional grade.",
    "ratio": "Volumetric ratio.",
    "mixingInstructions": "Procedure.",
    "curingProcess": "Process for curing."
  },
  "materialEstimateSummary": {
    "cementBags": 0,
    "sandCft": 0,
    "aggregateCft": 0,
    "steelTons": 0,
    "bricksBlocks": 0,
    "currentMarketRateNotes": "Calculate prices precisely for the area in LKR."
  },
  "stepByStepGuide": [
    { "phase": "Phase Name", "steps": ["Step 1"], "safetyWarning": "Warning." }
  ],
  "safetyWarnings": ["Exactly 10 specific safety warnings."],
  "blueprintDescription": "Extremely descriptive multi-paragraph prompt.",
  "formulasAndCalculations": ["F1: Area = ...", "F2: Concrete Vol = ...", "List down to F36 explicitly"]
}`;

  let result;
  try {
    result = await callWithFallback(async (model) => {
      return await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 65536 },
      });
    });
  } catch (apiError) {
    throw apiError;
  }

  const response = await result.response;
  let text;
  try { text = response.text(); } catch (textErr) { throw new Error('AI returned an empty response.'); }
  if (!text || text.trim().length === 0) throw new Error('AI returned an empty response.');

  try {
    // 🔥 THE IRONCLAD JSON EXTRACTOR
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) throw new Error("No JSON boundaries found.");
    const rawJson = text.substring(firstBrace, lastBrace + 1);
    return JSON.parse(rawJson);
  } catch (parseError) {
    throw new Error('AI returned an unexpected format. Please try again.');
  }
}

export async function generateBlueprintImage(specs, analysis) {
  if (!genAI) throw new Error('Gemini not initialized.');
  const prompt = `Generate a professional architectural rendering of a ${specs.floors}-floor ${specs.wallType} building...`;
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp-image-generation' });
    const result = await model.generateContent({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } });
    const response = await result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) return { imageData: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`, mimeType: part.inlineData.mimeType };
    }
    return null;
  } catch (error) { return null; }
}

export async function refineBlueprint(currentAnalysis, feedback, specs) {
  if (!genAI) throw new Error('Gemini not initialized.');
  const prompt = `Update the previous blueprint JSON to incorporate these changes: "${feedback}" Return the FULL updated JSON object with the same structure.`;
  const result = await callWithFallback(async (model) => {
    return await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }, { text: JSON.stringify(currentAnalysis) }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 65536 },
    });
  });
  const response = await result.response;
  const text = response.text();
  try {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    return JSON.parse(text.substring(firstBrace, lastBrace + 1));
  } catch (e) { throw new Error('Could not refine blueprint.'); }
}

export async function validateSpecs(specs, photos) { return []; }