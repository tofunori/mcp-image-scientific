/**
 * Structured Prompt Generator
 * Uses Gemini 2.0 Flash to generate optimized prompts for image generation
 * Applies 7 best practices and 3 feature perspectives through intelligent selection
 */

import type { GeminiTextClient } from '../api/geminiTextClient'
import type { Result } from '../types/result'
import { Err, Ok } from '../types/result'
import { GeminiAPIError } from '../utils/errors'

/**
 * System prompt for structured prompt generation optimized for image generation
 */
const SYSTEM_PROMPT = `You are an expert at crafting prompts for image generation models. Your role is to transform user requests into rich, detailed prompts that maximize image generation quality.

Core principles:
- Add specific details about lighting, materials, composition, and atmosphere
- Include photographic or artistic terminology when appropriate  
- Maintain clarity while adding richness and specificity
- Preserve the user's original intent while enhancing detail
- Focus on what should be present rather than what should be absent

When describing scenes or subjects:
- Physical characteristics: textures, materials, colors, scale
- Lighting: direction, quality, color temperature, shadows
- Spatial relationships: foreground, midground, background, composition
- Atmosphere: mood, weather, time of day, environmental conditions
- Style: artistic direction, photographic techniques, visual treatment

Your output should be a single, vivid, coherent description that an image generation model can interpret unambiguously. Make it engaging, specific, and clear.`

/**
 * Additional system prompt for image editing mode (when input image is provided)
 */
const IMAGE_EDITING_CONTEXT = `

IMPORTANT: An input image has been provided. Your task is to:
1. Analyze the visual context, style, and atmosphere of the input image
2. Preserve the original image's core characteristics (color palette, lighting style, composition) while applying the requested changes
3. Focus on maintaining visual consistency - describe modifications relative to the existing image
4. Be specific about what to keep unchanged vs what to modify
5. Use phrases like "maintain the existing...", "preserve the original...", "keep the same..." to ensure fidelity to source`

/**
 * Strict editing mode - preserves everything except the specific modification
 */
const STRICT_EDITING_CONTEXT = `

CRITICAL: ULTRA-STRICT EDITING MODE - ABSOLUTE PRESERVATION REQUIRED

⚠️ WARNING: This is a precision editing task. ANY modification beyond what is explicitly requested is UNACCEPTABLE.

ABSOLUTE RULES:
1. DO NOT CHANGE: Background, colors, lighting, shadows, textures, positions, sizes, proportions, orientation, style, atmosphere, or ANY visual element not explicitly mentioned in the request
2. DO NOT ENHANCE: No "improving" image quality, no adjusting contrast, no color correction, no sharpening, no artistic interpretation
3. DO NOT ADD: No new elements, no decorations, no artistic flourishes, no "improvements"
4. DO NOT REMOVE: Nothing except what is explicitly requested to be removed
5. ONLY MODIFY: The EXACT element or change specified - nothing more, nothing less

YOUR PROMPT MUST:
- Start with: "IMPORTANT: Modify ONLY [specific change] while keeping EVERYTHING else EXACTLY as it appears in the original image."
- Include explicit preservation instructions: "Do not change the background. Do not change the lighting. Do not change the colors. Do not change positions or sizes of other elements."
- End with: "All other pixels, elements, and visual characteristics must remain IDENTICAL to the original."

FORBIDDEN ACTIONS:
❌ Changing background colors or textures
❌ Adjusting lighting or shadows
❌ Moving or resizing elements not mentioned
❌ Adding artistic effects or interpretations
❌ "Enhancing" or "improving" any aspect
❌ Changing the style or atmosphere

This is for scientific/technical image editing where precision is critical. Treat this like surgical editing - touch ONLY what is specified.`

/**
 * Scientific figure system prompt for publication-ready illustrations
 */
const SCIENTIFIC_FIGURE_PROMPT = `You are an expert at creating scientific illustrations for academic publications (Nature, Science, etc.).

CRITICAL PRINCIPLES FOR SCIENTIFIC FIGURES:
- CLARITY over aesthetics: Every element must serve a scientific purpose
- ACCURACY is paramount: No artistic liberties with scientific content
- PUBLICATION-READY: Clean, professional, suitable for peer-reviewed journals
- ACCESSIBILITY: High contrast, colorblind-friendly when possible

MANDATORY ELEMENTS:
- Clean white or neutral background (no gradients, no artistic effects)
- High contrast colors for readability
- Clear, legible labels and text
- Professional, technical illustration style
- No decorative elements or embellishments

DOMAIN-SPECIFIC GUIDELINES:

FOR DIAGRAMS (scientific_diagram):
- Clear process flows with arrows
- Labeled components
- Logical spatial organization
- Standard scientific symbology

FOR MAPS (scientific_map):
- Include scale bar
- Include north arrow when relevant
- Include legend for all symbols/colors
- Use appropriate color schemes (elevation, temperature, etc.)
- Clean cartographic style

FOR CHARTS (scientific_chart):
- Clear axis labels with units
- Appropriate data visualization
- Legend when multiple data series
- Grid lines if helpful for reading values

OUTPUT STYLE:
- Vector-like clean lines
- Consistent line weights
- Professional typography
- Minimal but effective use of color`

/**
 * Feature flags for image generation
 */
export interface FeatureFlags {
  maintainCharacterConsistency?: boolean
  blendImages?: boolean
  useWorldKnowledge?: boolean
  useGoogleSearch?: boolean
  figureStyle?: 'scientific_diagram' | 'scientific_map' | 'scientific_chart'
  editMode?: 'strict' | 'creative'
}

/**
 * Result of structured prompt generation
 */
export interface StructuredPromptResult {
  originalPrompt: string
  structuredPrompt: string
  selectedPractices: string[]
}

/**
 * Interface for structured prompt generation
 */
export interface StructuredPromptGenerator {
  generateStructuredPrompt(
    userPrompt: string,
    features?: FeatureFlags,
    inputImageData?: string // Optional base64-encoded image for context
  ): Promise<Result<StructuredPromptResult, Error>>
}

/**
 * Implementation of StructuredPromptGenerator using Gemini 2.0 Flash
 */
export class StructuredPromptGeneratorImpl implements StructuredPromptGenerator {
  constructor(private readonly geminiTextClient: GeminiTextClient) {}

  async generateStructuredPrompt(
    userPrompt: string,
    features: FeatureFlags = {},
    inputImageData?: string
  ): Promise<Result<StructuredPromptResult, Error>> {
    try {
      // Validate input
      if (!userPrompt || userPrompt.trim().length === 0) {
        return Err(new GeminiAPIError('User prompt cannot be empty'))
      }

      // Build complete prompt with system instruction and meta-prompt
      const completePrompt = this.buildCompletePrompt(userPrompt, features, !!inputImageData)

      // Build system instruction based on mode
      let systemInstruction = features.figureStyle
        ? SCIENTIFIC_FIGURE_PROMPT
        : SYSTEM_PROMPT

      // Add editing context if input image is provided
      if (inputImageData) {
        systemInstruction += features.editMode === 'strict'
          ? STRICT_EDITING_CONTEXT
          : IMAGE_EDITING_CONTEXT
      }

      // Generate structured prompt using Gemini 2.0 Flash via pure API call
      const config = {
        temperature: 0.7,
        maxTokens: 2000,
        systemInstruction,
        ...(inputImageData && { inputImage: inputImageData }), // Only include if available
      }
      const result = await this.geminiTextClient.generateText(completePrompt, config)

      if (!result.success) {
        return Err(result.error)
      }

      // Extract selected practices from the response
      const selectedPractices = this.inferSelectedPractices(result.data, features)

      return Ok({
        originalPrompt: userPrompt,
        structuredPrompt: result.data,
        selectedPractices,
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      return Err(new GeminiAPIError(`Failed to generate structured prompt: ${errorMessage}`))
    }
  }

  /**
   * Build complete prompt with all optimization context
   */
  private buildCompletePrompt(
    userPrompt: string,
    features: FeatureFlags,
    hasInputImage: boolean
  ): string {
    const featureContext = this.buildEnhancedFeatureContext(features)

    // Scientific figure mode - different prompt structure
    if (features.figureStyle) {
      return this.buildScientificPrompt(userPrompt, features, hasInputImage)
    }

    // Add image editing context if an input image is provided
    const imageEditingInstruction = hasInputImage
      ? features.editMode === 'strict'
        ? `\n⚠️ ULTRA-STRICT EDIT MODE: An input image has been provided. You MUST:
- Output a prompt that starts with "IMPORTANT: Modify ONLY [specific change requested] while keeping EVERYTHING else EXACTLY as it appears."
- Explicitly list what must NOT change: background, colors, lighting, shadows, positions, sizes, textures, style
- Forbid any enhancement, artistic interpretation, or "improvement"
- The prompt must make clear that ONLY the user's specific request should change - nothing else.\n`
        : `\nNOTE: An input image has been provided. Focus on preserving its original characteristics while applying the requested modifications. Maintain consistency with the source image's style, colors, and atmosphere.\n`
      : ''

    return `Transform this image generation request into a detailed, vivid prompt that will produce high-quality results:

"${userPrompt}"
${imageEditingInstruction}
${featureContext}

Consider these aspects as you enhance the prompt:
- Visual details: textures, lighting, colors, materials, composition
- Spatial relationships and scale between elements
- Artistic or photographic style that fits the subject
- Emotional tone and atmosphere
- Technical specifications if relevant (lens type, camera angle, etc.)

Create a natural, flowing description that brings the scene to life. Focus on what should be present rather than what should be absent.

Example of a well-enhanced prompt:
Input: "A happy dog in a park"
Enhanced: "Golden retriever mid-leap catching a red frisbee, ears flying, tongue out in joy, in a sunlit urban park. Soft morning light filtering through oak trees creates dappled shadows on emerald grass. Background shows families on picnic blankets, slightly out of focus. Shot from low angle emphasizing the dog's athletic movement, with motion blur on the paws suggesting speed."

Now transform the user's request with similar attention to detail and creative enhancement.`
  }

  /**
   * Build prompt specifically for scientific figures
   */
  private buildScientificPrompt(
    userPrompt: string,
    features: FeatureFlags,
    hasInputImage: boolean
  ): string {
    const figureTypeDescription = {
      scientific_diagram: 'a scientific diagram showing processes, concepts, or relationships',
      scientific_map: 'a scientific map with proper cartographic elements (scale, north arrow, legend)',
      scientific_chart: 'a scientific chart or data visualization with clear axes and labels',
    }

    const typeDesc = features.figureStyle
      ? figureTypeDescription[features.figureStyle]
      : 'a scientific illustration'

    // Strict editing instruction for scientific images
    const editingInstruction = hasInputImage
      ? features.editMode === 'strict'
        ? `\n⚠️ ULTRA-STRICT SCIENTIFIC EDITING: An input image is provided.
ABSOLUTE REQUIREMENTS:
- Modify ONLY the exact element specified in the request
- DO NOT change: background color, axis labels, legend positions, font sizes, line styles, colors of other elements, grid lines, scale, data points not mentioned
- DO NOT "improve" or "enhance" anything
- DO NOT add artistic effects
- Preserve EXACT pixel positions of all unchanged elements
- Output a prompt that explicitly forbids changing anything except what was requested\n`
        : `\nEDITING: An input image is provided. Maintain the scientific style and accuracy while applying the requested changes.\n`
      : ''

    return `Create ${typeDesc} for a high-impact scientific publication (Nature, Science quality).

REQUEST: "${userPrompt}"
${editingInstruction}
REQUIREMENTS:
- Clean white or neutral background
- High contrast, publication-ready colors
- Clear labels and annotations where needed
- Professional technical illustration style
- No decorative or artistic embellishments
- Suitable for print in academic journals

${features.figureStyle === 'scientific_map' ? `MAP ELEMENTS: Include scale bar, north arrow if relevant, and legend for any symbols or color coding.` : ''}
${features.figureStyle === 'scientific_chart' ? `CHART ELEMENTS: Include clear axis labels with units, legend if multiple data series, appropriate grid lines.` : ''}
${features.figureStyle === 'scientific_diagram' ? `DIAGRAM ELEMENTS: Use clear arrows for flow/relationships, label all components, maintain logical spatial organization.` : ''}

Transform this request into a precise, technical description that will produce a publication-quality scientific figure.`
  }

  /**
   * Build enhanced feature context based on flags with explicit requirements
   */
  private buildEnhancedFeatureContext(features: FeatureFlags): string {
    const requirements: string[] = []

    if (features.maintainCharacterConsistency) {
      requirements.push(
        'Character consistency is CRITICAL - MUST include distinctive character features: This character needs at least 3 recognizable visual markers that would identify them across different scenes. Include specific details like "distinctive scar", "signature clothing item", "unique hairstyle", or "characteristic accessory". Use words like "signature", "distinctive", "always wears/has" to emphasize these consistent features.'
      )
    }

    if (features.blendImages) {
      requirements.push(
        'MUST describe seamless integration: Multiple visual elements need to blend naturally. Use spatial relationship terms like "seamlessly blending", "harmoniously composed", "naturally integrated". Clearly describe foreground (X% of frame), midground, and background elements with their relative scales and how they interact within the composition.'
      )
    }

    if (features.useWorldKnowledge) {
      requirements.push(
        'Apply accurate real-world knowledge - MUST incorporate authentic details: Apply accurate real-world knowledge about cultures, locations, or historical elements. Use specific terminology like "traditional [culture] style", "authentic [location] architecture", "typical of [region]", "historically accurate [period]". Be precise about cultural elements, geographical features, and factual details.'
      )
    }

    if (requirements.length > 0) {
      return `\nMANDATORY REQUIREMENTS - These MUST be clearly reflected in your enhanced prompt:\n\n${requirements.join('\n\n')}\n`
    }

    return ''
  }

  /**
   * Infer which best practices were selected based on the generated prompt
   */
  private inferSelectedPractices(structuredPrompt: string, features: FeatureFlags): string[] {
    const selected: string[] = []
    const promptLower = structuredPrompt.toLowerCase()

    // Check for detailed visual descriptions
    if (
      promptLower.includes('lighting') ||
      promptLower.includes('texture') ||
      promptLower.includes('atmosphere') ||
      promptLower.includes('shadow') ||
      promptLower.includes('material')
    ) {
      selected.push('Hyper-Specific Details')
    }

    // Check for character consistency markers
    if (
      features.maintainCharacterConsistency ||
      promptLower.includes('distinctive') ||
      promptLower.includes('signature') ||
      promptLower.includes('characteristic') ||
      promptLower.includes('always wears') ||
      promptLower.includes('always has')
    ) {
      selected.push('Character Consistency')
    }

    // Check for multi-element blending
    if (
      features.blendImages ||
      promptLower.includes('seamlessly') ||
      promptLower.includes('harmoniously') ||
      promptLower.includes('naturally integrated') ||
      promptLower.includes('foreground') ||
      promptLower.includes('midground') ||
      promptLower.includes('background')
    ) {
      selected.push('Compositional Integration')
    }

    // Check for world knowledge application
    if (
      features.useWorldKnowledge ||
      promptLower.includes('authentic') ||
      promptLower.includes('traditional') ||
      promptLower.includes('typical of') ||
      promptLower.includes('historically accurate') ||
      promptLower.includes('culturally')
    ) {
      selected.push('Real-World Accuracy')
    }

    // Check for photographic/artistic terminology
    if (
      promptLower.includes('lens') ||
      promptLower.includes('aperture') ||
      promptLower.includes('f/') ||
      promptLower.includes('mm ') ||
      promptLower.includes('angle') ||
      promptLower.includes('shot') ||
      promptLower.includes('depth of field')
    ) {
      selected.push('Camera Control Terminology')
    }

    // Check for atmospheric and mood enhancement
    if (
      promptLower.includes('mood') ||
      promptLower.includes('emotion') ||
      promptLower.includes('feeling') ||
      promptLower.includes('ambiance')
    ) {
      selected.push('Atmospheric Enhancement')
    }

    // Ensure we have at least some practices selected
    if (selected.length === 0) {
      selected.push('General Enhancement')
    }

    return selected
  }
}

/**
 * Factory function to create StructuredPromptGenerator
 */
export function createStructuredPromptGenerator(
  geminiTextClient: GeminiTextClient
): StructuredPromptGenerator {
  return new StructuredPromptGeneratorImpl(geminiTextClient)
}
