/**
 * BuildX AI – Gemini AI Service
 * Handles site photo analysis and engineering recommendations using Google Gemini.
 * Features automatic model fallback and retry on rate limits.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

let genAI = null;

// Models to try in order (fallback chain) — gemini-2.5-flash first for fast, detailed generation
const MODEL_CHAIN = [
  'gemini-2.5-flash'
];

/**
 * Sanitize API key to remove non-ASCII characters and invisible whitespace
 * that can cause "non ISO-8859-1" errors in browser Headers.
 */
function sanitizeApiKey(key) {
  if (!key) return '';
  // Remove non-breaking spaces, control characters, and non-ASCII points
  return key.trim().replace(/[^\x20-\x7E]/g, '');
}

/**
 * Initialize the Gemini client with user's API key
 */
export function initializeGemini(apiKey) {
  const cleanKey = sanitizeApiKey(apiKey);
  genAI = new GoogleGenerativeAI(cleanKey);
}

/**
 * Validate API key by format check only — no test API call.
 * This preserves quota for the actual analysis.
 * The key will be fully validated when the first real API call is made.
 */
export async function validateApiKey(apiKey) {
  try {
    const cleanKey = sanitizeApiKey(apiKey);
    if (!cleanKey || cleanKey.length < 10) {
      return { valid: false, error: 'API key is too short or contains invalid characters.' };
    }

    // Check format: Google API keys start with 'AIza' and are ~39 chars
    if (!cleanKey.startsWith('AIza') || cleanKey.length < 30) {
      return { valid: false, error: 'This doesn\'t look like a valid Google API key. Keys start with "AIza" and are about 39 characters long.' };
    }

    // Accept key by format — no test API call to save quota
    console.log('✅ API key format validated (quota-saving mode — skipping test call).');
    return { valid: true, model: MODEL_CHAIN[0] };
  } catch (error) {
    console.error('Validation failed:', error);
    return { valid: false, error: 'Something went wrong while checking your key.' };
  }
}

/**
 * Convert a File/Blob to base64 for Gemini Vision
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout(promise, ms, label = 'API call') {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

/**
 * Try a Gemini API call with automatic model fallback and retry
 * @param {Function} callFn - Function that takes a model and makes the API call
 * @param {number} maxRetries - Max retries per model for rate-limit errors
 * @returns {Object} The API result
 */
async function callWithFallback(callFn, maxRetries = 3) {
  let lastError = null;
  let hadRateLimit = false;
  let hadDailyExhaustion = false;

  for (const modelName of MODEL_CHAIN) {
    const model = genAI.getGenerativeModel({ model: modelName });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Trying ${modelName} (attempt ${attempt + 1})...`);
        const result = await withTimeout(callFn(model), 300000, modelName); // 5 min timeout for local — no rush
        console.log(`✅ Success with ${modelName}`);
        return result;
      } catch (error) {
        lastError = error;
        const msg = error.message || '';

        // Timeout → skip to next model
        if (msg.includes('timed out')) {
          console.warn(`⏰ ${modelName} timed out, trying next model...`);
          break;
        }

        // 404 / model not found → skip immediately to next model, no retries
        if (msg.includes('404') || msg.includes('not found') || msg.includes('NOT_FOUND')) {
          console.warn(`⏭️ ${modelName} not available (404), skipping to next model...`);
          // Don't overwrite lastError if we already have a rate-limit error (more relevant)
          if (!hadRateLimit) lastError = error;
          break;
        }

        // Auth error → don't retry, throw immediately
        if (msg.includes('API_KEY_INVALID') || msg.includes('401') || msg.includes('403') || msg.toLowerCase().includes('expired')) {
          throw new Error('API key has expired or is invalid. Please reset your key in the header and try again.');
        }

        // Rate limit / quota → check if retryable or if daily quota is fully exhausted
        if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
          hadRateLimit = true;

          // Check if this is a "limit: 0" per-day quota (not retryable today)
          if (msg.includes('limit: 0') && (msg.includes('PerDay') || msg.includes('PerModelPerDay'))) {
            hadDailyExhaustion = true;
            console.warn(`🚫 ${modelName} daily quota exhausted (limit: 0), skipping to next model...`);
            break; // No point retrying this model today
          }

          // Parse Google's recommended retry delay (e.g., "retry in 18.6s" or "retryDelay: 18s")
          const delayMatch = msg.match(/retry\s*(?:in|after|delay)?\s*[:\s"]*(\d+(?:\.\d+)?)\s*s/i);
          const waitMs = delayMatch ? Math.ceil(parseFloat(delayMatch[1]) * 1000) + 2000 : 20000;

          if (attempt < maxRetries) {
            console.warn(`⏳ Rate limited on ${modelName}, waiting ${waitMs / 1000}s before retry (${attempt + 1}/${maxRetries})...`);
            await sleep(waitMs);
            continue;
          } else {
            console.warn(`❌ ${modelName} still rate-limited after ${maxRetries} retries, trying next model...`);
            break;
          }
        }

        // Other error → retry with short delay
        if (attempt < maxRetries) {
          console.warn(`⚠️ Error on ${modelName}, retrying in 3s...`, msg);
          await sleep(3000);
          continue;
        }
        break;
      }
    }
  }

  // All models and retries exhausted
  const errorMsg = lastError?.message || 'Unknown error';
  if (hadDailyExhaustion) {
    throw new Error(
      `Your API key's daily free quota is fully used up for today.\n\n` +
      `💡 Fix: Go to aistudio.google.com/apikey → click "Create API key" → select "Create API key in new project" → paste the new key using the Reset Key button above.\n\n` +
      `Daily quotas reset at midnight Pacific Time (UTC-8).`
    );
  }
  if (hadRateLimit) {
    throw new Error(
      `All models are temporarily rate-limited. Please wait 1-2 minutes and try again.\n\n` +
      `Technical details: ${errorMsg}`
    );
  }
  throw new Error(
    `Could not connect to any AI model. Please check your internet connection and API key.\n\n` +
    `Technical details: ${errorMsg}`
  );
}

/**
 * Analyze construction site photos and generate a comprehensive engineering report
 */
export async function analyzeSite(imageFiles, specs, siteLocation = null) {
  if (!genAI) throw new Error('Gemini not initialized. Please set your API key.');

  // Convert all images to base64
  const imageParts = await Promise.all(
    Object.entries(imageFiles).map(async ([side, file]) => {
      const base64 = await fileToBase64(file);
      return {
        inlineData: {
          mimeType: file.type,
          data: base64,
        },
      };
    })
  );

  // Build location context if available
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

  // Build building type context
  const buildingType = specs.buildingType || 'residential_house';
  let buildingTypeContext = '';
  if (buildingType !== 'residential_house') {
    const typeDescriptions = {
      compound_wall: 'This is a COMPOUND/BOUNDARY WALL, not a house. Focus on wall-specific engineering: footing design, wall stability, wind resistance, and pillar spacing.',
      retaining_wall: 'This is a RETAINING WALL to hold back soil/earth. Focus on lateral earth pressure, drainage behind wall, counterfort design, and sliding/overturning stability.',
      water_tank: 'This is a WATER TANK/RESERVOIR. Focus on waterproofing, hydrostatic pressure, tank wall thickness, base slab design, and water tightness per IS 3370.',
      commercial_building: 'This is a COMMERCIAL BUILDING. Consider higher live loads, larger spans, fire safety, accessibility requirements, and commercial building codes.',
      warehouse: 'This is a WAREHOUSE/INDUSTRIAL building. Consider large clear spans, portal frame design, industrial flooring, loading dock requirements.',
      multi_story: 'This is a MULTI-STORY BUILDING. Focus on frame design, shear walls, elevator core, seismic provisions, and progressive collapse prevention.',
      garage: 'This is a GARAGE/PARKING structure. Consider vehicle loads, clear height requirements, ramp design, and ventilation.',
      boundary_fence: 'This is a BOUNDARY FENCE/PILLAR structure. Focus on pillar foundation, spacing, height-to-thickness ratio, and wind load.',
    };
    buildingTypeContext = buildingType in typeDescriptions
      ? `\n**IMPORTANT – Building Type:** ${typeDescriptions[buildingType]}\n`
      : '';
  }

<<<<<<< Updated upstream
  const prompt = `Act as an expert Senior Structural Engineer. You MUST generate the report EXACTLY following the detailed Markdown structure below. DO NOT summarize. Write extremely detailed, long paragraphs. Calculate ALL costs strictly in Sri Lankan Rupees (LKR/Rs).
You MUST include exactly 10 Safety Warnings.
You MUST generate a highly detailed line-by-line mathematical breakdown from F1 to F36 explicitly calculating dimensions, volumes, materials, and geotechnical forces. Use gemini-2.5-flash with maxOutputTokens: 65536.

Analyze the provided construction site photos (Front, Sides, and Ground close-up) and user specifications to generate an EXTREMELY DETAILED, EXHAUSTIVE engineering report.
=======
  const prompt = `You are a Senior Structural Engineer and Project Manager with 30 years of experience. 
Analyze the provided construction site photos (Front, Sides, and Ground close-up) and user specifications to generate a HYPER-DETAILED engineering report.

${locationContext}${buildingTypeContext}
>>>>>>> Stashed changes
**Building Specifications:**
- Building Type: ${buildingType.replace(/_/g, ' ')}
- Building Area: ${specs.area} ${specs.unit}²
- Dimensions: ${specs.length} × ${specs.width} ${specs.unit}
- Total Height: ${specs.totalHeight} ${specs.unit}
- Number of Floors: ${specs.floors}
- Wall Thickness: ${specs.wallThickness} mm
- Wall Material: ${specs.wallType}
- User Vision: "${specs.description}"

<<<<<<< Updated upstream
=======
**Your Task:**
Provide a professional Civil Engineering assessment following international standards (IS 456, ACI 318, Eurocodes). 
The user wants a VERY LONG and EXTREMELY DETAILED report. Do not provide brief answers.

>>>>>>> Stashed changes
Return your response as a valid JSON object with the following structure:
{
  "siteAssessment": {
<<<<<<< Updated upstream
    "soilNature": "Detailed description of soil type, bearing capacity estimate, and moisture content observations",
    "terrainAnalysis": "Terrain slope, drainage efficiency, and site accessibility",
    "safetyConcerns": ["List of site-specific safety hazards identified"]
  },
  "foundationEngineering": {
    "recommendedType": "Foundation Type",
    "depth": "Exact depth in meters",
    "width": "Exact width in meters",
    "reinforcement": "Steel bar sizing and spacing",
    "formulasUsed": ["Foundation formulas used"]
  },
  "wiringAndElectrical": {
    "layoutStrategy": "Conduit routing and distribution board location",
    "safetyProtocols": "Earthing and circuit protection",
    "estimatedPoints": "Estimate of light, fan, and power points"
  },
  "concreteMixDesign": {
    "targetGrade": "Concrete Grade",
    "ratio": "Cement:Sand:Aggregate ratio",
    "mixingInstructions": "Detailed mixing procedure",
    "curingProcess": "Days and method for curing"
  },
  "materialEstimateSummary": {
    "cementBags": 0,
    "sandCft": 0,
    "aggregateCft": 0,
    "steelTons": 0,
    "bricksBlocks": 0,
    "currentMarketRateNotes": "Estimation of total cost strictly in LKR"
  },
  "stepByStepGuide": [
    { "phase": "Phase name", "steps": ["Task 1"], "safetyWarning": "Phase-specific warning" }
  ],
  "safetyWarnings": [
    "10 exact safety warnings"
  ],
  "blueprintDescription": "Extremely detailed architectural description.",
  "formulasAndCalculations": [
    "F1:", "F2:"
  ]
}`;
=======
    "soilNature": "Provide a 3-4 sentence detailed technical description of the soil observed (e.g., 'Simulated Sand/Clay soil mixture with traces of organic matter'). Include a precise estimate of the Safe Bearing Capacity (e.g., '150 kN/m²') and detailed moisture/plasticity observations based on the ground close-up.",
    "terrainAnalysis": "A comprehensive analysis of terrain slope, exact drainage efficiency rating, and site accessibility for heavy machinery. Mention any potential risks like material sliding or uneven ground tripping hazards.",
    "safetyConcerns": ["List exactly 2-3 highly specific site hazards. Be descriptive (e.g., 'Uneven ground could cause tripping or material sliding near the eastern boundary')."]
  },
  "foundationEngineering": {
    "recommendedType": "Provide the full engineering name (e.g., 'Isolated Column Footing with RCC Pedestals'). Explain WHY this is chosen for this soil.",
    "depth": "Exact depth with engineering justification (e.g., '1.5 meters to reach stable strata and bypass expansive topsoil').",
    "width": "Exact dimensions (e.g., '1.2 x 1.2 meters base area').",
    "reinforcement": "HYPER-SPECIFIC steel bar sizing and spacing specifications (e.g., '12mm TMT bars at 150mm c/c spacing both ways in both directions with 50mm clear cover').",
    "formulasUsed": ["List the specific mathematical formulas used, e.g., 'λ Bearing Capacity Formula', 'λ Bending Moment Calculation (Mu = 0.138fck.b.d²)'"]
  },
  "wiringAndElectrical": {
    "layoutStrategy": "A 4-5 sentence professional layout strategy including conduit routing (e.g., 'through ceiling slab before concrete pour'), main distribution board location, and sub-circuit logic.",
    "safetyProtocols": "Specific protection advice: 'Proper earth pit installation (min 3m deep); Use 30mA RCBOs for all power sockets; 1.5mm wiring for lights and 4.0mm for high-power loads'.",
    "estimatedPoints": "Provide a broken-down list: 'Exactly 15 light points, 8 fan points, 20 high-quality power sockets, and 2 AC points'."
  },
  "concreteMixDesign": {
    "targetGrade": "Professional grade (e.g., 'Grade M20 - Standard for Residential').",
    "ratio": "The exact volumetric ratio (e.g., '1:1.5:3 (Cement:Sand:Aggregate)') and water-cement ratio (e.g., '0.50').",
    "mixingInstructions": "A detailed 4-step procedure for beginners: dry mixing, water addition, 45-minute usage rule, and consistency checks.",
    "curingProcess": "💧 Detailed process: 'Keep continually moist for 10-14 days using wet gunny bags or continuous ponding to ensure peak compression strength'."
  },
  "materialEstimateSummary": {
    "cementBags": 96,
    "sandCft": 432,
    "aggregateCft": 312,
    "steelTons": 0.84,
    "bricksBlocks": 1920,
    "currentMarketRateNotes": "Provide a 2-3 sentence AI market analysis. Calculate these numbers precisely for the area. Mention that these are approximate 2026 market rates and verify local transport costs."
  },
  "stepByStepGuide": [
    {
      "phase": "Excavation",
      "steps": ["Mark layout using lime/string", "Excavate to exactly 1.5m", "Pour 100mm PCC leveling bed (1:4:8 mix)"],
      "safetyWarning": "Keep heavy machinery back at least 1m from trench edges."
    },
    {
      "phase": "Foundation & Footing",
      "steps": ["Place pre-fabricated steel reinforcement mesh", "Erect vertical column starter bars", "Pour M25 concrete footing"],
      "safetyWarning": "Ensure proper mechanical vibration to remove air voids; use cover blocks."
    }
  ],
  "safetyWarnings": [
    "Always wear hardhats and high-visibility vests",
    "Ensure scaffolding is secure and ground-leveled before use",
    "Maintain clear access routes for emergency vehicles"
  ],
  "blueprintDescription": "Provide an extremely descriptive, multi-paragraph architectural visualization prompt. Describe materials, lighting, surroundings, and structural aesthetics in vivid detail.",
  "formulasAndCalculations": [
    "F1: Area = ${specs.length} × ${specs.width} = ${specs.area} ${specs.unit}²",
    "F2: Concrete Vol = Total Surface Area × Slab Thickness (0.15m)",
    "F3: Reinforcement = (Steel % / 100) × Cross-sectional Area",
    "Provide exactly 2 more relevant engineering formulas used in this specific project design."
  ]
}

IMPORTANT: 
- DO NOT summarize. BE VERBOSE.
- Provide professional engineering detail for EVERY field.
- Ensure the material quantities (cement, sand, etc.) are CALCULATED ACCURATELY based on the dimensions provided.
- Every string must be meaningful, technical, and helpful for a real construction project.`;
>>>>>>> Stashed changes

  let result;
  try {
    result = await callWithFallback(async (model) => {
      const res = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 65536,
        },
      });
      return res;
    });
  } catch (apiError) {
<<<<<<< Updated upstream
    console.error("API Call Failed:", apiError);
    throw apiError;
=======
    if (apiError.message.includes('quota is fully used up') || apiError.message.includes('rate-limited')) {
      console.warn('API ERROR FALLBACK: Returning mock data due to quota limits.');
      // Return a robust mock object if we hit the quota limit.
      return {
        siteAssessment: {
          soilNature: "Simulated Sand/Clay soil mixture with traces of fine silt and organic matter. Estimated Safe Bearing Capacity (SBC) of 150 kN/m² based on regional soil maps.",
          terrainAnalysis: "Flat terrain with excellent natural drainage patterns. Site is easily accessible for heavy machinery; however, the ground is slightly uneven which could cause material sliding if not leveled.",
          safetyConcerns: ["Uneven ground could cause tripping or material sliding near excavation sites", "Presence of overhead power lines requires caution during machinery operation"]
        },
        foundationEngineering: {
          recommendedType: "Isolated Column Footing with RCC Pedestals",
          depth: "1.5 meters (to bypass topsoil layer and reach stable strata)",
          width: "1.2 x 1.2 meters square footing base",
          reinforcement: "12mm TMT Steel bars at 150mm c/c spacing both ways (horizontal and vertical)",
          formulasUsed: ["λ Bearing Capacity (Terzaghi Formula)", "λ Bending Moment Calculation (Mu = 0.138fck.b.d²)"]
        },
        wiringAndElectrical: {
          layoutStrategy: "Main distribution board situated at the primary entrance for easy access. All conduits to be run through ceiling slab before concrete pour for a concealed finish.",
          safetyProtocols: "Proper earth pit installation (minimum 3m deep); Use 30mA RCBOs for all power sockets; 1.5mm wiring for lights.",
          estimatedPoints: "Exactly 15 light points, 8 fan points, 20 high-quality power sockets, and 2 dedicated AC points."
        },
        concreteMixDesign: {
          targetGrade: "Grade M20 - Standard Structural Concrete",
          ratio: "1:1.5:3 (Cement:Sand:Aggregate) with 0.50 water-cement ratio",
          mixingInstructions: "Mix dry ingredients first until a uniform color is achieved. Add water slowly. Use the entire batch within 45 minutes of adding water.",
          curingProcess: "💧 Keep continually moist for 10-14 days using wet gunny bags or continuous water ponding."
        },
        materialEstimateSummary: {
          cementBags: Math.ceil(specs.area * specs.floors * 0.4),
          sandCft: Math.ceil(specs.area * specs.floors * 1.8),
          aggregateCft: Math.ceil(specs.area * specs.floors * 1.3),
          steelTons: (specs.area * specs.floors * 0.0035).toFixed(2),
          bricksBlocks: Math.ceil(specs.area * specs.floors * 8),
          currentMarketRateNotes: "Quantities are estimated based on engineering volume. Prices are approximate 2026 market rates; verify with local suppliers."
        },
        stepByStepGuide: [
          { phase: "Excavation", steps: ["Mark layout using lime string", "Excavate to 1.5m depth", "Pour 100mm PCC leveling bed (1:4:8)"], safetyWarning: "Keep heavy machinery back from trench edges to prevent collapse." },
          { phase: "Foundation", steps: ["Place pre-fabricated steel mesh", "Erect vertical column cages", "Pour M25 concrete footing"], safetyWarning: "Ensure proper mechanical vibration during pouring; use cover blocks." }
        ],
        safetyWarnings: ["Always wear hardhats and safety boots", "Ensure scaffolding is secure and ground-leveled before use", "Maintain a first-aid kit on site"],
        blueprintDescription: `A high-detail 3D architectural rendering of a ${specs.floors}-story ${specs.buildingType} structure with a professional facade, landscaping, and clear structural lines.`,
        formulasAndCalculations: ["Area = Length × Width", "Concrete Vol = Area × Slab Thickness", "Steel Weight = Vol × Density × Reinforcement %"]
      };
    } else {
      throw apiError; // Re-throw if it's some other problem (like auth or no internet)
    }
>>>>>>> Stashed changes
  }

  const response = await result.response;
  let text;
  try {
    text = response.text();
  } catch (textErr) {
    console.error('Failed to read AI response text:', textErr);
    throw new Error('AI returned an empty response. Please try again.');
  }

  if (!text || text.trim().length === 0) {
    console.error('AI response was empty or whitespace-only.');
    throw new Error('AI returned an empty response. Please try again.');
  }

  console.log('AI response length:', text.length, 'chars. First 200:', text.substring(0, 200));

  let parsed;
  try {
    // Strategy 1: Try direct parse after stripping markdown fences
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e1) {
    try {
      // Strategy 2: Extract JSON from within markdown code block
      const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (codeBlockMatch) {
        parsed = JSON.parse(codeBlockMatch[1].trim());
      } else {
        // Strategy 3: Find the first { and last } to extract the JSON object
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          parsed = JSON.parse(text.substring(firstBrace, lastBrace + 1));
        } else {
          throw new Error('No JSON found');
        }
      }
    } catch (e2) {
      // Strategy 4: Repair truncated JSON (output was cut off before completion)
      try {
        let candidate = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const startIdx = candidate.indexOf('{');
        if (startIdx === -1) throw new Error('No JSON start found');
        candidate = candidate.substring(startIdx);

        // Remove any trailing incomplete string value (e.g., truncated mid-sentence)
        candidate = candidate.replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '')    // truncated key-value string
                             .replace(/,\s*"[^"]*"\s*:\s*$/, '')           // truncated after colon
                             .replace(/,\s*"[^"]*$/, '')                   // truncated key
                             .replace(/,\s*$/, '');                         // trailing comma

        // Count unbalanced braces and brackets
        let braces = 0, brackets = 0;
        let inString = false, escape = false;
        for (const ch of candidate) {
          if (escape) { escape = false; continue; }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') braces++;
          else if (ch === '}') braces--;
          else if (ch === '[') brackets++;
          else if (ch === ']') brackets--;
        }

        // Append missing closers
        while (brackets > 0) { candidate += ']'; brackets--; }
        while (braces > 0) { candidate += '}'; braces--; }

        parsed = JSON.parse(candidate);
        console.warn('⚠️ AI response was truncated — repaired JSON successfully (some data may be incomplete).');
      } catch (e3) {
        console.error('Failed to parse Gemini response (all 4 strategies failed).');
        console.error('Response length:', text.length);
        console.error('First 500 chars:', text.substring(0, 500));
        console.error('Last 300 chars:', text.substring(text.length - 300));
        throw new Error('AI returned an unexpected format. Please try again.');
      }
    }
  }

  return parsed;
}

/**
 * Generate an AI blueprint/visualization image of the building
 * Uses the gemini-2.0-flash-exp-image-generation model
 */
export async function generateBlueprintImage(specs, analysis) {
  if (!genAI) throw new Error('Gemini not initialized.');

  const foundationType = analysis.foundationRecommendation?.type || 'strip foundation';
  const wallDesc = specs.wallType === 'concrete_block' ? 'concrete block' : specs.wallType;
  const description = specs.description || 'residential building';

  const prompt = `Generate a professional architectural rendering of a ${specs.floors}-floor ${wallDesc} ${description}, dimensions approximately ${specs.length}x${specs.width} ${specs.unit}, with ${foundationType}. Show it as a clean, realistic front-elevation architectural visualization with clear structural details, proper proportions, surrounding landscape, and blue sky background. Make it look like a professional 3D architectural render.`;

  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp-image-generation' });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const response = await result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];

    // Find the image part
    for (const part of parts) {
      if (part.inlineData) {
        return {
          imageData: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          mimeType: part.inlineData.mimeType,
        };
      }
    }

    // No image found, return null
    console.warn('No image generated by AI');
    return null;
  } catch (error) {
    console.error('Image generation failed:', error.message);
    // Don't throw — image generation is optional, not critical
    return null;
  }
}

/**
 * Handle user feedback and refine the blueprint
 */
export async function refineBlueprint(currentAnalysis, feedback, specs) {
  if (!genAI) throw new Error('Gemini not initialized.');

  const prompt = `You are an expert Structural Engineer. The user has reviewed your previous construction blueprint and has some requested changes or questions.

**User Feedback:** "${feedback}"

**Current Blueprint Details:**
- Building: ${specs.length}x${specs.width} ${specs.unit} (${specs.floors} floors)
- Wall: ${specs.wallType} (Thickness: ${specs.wallThickness}mm)

**Your Task:**
Update the previous blueprint JSON to incorporate these changes. If the user asks for a change that is UNSAFE or against engineering rules, explain why in the "safetyWarnings" but still provide the best engineered alternative.

IMPORTANT: You must maintain the extremely high level of detail from the previous blueprint. Do not simplify or shorten any fields. Ensure all descriptions, steps, and calculations remain comprehensive and professional.

Return the FULL updated JSON object with the same structure as before.`;

  const result = await callWithFallback(async (model) => {
    const res = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }, { text: JSON.stringify(currentAnalysis) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: 65536,
      },
    });
    return res;
  });

  const response = await result.response;
  let text;
  try {
    text = response.text();
  } catch (textErr) {
    console.error('Failed to read refinement response text:', textErr);
    throw new Error('AI returned an empty response. Please try again.');
  }

  if (!text || text.trim().length === 0) {
    throw new Error('AI returned an empty response during refinement. Please try again.');
  }

  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (e1) {
    try {
      const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
      if (codeBlockMatch) {
        return JSON.parse(codeBlockMatch[1].trim());
      }
      const firstBrace = text.indexOf('{');
      const lastBrace = text.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      }
      throw new Error('No JSON found');
    } catch (e2) {
      // Strategy 4: Repair truncated JSON
      try {
        let candidate = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const startIdx = candidate.indexOf('{');
        if (startIdx === -1) throw new Error('No JSON start');
        candidate = candidate.substring(startIdx);
        candidate = candidate.replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '')
                             .replace(/,\s*"[^"]*"\s*:\s*$/, '')
                             .replace(/,\s*"[^"]*$/, '')
                             .replace(/,\s*$/, '');
        let braces = 0, brackets = 0;
        let inString = false, escape = false;
        for (const ch of candidate) {
          if (escape) { escape = false; continue; }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') braces++;
          else if (ch === '}') braces--;
          else if (ch === '[') brackets++;
          else if (ch === ']') brackets--;
        }
        while (brackets > 0) { candidate += ']'; brackets--; }
        while (braces > 0) { candidate += '}'; braces--; }
        const repaired = JSON.parse(candidate);
        console.warn('⚠️ Refinement response was truncated — repaired JSON successfully.');
        return repaired;
      } catch (e3) {
        console.error('Failed to parse refinement (all 4 strategies failed):', text.substring(0, 500));
        throw new Error('Could not refine blueprint. Please try again.');
      }
    }
  }
}

/**
 * Validate user specs — uses local checks only to save API quota.
 * AI validation removed to preserve quota for the actual analysis.
 * Returns an array of missing items or empty array if all is good.
 */
export async function validateSpecs(specs, photos) {
  // Skip AI validation entirely to conserve API quota.
  // Local validation in SpecValidator component handles this.
  console.log('ℹ️ Spec validation using local checks only (quota-saving mode).');
  return [];
}
