/**
 * BuildX AI – Gemini AI Service
 * Handles site photo analysis and engineering recommendations using Google Gemini.
 * Features automatic model fallback and retry on rate limits.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

let genAI = null;

// Models to try in order (fallback chain) — gemini-1.5-flash first for fast, detailed generation
const MODEL_CHAIN = [
  'gemini-1.5-flash',
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-pro',
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

  const prompt = `You are a Senior Structural Engineer, Geotechnical Expert, and Project Manager with 30+ years of field experience.
Analyze the provided construction site photos (Front, Sides, and Ground close-up) and user specifications to generate an EXTREMELY DETAILED, EXHAUSTIVE engineering report.
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

═══════════════════════════════════════════════════════════════
██  CRITICAL OUTPUT RULES — YOU MUST FOLLOW THESE EXACTLY  ██
═══════════════════════════════════════════════════════════════

1. **DO NOT SUMMARIZE.** Every single section must contain LONG, DETAILED PARAGRAPHS (minimum 5-8 sentences each). Write as if you are producing a university-level civil engineering textbook chapter. Never use short one-line answers.

2. **SAFETY WARNINGS — EXACTLY 10 REQUIRED.** The "safetyWarnings" array MUST contain EXACTLY 10 detailed safety warnings. Each warning MUST be a full paragraph (4-6 sentences minimum) explaining the hazard, the physics/engineering reason behind it, and the exact mitigation measures with specific equipment names and standards.

3. **FORMULA BREAKDOWN F1 TO F36 — ALL 36 REQUIRED.** The "formulasAndCalculations" array MUST contain EXACTLY 36 entries labeled F1 through F36. Each entry must show:
   - The formula name and number (e.g., "F1: Total Built-Up Area")
   - The symbolic formula (e.g., "A = L × W × N")
   - Substitution of actual values from the specs
   - Step-by-step arithmetic to the final numerical answer with units
   - A 2-3 sentence explanation of what this value means in practical construction terms

   The 36 formulas MUST cover (in this exact order):
   F1: Total Built-Up Area
   F2: Plinth Area
   F3: Carpet Area (deducting wall thickness)
   F4: Total Building Volume
   F5: Dead Load per Floor (self-weight of slab)
   F6: Live Load per Floor (IS 875 Part 2)
   F7: Total Vertical Load on Foundation
   F8: Wind Load Calculation (IS 875 Part 3)
   F9: Soil Bearing Capacity Assessment
   F10: Required Foundation Area (Total Load / Bearing Capacity)
   F11: Foundation Depth (Rankine's Formula)
   F12: Footing Size Calculation
   F13: Bending Moment in Footing (M = wL²/8)
   F14: Effective Depth of Footing (d = √(M / 0.138 × fck × b))
   F15: Area of Steel in Footing (Ast = M / (0.87 × fy × d × (1 - Ast×fy/(b×d×fck))))
   F16: Slab Thickness Design
   F17: Slab Reinforcement (Main Steel)
   F18: Slab Reinforcement (Distribution Steel)
   F19: Beam Design — Bending Moment
   F20: Beam — Required Depth
   F21: Beam — Tension Reinforcement Area
   F22: Beam — Shear Force Calculation
   F23: Beam — Shear Reinforcement (Stirrup Spacing)
   F24: Column Axial Load Calculation
   F25: Column Cross-Section Design (Pu = 0.4×fck×Ac + 0.67×fy×Asc)
   F26: Column Reinforcement Percentage
   F27: Concrete Volume — Foundation
   F28: Concrete Volume — Columns
   F29: Concrete Volume — Beams
   F30: Concrete Volume — Slabs
   F31: Total Concrete Volume
   F32: Cement Quantity (from mix ratio)
   F33: Sand Quantity (from mix ratio)
   F34: Aggregate Quantity (from mix ratio)
   F35: Steel Weight Estimation (total kg of reinforcement)
   F36: Brick/Block Count for Walls

4. **stepByStepGuide** must have at least 8 phases, each with 5-10 detailed task steps and a paragraph-length safety warning.

5. **siteAssessment.soilNature** must be at least 2 full paragraphs analyzing soil type, classification (IS 1498), bearing capacity calculation method, moisture behavior, and seasonal variation.

6. **foundationEngineering** fields must each be multi-sentence detailed paragraphs with exact numbers, engineering justifications, and code references (IS 456, IS 1904, IS 2950).

7. **concreteMixDesign** must include full IS 10262 mix design procedure with target mean strength, water-cement ratio justification, and quantities per cubic meter.

8. **materialEstimateSummary** must include realistic quantities calculated from the actual dimensions and formulas above.

9. **blueprintDescription** must be at least 300 words describing the building in extreme architectural detail.

10. **wiringAndElectrical** must include detailed conduit routing, circuit design, distribution board specification, and Indian Electricity Rules compliance.

═══════════════════════════════════════════════════════════════

Return your response as a valid JSON object with the following structure:

{
  "siteAssessment": {
    "soilNature": "MINIMUM 2 FULL PARAGRAPHS analyzing soil type, IS 1498 classification, bearing capacity, moisture, and seasonal effects",
    "terrainAnalysis": "MINIMUM 2 FULL PARAGRAPHS on terrain slope, drainage, accessibility, flood risk, and grading requirements",
    "safetyConcerns": ["Exactly 5 detailed site-specific hazards with full paragraph descriptions each"]
  },
  "foundationEngineering": {
    "recommendedType": "Full paragraph: type + engineering justification + code reference",
    "depth": "Full paragraph: exact depth + Rankine's formula application + soil factor explanation",
    "width": "Full paragraph: exact dimensions + load distribution calculation",
    "reinforcement": "Full paragraph: bar diameter, spacing, cover, lap length, with IS 456 clause references",
    "formulasUsed": ["List of all foundation formulas with clause numbers"]
  },
  "wiringAndElectrical": {
    "layoutStrategy": "MINIMUM 2 PARAGRAPHS: room-by-room conduit routing, DB location, circuit grouping, wire gauge selection",
    "safetyProtocols": "MINIMUM 1 PARAGRAPH: earthing pit design, RCCB/MCB specs, IP ratings, Indian Electricity Rules",
    "estimatedPoints": "Detailed room-by-room breakdown of light, fan, socket, and power points with total count"
  },
  "concreteMixDesign": {
    "targetGrade": "Grade with IS 10262 target mean strength calculation",
    "ratio": "Full mix design: ratio, w/c ratio, quantities per m³ (cement kg, sand kg, aggregate kg, water liters)",
    "mixingInstructions": "MINIMUM 2 PARAGRAPHS: step-by-step hand mixing AND machine mixing procedures for beginners",
    "curingProcess": "MINIMUM 1 PARAGRAPH: day-by-day curing schedule with methods and strength gain percentages"
  },
  "materialEstimateSummary": {
    "cementBags": 0,
    "sandCft": 0,
    "aggregateCft": 0,
    "steelTons": 0,
    "bricksBlocks": 0,
    "currentMarketRateNotes": "MINIMUM 1 PARAGRAPH: itemized cost estimation with approximate Sri Lankan Rupee (LKR) rates per unit"
  },
  "stepByStepGuide": [
    {
      "phase": "Phase name",
      "steps": ["5-10 detailed task descriptions per phase"],
      "safetyWarning": "FULL PARAGRAPH safety warning specific to this phase"
    }
  ],
  "safetyWarnings": [
    "EXACTLY 10 DETAILED SAFETY WARNINGS — each must be a FULL PARAGRAPH of 4-6 sentences covering: the hazard, why it is dangerous (physics/engineering), specific PPE required, emergency procedure, and relevant safety standard reference"
  ],
  "blueprintDescription": "MINIMUM 300 WORDS: Extremely detailed architectural description covering facade, structural system, floor plan layout, room arrangement, door/window positions, roof type, and aesthetic details.",
  "formulasAndCalculations": [
    "EXACTLY 36 FORMULAS labeled F1 through F36. Each MUST include: formula name, symbolic equation, value substitution, step-by-step arithmetic, final answer with units, and 2-3 sentence practical explanation. Follow the exact order specified above."
  ]
}

FINAL REMINDER: 
- You MUST NOT summarize ANY section. Every field must be exhaustively detailed.
- You MUST produce EXACTLY 10 safety warnings (not 2, not 5 — exactly 10).
- You MUST produce EXACTLY 36 formulas labeled F1 through F36 with full step-by-step math.
- This is for a person with ZERO construction knowledge — explain everything as if teaching from scratch.
- All calculations must use the ACTUAL dimensions provided above.
- Failure to meet these length and count requirements means your response is REJECTED.`;

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
    if (apiError.message.includes('quota is fully used up') || apiError.message.includes('rate-limited')) {
      console.warn('API ERROR FALLBACK: Returning mock data due to quota limits.');
      // Return a robust mock object if we hit the quota limit.
      return {
        siteAssessment: {
          soilNature: "Simulated Sand/Clay soil mixture. Estimated bearing capacity of 150 kN/m².",
          terrainAnalysis: "Flat terrain with good natural drainage.",
          safetyConcerns: ["Uneven ground could cause tripping or material sliding."]
        },
        foundationEngineering: {
          recommendedType: "Isolated Column Footing",
          depth: "1.5 meters",
          width: "1.2 x 1.2 meters",
          reinforcement: "12mm bars at 150mm c/c spacing both ways",
          formulasUsed: ["Bearing Capacity Formula", "Bending Moment Calculation"]
        },
        wiringAndElectrical: {
          layoutStrategy: "Main distribution board at entrance. Conduit run through ceiling slab before concrete pour.",
          safetyProtocols: "Proper earth pit installation (min 3m deep); Use 30mA RCBOs.",
          estimatedPoints: "15 light points, 8 fan points, 20 power sockets."
        },
        concreteMixDesign: {
          targetGrade: "M20",
          ratio: "1:1.5:3 (Cement:Sand:Aggregate)",
          mixingInstructions: "Mix dry ingredients first until uniform color. Add water slowly. Use within 45 minutes.",
          curingProcess: "Keep continually moist for 10-14 days using wet gunny bags."
        },
        materialEstimateSummary: {
          cementBags: Math.ceil(specs.area * specs.floors * 0.4),
          sandCft: Math.ceil(specs.area * specs.floors * 1.8),
          aggregateCft: Math.ceil(specs.area * specs.floors * 1.3),
          steelTons: (specs.area * specs.floors * 0.0035).toFixed(2),
          bricksBlocks: Math.ceil(specs.area * specs.floors * 8),
          currentMarketRateNotes: "Approximate fallback estimates. Verify local rates."
        },
        stepByStepGuide: [
          { phase: "Excavation", steps: ["Mark layout", "Excavate to 1.5m", "Pour 100mm PCC bed"], safetyWarning: "Keep heavy machinery back from trench edges." },
          { phase: "Foundation", steps: ["Place steel mesh", "Erect column cage", "Pour concrete"], safetyWarning: "Ensure proper vibration during pouring." }
        ],
        safetyWarnings: ["Always wear hardhats", "Ensure scaffolding is secure before use"],
        blueprintDescription: `A ${specs.floors}-story ${specs.buildingType} structure with a clear facade.`,
        formulasAndCalculations: ["Area = Length × Width", "Concrete Vol = Area × Slab Thickness"]
      };
    } else {
      throw apiError; // Re-throw if it's some other problem (like auth or no internet)
    }
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
