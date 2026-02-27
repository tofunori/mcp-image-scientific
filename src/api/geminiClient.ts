/**
 * Gemini API client for image generation
 * Integrates with Google's Gemini AI API using the official SDK
 * Supports automatic URL Context processing and feature parameters
 */

import { GoogleGenAI } from '@google/genai'
import type { Result } from '../types/result'
import { Err, Ok } from '../types/result'
import type { Config } from '../utils/config'
import { GeminiAPIError, NetworkError } from '../utils/errors'

/**
 * Simplified Gemini API response types
 */

interface ContentPart {
  inlineData?: {
    data: string
    mimeType: string
  }
  text?: string
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: ContentPart[]
    }
    finishReason?: string
  }>
  modelVersion?: string
  responseId?: string
  sdkHttpResponse?: unknown
  usageMetadata?: unknown
}

interface GeminiClientInstance {
  models: {
    generateContent(params: {
      model: string
      contents: unknown[] | string
      systemInstruction?: string
      generationConfig?: {
        [key: string]: unknown
      }
      config?: {
        imageConfig?: {
          aspectRatio?: string
        }
        responseModalities?: string[]
      }
    }): Promise<unknown> // Response is unknown, we'll validate with type guards
  }
}

/**
 * Safely analyze response structure for debugging (removes sensitive data)
 */
function analyzeResponseStructure(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') {
    return { type: typeof obj, value: obj }
  }

  const seen = new WeakSet()

  const sanitize = (value: unknown, depth = 0): unknown => {
    if (depth > 3) return '[max depth]'

    if (value === null || value === undefined) return value
    if (typeof value !== 'object')
      return typeof value === 'string' && value.length > 100
        ? `[string length: ${value.length}]`
        : value

    if (seen.has(value)) return '[circular]'
    seen.add(value)

    if (Array.isArray(value)) {
      return value.slice(0, 3).map((v) => sanitize(v, depth + 1))
    }

    const record = value as Record<string, unknown>
    const result: Record<string, unknown> = {}

    for (const [key, val] of Object.entries(record)) {
      // Skip sensitive keys
      if (/apikey|token|secret|password|credential/i.test(key)) {
        result[key] = '[REDACTED]'
      } else if (key === 'data' && typeof val === 'string' && val.length > 100) {
        // Likely base64 image data
        result[key] = `[base64 data, length: ${val.length}]`
      } else {
        result[key] = sanitize(val, depth + 1)
      }
    }

    return result
  }

  return sanitize(obj) as Record<string, unknown>
}

/**
 * Type guard for Gemini response validation
 */
function isGeminiResponse(obj: unknown): obj is GeminiResponse {
  if (!obj || typeof obj !== 'object') return false
  const response = obj as Record<string, unknown>

  // Check if it has response property (wrapped response)
  if ('response' in response && response['response'] && typeof response['response'] === 'object') {
    const innerResponse = response['response'] as Record<string, unknown>
    return 'candidates' in innerResponse && Array.isArray(innerResponse['candidates'])
  }

  // Check direct candidates property (direct response)
  return 'candidates' in response && Array.isArray(response['candidates'])
}

interface ErrorWithCode extends Error {
  code?: string
}

/**
 * Metadata for generated images
 */
export interface GeminiGenerationMetadata {
  model: string
  prompt: string
  mimeType: string
  timestamp: Date
  inputImageProvided: boolean
  // Additional metadata from flat structure responses
  modelVersion?: string
  responseId?: string
}

/**
 * Parameters for Gemini API image generation
 */
export interface GeminiApiParams {
  prompt: string
  inputImage?: string
  inputImageMimeType?: string
  aspectRatio?: string
  imageSize?: string
  useGoogleSearch?: boolean
  editMode?: 'strict' | 'creative'
  figureStyle?: 'scientific_diagram' | 'scientific_map' | 'scientific_chart'
}

/**
 * Base quality instructions applied to ALL image generations
 * Professional scientific illustrator standards
 */
const BASE_QUALITY_INSTRUCTIONS = `[PROFESSIONAL SCIENTIFIC ILLUSTRATOR MODE]
You are a world-class scientific illustrator with expertise in creating modern, publication-quality figures.

QUALITY STANDARDS:
- Produce illustrations of the highest professional quality
- Clean, precise linework with consistent stroke weights
- Accurate proportions and spatial relationships
- Harmonious, scientifically appropriate color palettes
- Crystal-clear typography and labeling
- Meticulous attention to detail
- Publication-ready output (Nature, Science journal standards)

MODERN VISUAL STYLE:
- Contemporary, cutting-edge scientific illustration aesthetic
- Use 3D rendering and perspective when it enhances understanding
- Subtle depth, shadows, and lighting for visual impact
- Modern color gradients and palettes (when scientifically appropriate)
- Avoid outdated or flat clip-art styles
- Embrace photorealistic elements when relevant (terrain, ice, water, etc.)

TECHNICAL EXCELLENCE:
- Sharp, crisp edges with no artifacts
- Proper visual hierarchy and composition
- Balanced use of negative space
- Professional rendering of textures and materials
- Accurate representation of scientific concepts

SPELLING & ACCURACY:
- Double-check ALL text, labels, and annotations for spelling errors
- Verify scientific terminology is correct
- Ensure numerical values and units are accurate

`

/**
 * Base instructions for scientific figures (applied regardless of SKIP_PROMPT_ENHANCEMENT)
 * Specialized for Earth Sciences: geography, glaciology, remote sensing, geomatics
 * PhD/doctoral publication standards
 */
const SCIENTIFIC_BASE_INSTRUCTIONS: Record<string, string> = {
  scientific_diagram: `[SCIENTIFIC DIAGRAM MODE - Earth Sciences]
DOMAIN: Geography, Glaciology, Remote Sensing, Geomatics
PUBLICATION LEVEL: Doctoral thesis, Nature, Science, The Cryosphere, JGR quality

REQUIREMENTS:
- Clean white or neutral background (no gradients, no artistic effects)
- Clear, legible labels and text with professional typography (sans-serif preferred)
- High contrast colors for readability, colorblind-friendly palette
- Double-check ALL text for spelling errors - scientific credibility depends on this
- Clear process flows with arrows and labeled components
- Standard scientific symbology (ISO/cartographic conventions)
- Vector-like clean lines, consistent line weights
- Appropriate for peer-reviewed journal submission

EARTH SCIENCE SPECIFICS:
- Use SI units consistently (m, km, °C, W/m², etc.)
- Include temporal references when relevant (dates, periods, seasons)
- Follow glaciological/geoscience notation standards

USER REQUEST: `,

  scientific_map: `[SCIENTIFIC MAP MODE - Earth Sciences/Cartography]
DOMAIN: Geography, Glaciology, Remote Sensing, Geomatics
PUBLICATION LEVEL: Doctoral thesis, Nature, Science, The Cryosphere, JGR quality

REQUIREMENTS:
- Clean white or neutral background
- MANDATORY: Include scale bar (metric units: m or km)
- MANDATORY: Include north arrow (standard cartographic symbol)
- Include legend only if explicitly requested
- MANDATORY: Projection/coordinate system reference if relevant
- Clear, legible labels with professional typography
- High contrast colors, colorblind-friendly color schemes
- Double-check ALL text for spelling errors (place names, labels)
- Clean cartographic style following ISO/ICA standards

EARTH SCIENCE SPECIFICS:
- Appropriate color ramps for elevation, temperature, albedo, etc.
- Contour lines with proper intervals if showing topography
- Ice/snow/glacier features using standard glaciological symbology
- Remote sensing imagery: include acquisition date, sensor, bands info
- Coordinate grid or graticule when appropriate

USER REQUEST: `,

  scientific_chart: `[SCIENTIFIC CHART MODE - Earth Sciences Data]
DOMAIN: Geography, Glaciology, Remote Sensing, Geomatics
PUBLICATION LEVEL: Doctoral thesis, Nature, Science, The Cryosphere, JGR quality

REQUIREMENTS:
- Clean white or neutral background (no gradients)
- MANDATORY: Clear axis labels with SI units (°C, m, km², W/m², etc.)
- MANDATORY: Legend when multiple data series
- MANDATORY: Error bars or uncertainty indication when showing measured data
- Grid lines if helpful for reading values
- Clear, legible text with professional typography (sans-serif)
- High contrast colors, colorblind-friendly palette
- Double-check ALL text for spelling errors

EARTH SCIENCE SPECIFICS:
- Time series: proper date formatting on x-axis, temporal resolution indicated
- Scatter plots: include R², p-value, regression equation when relevant
- Box plots/histograms: indicate sample size (n)
- Remote sensing data: indicate sensor, spectral bands, acquisition period
- Glaciological data: follow WGMS conventions for mass balance plots

USER REQUEST: `,
}

/**
 * Result of image generation
 */
export interface GeneratedImageResult {
  imageData: Buffer
  metadata: GeminiGenerationMetadata
}

/**
 * Gemini API client interface
 */
export interface GeminiClient {
  generateImage(
    params: GeminiApiParams
  ): Promise<Result<GeneratedImageResult, GeminiAPIError | NetworkError>>
}

/**
 * Implementation of Gemini API client
 */
class GeminiClientImpl implements GeminiClient {
  private readonly modelName = 'gemini-3.1-flash-image-preview'

  constructor(private readonly genai: GeminiClientInstance) {}

  async generateImage(
    params: GeminiApiParams
  ): Promise<Result<GeneratedImageResult, GeminiAPIError | NetworkError>> {
    try {
      // Prepare the request content with proper structure for multimodal input
      const requestContent: unknown[] = []

      // Build the final prompt with base instructions (applied regardless of SKIP_PROMPT_ENHANCEMENT)
      // 1. ALWAYS start with professional quality instructions
      let finalPrompt = BASE_QUALITY_INSTRUCTIONS + params.prompt

      // 2. Add scientific figure instructions if figureStyle is specified
      if (params.figureStyle && SCIENTIFIC_BASE_INSTRUCTIONS[params.figureStyle]) {
        finalPrompt = BASE_QUALITY_INSTRUCTIONS + SCIENTIFIC_BASE_INSTRUCTIONS[params.figureStyle] + params.prompt
      }

      // 3. Add strict preservation prefix for edit mode (can combine with scientific instructions)
      if (params.inputImage && params.editMode === 'strict') {
        // Add explicit preservation instructions directly to the prompt sent to Gemini 3 Pro Image
        const strictPrefix = `[STRICT EDIT MODE - PRESERVE ORIGINAL]
CRITICAL INSTRUCTION: Make ONLY the specific change described below. Do NOT modify anything else.
- DO NOT change the background, colors, lighting, shadows, or atmosphere
- DO NOT move, resize, or alter any element not explicitly mentioned
- DO NOT enhance, improve, or "fix" anything
- DO NOT add artistic interpretation or effects
- PRESERVE exact positions, sizes, and appearance of all unchanged elements

REQUESTED CHANGE: `
        const strictSuffix = `

REMINDER: Change ONLY what was requested above. Everything else must remain EXACTLY as in the original image.`
        finalPrompt = strictPrefix + finalPrompt + strictSuffix
      }

      // Structure the contents properly for image generation/editing
      if (params.inputImage) {
        // For image editing: provide image first, then text instructions
        requestContent.push({
          parts: [
            {
              inlineData: {
                data: params.inputImage,
                mimeType: params.inputImageMimeType || 'image/png',
              },
            },
            {
              text: finalPrompt,
            },
          ],
        })
      } else {
        // For text-to-image: provide only text prompt (with any base instructions applied)
        requestContent.push({
          parts: [
            {
              text: finalPrompt,
            },
          ],
        })
      }

      // Construct config object for generateContent
      const imageConfig: Record<string, string> = {}
      if (params.aspectRatio) {
        imageConfig['aspectRatio'] = params.aspectRatio
      }
      if (params.imageSize) {
        imageConfig['imageSize'] = params.imageSize
      }

      const config =
        Object.keys(imageConfig).length > 0
          ? {
              imageConfig,
              responseModalities: ['IMAGE'],
            }
          : {
              responseModalities: ['IMAGE'],
            }

      // Construct tools array for Google Search grounding
      const tools = params.useGoogleSearch ? [{ googleSearch: {} }] : undefined

      // Generate content using Gemini API (@google/genai v1.17.0+)
      const rawResponse = await this.genai.models.generateContent({
        model: this.modelName,
        contents: requestContent,
        config,
        ...(tools && { tools }),
      })

      // Validate response structure with type guard
      if (!isGeminiResponse(rawResponse)) {
        const responseStructure = analyzeResponseStructure(rawResponse)

        // Check if it's an error response from Gemini
        const asRecord = rawResponse as Record<string, unknown>
        if (asRecord['error']) {
          const error = asRecord['error'] as Record<string, unknown>
          return Err(
            new GeminiAPIError(`Gemini API Error: ${error['message'] || 'Unknown error'}`, {
              code: error['code'],
              status: error['status'],
              details: error['details'] || responseStructure,
              stage: 'api_error',
            })
          )
        }

        return Err(
          new GeminiAPIError('Invalid response structure from Gemini API', {
            message: 'The API returned an unexpected response format',
            responseStructure: responseStructure,
            stage: 'response_validation',
            suggestion: 'Check if the API endpoint or model configuration is correct',
          })
        )
      }

      // Extract the actual response data (handle wrapped responses)
      const responseData = (rawResponse as Record<string, unknown>)['response']
        ? ((rawResponse as Record<string, unknown>)['response'] as GeminiResponse)
        : (rawResponse as GeminiResponse)

      // Check for prompt feedback (safety blocking)
      const responseAsRecord = responseData as Record<string, unknown>
      if (responseAsRecord['promptFeedback']) {
        const promptFeedback = responseAsRecord['promptFeedback'] as Record<string, unknown>
        if (promptFeedback['blockReason'] === 'SAFETY') {
          return Err(
            new GeminiAPIError('Image generation blocked for safety reasons', {
              stage: 'prompt_analysis',
              blockReason: promptFeedback['blockReason'],
              suggestion: 'Rephrase your prompt to avoid potentially sensitive content',
            })
          )
        }
        if (
          promptFeedback['blockReason'] === 'OTHER' ||
          promptFeedback['blockReason'] === 'PROHIBITED_CONTENT'
        ) {
          return Err(
            new GeminiAPIError('Image generation blocked due to prohibited content', {
              stage: 'prompt_analysis',
              blockReason: promptFeedback['blockReason'],
              suggestion: 'Remove any prohibited content from your prompt and try again',
            })
          )
        }
      }

      // Check for candidates
      if (!responseData.candidates || responseData.candidates.length === 0) {
        return Err(
          new GeminiAPIError('No image generated: Content may have been filtered', {
            stage: 'generation',
            candidatesCount: 0,
            suggestion: 'Try rephrasing your prompt to avoid potentially sensitive content',
          })
        )
      }

      const candidate = responseData.candidates[0]
      if (!candidate || !candidate.content || !candidate.content.parts) {
        return Err(
          new GeminiAPIError('No valid content in response', {
            stage: 'candidate_extraction',
            suggestion: 'The API response was incomplete. Please try again',
          })
        )
      }

      const parts = candidate.content.parts

      // Handle finish reason specific errors before checking parts
      if (candidate.finishReason) {
        const finishReason = candidate.finishReason

        if (finishReason === 'IMAGE_SAFETY') {
          return Err(
            new GeminiAPIError('Image generation stopped for safety reasons', {
              finishReason,
              stage: 'generation_stopped',
              suggestion: 'Modify your prompt to avoid potentially sensitive content',
              safetyRatings: (candidate as Record<string, unknown>)['safetyRatings']
                ? (
                    (candidate as Record<string, unknown>)['safetyRatings'] as Record<
                      string,
                      unknown
                    >[]
                  )
                    ?.map((rating: Record<string, unknown>) => {
                      const category = (rating['category'] as string)
                        .replace('HARM_CATEGORY_', '')
                        .split('_')
                        .map((word: string) => word.charAt(0) + word.slice(1).toLowerCase())
                        .join(' ')
                      return `${category} (${rating['blocked'] ? 'BLOCKED' : 'ALLOWED'})`
                    })
                    .join(', ')
                : undefined,
            })
          )
        }

        if (finishReason === 'MAX_TOKENS') {
          return Err(
            new GeminiAPIError('Maximum token limit reached during generation', {
              finishReason,
              stage: 'generation_stopped',
              suggestion: 'Try using a shorter or simpler prompt',
            })
          )
        }
      }

      if (parts.length === 0) {
        return Err(
          new GeminiAPIError('No content parts in response', {
            stage: 'content_extraction',
            suggestion: 'The generation was incomplete. Please try again',
          })
        )
      }

      // Check if we got an image or text (error message)
      const imagePart = parts.find((part) => part.inlineData?.data)
      const textPart = parts.find((part) => part.text)

      if (!imagePart?.inlineData) {
        // If there's text, it's likely an error message from Gemini
        const errorMessage = textPart?.text || 'Image generation failed'

        return Err(
          new GeminiAPIError('Image generation failed due to content filtering', {
            reason: errorMessage,
            stage: 'image_extraction',
            suggestion:
              'The prompt was blocked by safety filters. Try rephrasing your prompt to avoid potentially sensitive content.',
          })
        )
      }

      // Convert base64 image data to Buffer
      const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64')
      const mimeType = imagePart.inlineData.mimeType || 'image/png'

      // Create metadata
      const metadata: GeminiGenerationMetadata = {
        model: this.modelName,
        prompt: params.prompt,
        mimeType,
        timestamp: new Date(),
        inputImageProvided: !!params.inputImage,
        ...(responseData.modelVersion && { modelVersion: responseData.modelVersion }),
        ...(responseData.responseId && { responseId: responseData.responseId }),
      }

      return Ok({
        imageData: imageBuffer,
        metadata,
      })
    } catch (error) {
      return this.handleError(error, params.prompt)
    }
  }

  private handleError(
    error: unknown,
    prompt: string
  ): Result<never, GeminiAPIError | NetworkError> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'

    // Check if it's a network error
    if (this.isNetworkError(error)) {
      return Err(
        new NetworkError(
          `Network error during image generation: ${errorMessage}`,
          'Check your internet connection and try again',
          error instanceof Error ? error : undefined
        )
      )
    }

    // Check if it's an API-specific error
    if (this.isAPIError(error)) {
      return Err(
        new GeminiAPIError(
          `Failed to generate image: ${errorMessage}`,
          this.getAPIErrorSuggestion(errorMessage),
          this.extractStatusCode(error)
        )
      )
    }

    // Generic API error
    return Err(
      new GeminiAPIError(
        `Failed to generate image with prompt "${prompt}": ${errorMessage}`,
        'Check your API key, quota, and prompt validity. Try again with a different prompt'
      )
    )
  }

  private isNetworkError(error: unknown): boolean {
    if (error instanceof Error) {
      const networkErrorCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']
      return networkErrorCodes.some(
        (code) => error.message.includes(code) || (error as ErrorWithCode).code === code
      )
    }
    return false
  }

  private isAPIError(error: unknown): boolean {
    if (error instanceof Error) {
      const apiErrorKeywords = ['quota', 'rate limit', 'unauthorized', 'forbidden', 'api key']
      return apiErrorKeywords.some((keyword) => error.message.toLowerCase().includes(keyword))
    }
    return false
  }

  private getAPIErrorSuggestion(errorMessage: string): string {
    const lowerMessage = errorMessage.toLowerCase()

    if (lowerMessage.includes('quota') || lowerMessage.includes('rate limit')) {
      return 'You have exceeded your API quota or rate limit. Wait before making more requests or upgrade your plan'
    }

    if (lowerMessage.includes('unauthorized') || lowerMessage.includes('api key')) {
      return 'Check that your GEMINI_API_KEY is valid and has the necessary permissions'
    }

    if (lowerMessage.includes('forbidden')) {
      return 'Your API key does not have permission for this operation'
    }

    return 'Check your API configuration and try again'
  }

  private extractStatusCode(error: unknown): number | undefined {
    if (error && typeof error === 'object' && 'status' in error) {
      return typeof error.status === 'number' ? error.status : undefined
    }
    return undefined
  }
}

/**
 * Creates a new Gemini API client
 * @param config Configuration containing API key and other settings
 * @returns Result containing the client or an error
 */
export function createGeminiClient(config: Config): Result<GeminiClient, GeminiAPIError> {
  try {
    const genai = new GoogleGenAI({
      apiKey: config.geminiApiKey,
    }) as unknown as GeminiClientInstance
    return Ok(new GeminiClientImpl(genai))
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return Err(
      new GeminiAPIError(
        `Failed to initialize Gemini client: ${errorMessage}`,
        'Verify your GEMINI_API_KEY is valid and the @google/genai package is properly installed'
      )
    )
  }
}
