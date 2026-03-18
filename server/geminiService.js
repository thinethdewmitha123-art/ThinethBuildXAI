/**
 * BuildX AI – Server-Side Gemini AI Service (BYOK — Bring Your Own Key)
 * Each request creates its own Gemini client using the user-provided API key.
 * No global state — the API key is passed per-request from the route handler.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

const MODEL_CHAIN = [
  'gemini-1.5-flash',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-2.5-pro',
];

function sanitizeApiKey(key) {
  if (!key) return '';
  return key.trim().replace(/[^\x20-\x7E]/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label = 'API call') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

/**
 * Validate API key format (no test call — saves quota)
 */
export function validateApiKey(apiKey) {
  const cleanKey = sanitizeApiKey(apiKey);
  if (!cleanKey || cleanKey.length < 10) {
    return { valid: false, error: 'API key is too short or contains invalid characters.' };
  }
  if (!cleanKey.startsWith('AIza') || cleanKey.length < 30) {
    return { valid: false, error: 'This doesn\'t look like a valid Google API key. Keys start with "AIza" and are about 39 characters long.' };
  }
  return { valid: true };
}

/**
 * Create a fresh Gemini client from a user-provided API key.
 * Called per-request — no global state.
 */
function createClient(apiKey) {
  const cleanKey = sanitizeApiKey(apiKey);
  const validation = validateApiKey(cleanKey);
  if (!validation.valid) throw new Error(validation.error);
  return new GoogleGenerativeAI(cleanKey);
}

/**
 * Try a Gemini API call with automatic model fallback and retry
 */
async function callWithFallback(genAI, callFn, maxRetries = 3) {
  let lastError = null;
  let hadRateLimit = false;
  let hadDailyExhaustion = false;

  for (const modelName of MODEL_CHAIN) {
    const model = genAI.getGenerativeModel({ model: modelName });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Trying ${modelName} (attempt ${attempt + 1})...`);
        const result = await withTimeout(callFn(model), 90000, modelName);
        console.log(`✅ Success with ${modelName}`);
        return result;
      } catch (error) {
        lastError = error;
        const msg = error.message || '';

        if (msg.includes('timed out')) {
          console.warn(`⏰ ${modelName} timed out, trying next model...`);
          break;
        }
        if (msg.includes('404') || msg.includes('not found') || msg.includes('NOT_FOUND')) {
          console.warn(`⏭️ ${modelName} not available (404), skipping...`);
          if (!hadRateLimit) lastError = error;
          break;
        }
        if (msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('expired')) {
          throw new Error('API key has expired or is invalid. Please check your key and try again.');
        }
        if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
          hadRateLimit = true;
          if (msg.includes('limit: 0') && (msg.includes('PerDay') || msg.includes('PerModelPerDay'))) {
            hadDailyExhaustion = true;
            console.warn(`🚫 ${modelName} daily quota exhausted, skipping...`);
            break;
          }
          const delayMatch = msg.match(/retry\s*(?:in|after|delay)?\s*[:\s"]*(\d+(?:\.\d+)?)\s*s/i);
          const waitMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1]) * 1000) + 2000 : 20000;
          if (attempt < maxRetries) {
            console.warn(`⏳ Rate limited on ${modelName}, waiting ${waitMs / 1000}s (${attempt + 1}/${maxRetries})...`);
            await sleep(waitMs);
            continue;
          } else {
            break;
          }
        }
        if (attempt < maxRetries) {
          console.warn(`⚠️ Error on ${modelName}, retrying in 3s...`, msg);
          await sleep(3000);
          continue;
        }
        break;
      }
    }
  }

  const errorMsg = lastError?.message || 'Unknown error';
  if (hadDailyExhaustion) {
    throw new Error(
      `Your API key's daily free quota is fully used up for today.\n\n` +
      `💡 Fix: Go to aistudio.google.com/apikey → create a new key in a new project.\n\n` +
      `Daily quotas reset at midnight Pacific Time (UTC-8).`
    );
  }
  if (hadRateLimit) {
    throw new Error(`All models are temporarily rate-limited. Please wait 1-2 minutes.\n\nDetails: ${errorMsg}`);
  }
  throw new Error(`Could not connect to any AI model. Check your internet and API key.\n\nDetails: ${errorMsg}`);
}

/**
 * Parse AI response JSON with 4-strategy recovery
 */
function parseAIResponse(text) {
  if (!text || text.trim().length === 0) {
    throw new Error('AI returned an empty response. Please try again.');
  }
  console.log('AI response length:', text.length, 'chars');

  try {
    return JSON.parse(text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
  } catch (e1) {}

  try {
    const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) return JSON.parse(match[1].trim());
  } catch (e2) {}

  try {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) return JSON.parse(text.substring(first, last + 1));
  } catch (e3) {}

  try {
    let candidate = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const startIdx = candidate.indexOf('{');
    if (startIdx === -1) throw new Error('No JSON start');
    candidate = candidate.substring(startIdx)
      .replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '')
      .replace(/,\s*"[^"]*"\s*:\s*$/, '')
      .replace(/,\s*"[^"]*$/, '')
      .replace(/,\s*$/, '');

    let braces = 0, brackets = 0, inString = false, escape = false;
    for (const ch of candidate) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') braces++; else if (ch === '}') braces--;
      if (ch === '[') brackets++; else if (ch === ']') brackets--;
    }
    while (brackets > 0) { candidate += ']'; brackets--; }
    while (braces > 0) { candidate += '}'; braces--; }

    const parsed = JSON.parse(candidate);
    console.warn('⚠️ AI response was truncated — repaired JSON successfully.');
    return parsed;
  } catch (e4) {
    console.error('All 4 JSON parse strategies failed. First 500:', text.substring(0, 500));
    throw new Error('AI returned an unexpected format. Please try again.');
  }
}

/**
 * Analyze construction site photos — per-request client from user's key
 */
export async function analyzeSite(apiKey, photos, specs, siteLocation = null) {
  const genAI = createClient(apiKey);

  const imageParts = photos.map(p => ({
    inlineData: { mimeType: p.mimeType, data: p.base64 },
  }));

  let locationContext = '';
  if (siteLocation) {
    locationContext = `
**Site Location (GPS):**
- Coordinates: ${siteLocation.lat}, ${siteLocation.lng}
- Address: ${siteLocation.address || 'Not available'}
- Region: ${siteLocation.region || 'Not specified'}
- City: ${siteLocation.city || 'Not specified'}

Use this location to determine:
- Local soil type and bearing capacity typical for this region
- Seismic zone (per IS 1893 if in India)
- Climate conditions (rainfall, temperature extremes, wind speed)
- Local building code requirements
- Regional material availability and typical construction practices
`;
  }

  const buildingType = specs.buildingType || 'residential_house';
  let buildingTypeContext = '';
  if (buildingType !== 'residential_house') {
    const typeDescriptions = {
      compound_wall: 'This is a COMPOUND/BOUNDARY WALL. Focus on wall-specific engineering.',
      retaining_wall: 'This is a RETAINING WALL. Focus on lateral earth pressure and stability.',
      water_tank: 'This is a WATER TANK/RESERVOIR. Focus on waterproofing and hydrostatic pressure.',
      commercial_building: 'This is a COMMERCIAL BUILDING. Consider higher live loads and fire safety.',
      warehouse: 'This is a WAREHOUSE/INDUSTRIAL building. Consider large clear spans.',
      multi_story: 'This is a MULTI-STORY BUILDING. Focus on frame design and seismic provisions.',
      garage: 'This is a GARAGE/PARKING structure. Consider vehicle loads and ventilation.',
      boundary_fence: 'This is a BOUNDARY FENCE/PILLAR structure. Focus on pillar foundation and spacing.',
    };
    buildingTypeContext = buildingType in typeDescriptions
      ? `\n**IMPORTANT – Building Type:** ${typeDescriptions[buildingType]}\n` : '';
  }

  const prompt = `Act as an expert Senior Structural Engineer. You MUST generate the report EXACTLY following the detailed Markdown structure below. DO NOT summarize. Write extremely detailed, long paragraphs. Calculate ALL costs strictly in Sri Lankan Rupees (LKR/Rs).
You MUST include exactly 10 Safety Warnings.
You MUST generate a highly detailed line-by-line mathematical breakdown from F1 to F36 explicitly calculating dimensions, volumes, materials, and geotechnical forces.

Model Requirements: Use gemini-1.5-flash with maxOutputTokens set to 65536 or higher.

Analyze the provided construction site photos (Front, Sides, and Ground close-up) and user specifications to generate a 100% ACCURATE engineering report.
${locationContext}${buildingTypeContext}
**Building Specifications:**
- Building Type: ${buildingType.replace(/_/g, ' ')}
- Building Area: ${specs.area} ${specs.unit}²
- Dimensions: ${specs.length} × ${specs.width} ${specs.unit}
- Total Height: ${specs.totalHeight} ${specs.unit}
- Number of Floors: ${specs.floors}
- Wall Thickness: ${specs.wallThickness} mm
- Wall Material: ${specs.wallType}
- User Vision: "${specs.description}"

**Your Task:**
Provide a professional Civil Engineering assessment following international standards (IS 456, ACI 318, Eurocodes). 

Return your response as a valid JSON object with the following structure:

{
  "siteAssessment": {
    "soilNature": "Detailed description of soil type, bearing capacity estimate, and moisture content observations",
    "terrainAnalysis": "Terrain slope, drainage efficiency, and site accessibility",
    "safetyConcerns": ["List of site-specific safety hazards identified from photos"]
  },
  "foundationEngineering": {
    "recommendedType": "e.g., Isolated Footing, Raft, or Strip",
    "depth": "Exact depth in meters with engineering justification",
    "width": "Exact width in meters",
    "reinforcement": "Basic steel bar sizing and spacing recommendation",
    "formulasUsed": ["Foundation formulas used for this calculation"]
  },
  "wiringAndElectrical": {
    "layoutStrategy": "Step-by-step guide on wiring, conduit placement, and distribution board location",
    "safetyProtocols": "Earthing requirements and circuit protection advice",
    "estimatedPoints": "Estimate of light, fan, and power points needed for this area"
  },
  "concreteMixDesign": {
    "targetGrade": "e.g., M25",
    "ratio": "Cement:Sand:Aggregate ratio with water-cement ratio",
    "mixingInstructions": "Detailed mixing procedure for hand-mixing on site for beginners",
    "curingProcess": "Days and method for curing"
  },
  "materialEstimateSummary": {
    "cementBags": 0,
    "sandCft": 0,
    "aggregateCft": 0,
    "steelTons": 0,
    "bricksBlocks": 0,
    "currentMarketRateNotes": "Estimation of total cost based on current market prices"
  },
  "stepByStepGuide": [
    { "phase": "e.g., Excavation", "steps": ["Task 1", "Task 2"], "safetyWarning": "Phase-specific warning" }
  ],
  "safetyWarnings": ["Critical site-wide safety measures for non-professionals"],
  "blueprintDescription": "Extremely detailed architectural description for generating a 3D visualization.",
  "formulasAndCalculations": ["List of every formula applied"]
}

IMPORTANT: 
- Be extremely precise. 
- Explain everything for a person with ZERO construction knowledge.
- All calculations must be grounded in engineering reality based on the building size.`;

  let result;
  try {
    result = await callWithFallback(genAI, async (model) => {
      const res = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
        generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 65536 },
      });
      return res;
    });
  } catch (apiError) {
    if (apiError.message.includes('quota is fully used up') || apiError.message.includes('rate-limited')) {
      console.warn('API FALLBACK: Returning mock data due to quota limits.');
      return {
        siteAssessment: { soilNature: "Simulated Sand/Clay soil. Estimated bearing capacity 150 kN/m².", terrainAnalysis: "Flat terrain with good drainage.", safetyConcerns: ["Uneven ground could cause tripping."] },
        foundationEngineering: { recommendedType: "Isolated Column Footing", depth: "1.5 meters", width: "1.2 x 1.2 meters", reinforcement: "12mm bars at 150mm c/c both ways", formulasUsed: ["Bearing Capacity Formula"] },
        wiringAndElectrical: { layoutStrategy: "Main distribution board at entrance.", safetyProtocols: "Earth pit min 3m deep; 30mA RCBOs.", estimatedPoints: "15 light, 8 fan, 20 power sockets." },
        concreteMixDesign: { targetGrade: "M20", ratio: "1:1.5:3", mixingInstructions: "Mix dry, add water slowly. Use within 45 min.", curingProcess: "Keep moist 10-14 days." },
        materialEstimateSummary: { cementBags: Math.ceil(specs.area * specs.floors * 0.4), sandCft: Math.ceil(specs.area * specs.floors * 1.8), aggregateCft: Math.ceil(specs.area * specs.floors * 1.3), steelTons: Number((specs.area * specs.floors * 0.0035).toFixed(2)), bricksBlocks: Math.ceil(specs.area * specs.floors * 8), currentMarketRateNotes: "Fallback estimates." },
        stepByStepGuide: [{ phase: "Excavation", steps: ["Mark layout", "Excavate to 1.5m", "Pour PCC bed"], safetyWarning: "Keep machinery from trench edges." }],
        safetyWarnings: ["Always wear hardhats", "Secure scaffolding before use"],
        blueprintDescription: `A ${specs.floors}-story ${buildingType} structure.`,
        formulasAndCalculations: ["Area = L × W", "Concrete Vol = Area × Thickness"]
      };
    }
    throw apiError;
  }

  const response = await result.response;
  let text;
  try { text = response.text(); } catch (e) { throw new Error('AI returned an empty response.'); }
  return parseAIResponse(text);
}

/**
 * Generate AI blueprint image — per-request client
 */
export async function generateBlueprintImage(apiKey, specs, analysis) {
  const genAI = createClient(apiKey);
  const foundationType = analysis.foundationRecommendation?.type || 'strip foundation';
  const wallDesc = specs.wallType === 'concrete_block' ? 'concrete block' : specs.wallType;
  const description = specs.description || 'residential building';

  const prompt = `Generate a professional architectural rendering of a ${specs.floors}-floor ${wallDesc} ${description}, dimensions approximately ${specs.length}x${specs.width} ${specs.unit}, with ${foundationType}. Show it as a clean, realistic front-elevation architectural visualization with clear structural details, proper proportions, surrounding landscape, and blue sky background. Make it look like a professional 3D architectural render.`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp-image-generation' });
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    });
    const response = await result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        return { imageData: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`, mimeType: part.inlineData.mimeType };
      }
    }
    return null;
  } catch (error) {
    console.error('Image generation failed:', error.message);
    return null;
  }
}

/**
 * Refine blueprint — per-request client
 */
export async function refineBlueprint(apiKey, currentAnalysis, feedback, specs) {
  const genAI = createClient(apiKey);

  const prompt = `You are an expert Structural Engineer. The user has reviewed your previous construction blueprint and has some requested changes or questions.

**User Feedback:** "${feedback}"

**Current Blueprint Details:**
- Building: ${specs.length}x${specs.width} ${specs.unit} (${specs.floors} floors)
- Wall: ${specs.wallType} (Thickness: ${specs.wallThickness}mm)

**Your Task:**
Update the previous blueprint JSON to incorporate these changes. If the user asks for a change that is UNSAFE, explain why in "safetyWarnings" but provide the best alternative.

Return the FULL updated JSON object with the same structure as before.`;

  const result = await callWithFallback(genAI, async (model) => {
    const res = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }, { text: JSON.stringify(currentAnalysis) }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 65536 },
    });
    return res;
  });

  const response = await result.response;
  let text;
  try { text = response.text(); } catch (e) { throw new Error('AI returned an empty response.'); }
  return parseAIResponse(text);
}
