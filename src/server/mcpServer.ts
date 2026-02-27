/**
 * MCP Server implementation
 * Simplified architecture with direct Gemini integration
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'

/**
 * Detect actual MIME type from image file magic bytes
 * @param buffer - Image file buffer
 * @returns Detected MIME type or undefined if unknown
 */
function detectMimeTypeFromMagicBytes(buffer: Buffer): string | undefined {
  if (buffer.length < 12) return undefined

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }

  // GIF: GIF87a or GIF89a
  if (
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return 'image/gif'
  }

  // BMP: BM
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp'
  }

  // WEBP: RIFF....WEBP
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp'
  }

  return undefined
}
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'

// Types
import type { GenerateImageParams, MCPServerConfig } from '../types/mcp'
import type { QaReport } from '../types/qa'

// Business logic
import { type FileManager, createFileManager } from '../business/fileManager'
import { validateGenerateImageParams } from '../business/inputValidator'
import { type ResponseBuilder, createResponseBuilder } from '../business/responseBuilder'
import {
  type ScientificQaValidator,
  buildRetryPatch,
  createScientificQaValidator,
} from '../business/scientificQaValidator'
import {
  type FeatureFlags,
  type StructuredPromptGenerator,
  createStructuredPromptGenerator,
} from '../business/structuredPromptGenerator'

// API clients
import { type GeminiClient, createGeminiClient } from '../api/geminiClient'
import { type GeminiTextClient, createGeminiTextClient } from '../api/geminiTextClient'

// Utilities
import { getConfig } from '../utils/config'
import { Logger } from '../utils/logger'
import { SecurityManager } from '../utils/security'
import { ErrorHandler } from './errorHandler'

/**
 * Default MCP server configuration
 */
const DEFAULT_CONFIG: MCPServerConfig = {
  name: 'mcp-image-server',
  version: '0.1.0',
  defaultOutputDir: './output',
}

/**
 * Simplified MCP server
 */
export class MCPServerImpl {
  private config: MCPServerConfig
  private server: Server | null = null
  private logger: Logger
  private fileManager: FileManager
  private responseBuilder: ResponseBuilder
  private securityManager: SecurityManager
  private structuredPromptGenerator: StructuredPromptGenerator | null = null
  private geminiTextClient: GeminiTextClient | null = null
  private geminiClient: GeminiClient | null = null
  private qaValidator: ScientificQaValidator | null = null

  constructor(config: Partial<MCPServerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.logger = new Logger()
    this.fileManager = createFileManager()
    this.responseBuilder = createResponseBuilder()
    this.securityManager = new SecurityManager()
  }

  /**
   * Get server info
   */
  public getServerInfo() {
    return {
      name: this.config.name,
      version: this.config.version,
    }
  }

  /**
   * Get list of registered tools
   */
  public getToolsList() {
    return {
      tools: [
        {
          name: 'generate_image',
          description: 'Generate image with specified prompt and optional parameters',
          inputSchema: {
            type: 'object' as const,
            properties: {
              prompt: {
                type: 'string' as const,
                description:
                  'The prompt for image generation (English recommended for optimal structured prompt enhancement)',
              },
              fileName: {
                type: 'string' as const,
                description:
                  'Optional file name for the generated image (if not specified, generates an auto-named file in IMAGE_OUTPUT_DIR)',
              },
              inputImagePath: {
                type: 'string' as const,
                description:
                  'Optional absolute path to source image for image-to-image generation. Use when generating variations, style transfers, or similar images based on an existing image (must be an absolute path)',
              },
              blendImages: {
                type: 'boolean' as const,
                description:
                  'Enable multi-image blending for combining multiple visual elements naturally. Use when prompt mentions multiple subjects or composite scenes',
              },
              maintainCharacterConsistency: {
                type: 'boolean' as const,
                description:
                  'Maintain character appearance consistency. Enable when generating same character in different poses/scenes',
              },
              useWorldKnowledge: {
                type: 'boolean' as const,
                description:
                  'Use real-world knowledge for accurate context. Enable for historical figures, landmarks, or factual scenarios',
              },
              useGoogleSearch: {
                type: 'boolean' as const,
                description:
                  "Enable Google Search grounding to access real-time web information for factually accurate image generation. Use when prompt requires current or time-sensitive data that may have changed since the model's knowledge cutoff. Leave disabled for creative, fictional, historical, or timeless content.",
              },
              aspectRatio: {
                type: 'string' as const,
                description: 'Aspect ratio for the generated image',
                enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
              },
              imageSize: {
                type: 'string' as const,
                description:
                  'Image resolution for high-quality output. Specify "2K" or "4K" when you need higher resolution images with better text rendering and fine details. Leave unspecified for standard quality.',
                enum: ['2K', '4K'],
              },
              figureStyle: {
                type: 'string' as const,
                description:
                  'Scientific figure style for publication-ready illustrations (Nature, Science quality). Use "scientific_diagram" for process/concept diagrams, "scientific_map" for maps with scale/legend/north arrow, "scientific_chart" for data visualizations with axes and labels.',
                enum: ['scientific_diagram', 'scientific_map', 'scientific_chart'],
              },
              editMode: {
                type: 'string' as const,
                description:
                  'Edit mode for image modification. Use "strict" to preserve everything exactly except the specific change requested (recommended for scientific figures). Use "creative" for artistic interpretation. Default is "creative".',
                enum: ['strict', 'creative'],
              },
              validateQa: {
                type: 'boolean' as const,
                description:
                  'Run QA validation on this generation. Evaluates the figure against publication-quality criteria (spelling, labels, legend, contrast). Requires figureStyle to be set.',
              },
            },
            required: ['prompt'],
          },
        },
      ],
    }
  }

  /**
   * Tool execution
   */
  public async callTool(name: string, args: unknown) {
    try {
      if (name === 'generate_image') {
        return await this.handleGenerateImage(args as GenerateImageParams)
      }
      throw new Error(`Unknown tool: ${name}`)
    } catch (error) {
      this.logger.error('mcp-server', 'Tool execution failed', error as Error)
      return ErrorHandler.handleError(error as Error)
    }
  }

  /**
   * Initialize Gemini clients lazily
   */
  private async initializeClients(): Promise<void> {
    if (this.structuredPromptGenerator && this.geminiClient) return

    const configResult = getConfig()
    if (!configResult.success) {
      throw configResult.error
    }

    // Initialize Gemini Text Client for prompt generation
    if (!this.geminiTextClient) {
      const textClientResult = createGeminiTextClient(configResult.data)
      if (!textClientResult.success) {
        throw textClientResult.error
      }
      this.geminiTextClient = textClientResult.data
    }

    // Initialize Structured Prompt Generator
    if (!this.structuredPromptGenerator) {
      this.structuredPromptGenerator = createStructuredPromptGenerator(this.geminiTextClient)
    }

    // Initialize Gemini Client for image generation
    if (!this.geminiClient) {
      const clientResult = createGeminiClient(configResult.data)
      if (!clientResult.success) {
        throw clientResult.error
      }
      this.geminiClient = clientResult.data
    }

    // Initialize QA Validator with dedicated Pro model for stricter evaluation
    if (!this.qaValidator && configResult.data.enableScientificQa) {
      const qaClientResult = createGeminiTextClient(
        configResult.data,
        configResult.data.scientificQaModel
      )
      if (qaClientResult.success) {
        this.qaValidator = createScientificQaValidator(qaClientResult.data)
        this.logger.info(
          'mcp-server',
          `QA validator initialized with ${configResult.data.scientificQaModel}`
        )
      } else {
        this.logger.warn('mcp-server', 'Failed to initialize QA validator', {
          error: qaClientResult.error.message,
        })
      }
    }

    this.logger.info('mcp-server', 'Gemini clients initialized')
  }

  /**
   * Get file extension from image data based on magic bytes
   */
  private getExtensionFromImageData(imageData: Buffer): string {
    if (imageData.length < 12) return '.png'

    // PNG: 89 50 4E 47
    if (
      imageData[0] === 0x89 &&
      imageData[1] === 0x50 &&
      imageData[2] === 0x4e &&
      imageData[3] === 0x47
    ) {
      return '.png'
    }

    // JPEG: FF D8 FF
    if (imageData[0] === 0xff && imageData[1] === 0xd8 && imageData[2] === 0xff) {
      return '.jpg'
    }

    // GIF: GIF87a or GIF89a
    if (
      imageData[0] === 0x47 &&
      imageData[1] === 0x49 &&
      imageData[2] === 0x46 &&
      imageData[3] === 0x38
    ) {
      return '.gif'
    }

    // WEBP: RIFF....WEBP
    if (
      imageData[0] === 0x52 &&
      imageData[1] === 0x49 &&
      imageData[2] === 0x46 &&
      imageData[3] === 0x46 &&
      imageData[8] === 0x57 &&
      imageData[9] === 0x45 &&
      imageData[10] === 0x42 &&
      imageData[11] === 0x50
    ) {
      return '.webp'
    }

    return '.png' // Default
  }

  /**
   * Simplified image generation handler
   */
  private async handleGenerateImage(params: GenerateImageParams) {
    const result = await ErrorHandler.wrapWithResultType(async () => {
      // Validate input
      const validationResult = validateGenerateImageParams(params)
      if (!validationResult.success) {
        throw validationResult.error
      }

      // Get configuration
      const configResult = getConfig()
      if (!configResult.success) {
        throw configResult.error
      }

      // Initialize clients
      await this.initializeClients()

      // Handle input image if provided
      let inputImageData: string | undefined
      let inputImageMimeType: string | undefined
      if (params.inputImagePath) {
        const imageBuffer = await fs.readFile(params.inputImagePath)
        inputImageData = imageBuffer.toString('base64')
        // Detect MIME type from magic bytes (actual file content)
        const detectedMimeType = detectMimeTypeFromMagicBytes(imageBuffer)
        if (detectedMimeType) {
          inputImageMimeType = detectedMimeType
          // Log warning if extension doesn't match actual format
          const ext = path.extname(params.inputImagePath).toLowerCase()
          const extensionMimeTypes: Record<string, string> = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
          }
          const expectedMimeType = extensionMimeTypes[ext]
          if (expectedMimeType && expectedMimeType !== detectedMimeType) {
            this.logger.warn('mcp-server', 'File extension mismatch', {
              path: params.inputImagePath,
              extension: ext,
              expectedMimeType,
              actualMimeType: detectedMimeType,
            })
          }
        } else {
          // Fallback to extension-based detection if magic bytes fail
          const ext = path.extname(params.inputImagePath).toLowerCase()
          const mimeTypes: Record<string, string> = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
          }
          inputImageMimeType = mimeTypes[ext] || 'image/png'
        }
      }

      // Generate structured prompt using Gemini 2.0 Flash (unless skipped)
      let structuredPrompt = params.prompt
      if (!configResult.data.skipPromptEnhancement && this.structuredPromptGenerator) {
        const features: FeatureFlags = {}
        if (params.maintainCharacterConsistency !== undefined) {
          features.maintainCharacterConsistency = params.maintainCharacterConsistency
        }
        if (params.blendImages !== undefined) {
          features.blendImages = params.blendImages
        }
        if (params.useWorldKnowledge !== undefined) {
          features.useWorldKnowledge = params.useWorldKnowledge
        }
        if (params.useGoogleSearch !== undefined) {
          features.useGoogleSearch = params.useGoogleSearch
        }
        if (params.figureStyle !== undefined) {
          features.figureStyle = params.figureStyle
        }
        if (params.editMode !== undefined) {
          features.editMode = params.editMode
        }

        const promptResult = await this.structuredPromptGenerator.generateStructuredPrompt(
          params.prompt,
          features,
          inputImageData // Pass image data for context-aware prompt generation
        )

        if (promptResult.success) {
          structuredPrompt = promptResult.data.structuredPrompt

          this.logger.info('mcp-server', 'Structured prompt generated', {
            originalLength: params.prompt.length,
            structuredLength: structuredPrompt.length,
            selectedPractices: promptResult.data.selectedPractices,
          })
        } else {
          this.logger.warn('mcp-server', 'Using original prompt', {
            error: promptResult.error.message,
          })
        }
      } else if (configResult.data.skipPromptEnhancement) {
        this.logger.info('mcp-server', 'Prompt enhancement skipped (SKIP_PROMPT_ENHANCEMENT=true)')
      }

      // Generate image using Gemini
      if (!this.geminiClient) {
        throw new Error('Gemini client not initialized')
      }

      // Initialize QA validator on-demand if validateQa is requested but QA was not globally enabled
      if (params.validateQa && !this.qaValidator && params.figureStyle) {
        const qaClientResult = createGeminiTextClient(
          configResult.data,
          configResult.data.scientificQaModel
        )
        if (qaClientResult.success) {
          this.qaValidator = createScientificQaValidator(qaClientResult.data)
          this.logger.info(
            'mcp-server',
            `QA validator initialized on-demand with ${configResult.data.scientificQaModel}`
          )
        }
      }

      // Determine if QA validation should run
      const qaEnabled =
        params.figureStyle !== undefined &&
        (configResult.data.enableScientificQa || params.validateQa === true) &&
        this.qaValidator !== null

      const maxAttempts = qaEnabled ? configResult.data.scientificQaMaxRetries + 1 : 1

      let currentPrompt = structuredPrompt
      let qaReport: QaReport | undefined
      let lastGenerationResult:
        | typeof undefined
        | Awaited<ReturnType<GeminiClient['generateImage']>> = undefined

      // Generation + QA retry loop
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const generationResult = await this.geminiClient.generateImage({
          prompt: currentPrompt,
          ...(inputImageData && { inputImage: inputImageData }),
          ...(inputImageMimeType && { inputImageMimeType }),
          ...(params.aspectRatio && { aspectRatio: params.aspectRatio }),
          ...(params.imageSize && { imageSize: params.imageSize }),
          ...(params.useGoogleSearch !== undefined && {
            useGoogleSearch: params.useGoogleSearch,
          }),
          ...(params.editMode && { editMode: params.editMode }),
          ...(params.figureStyle && { figureStyle: params.figureStyle }),
        })

        if (!generationResult.success) {
          throw generationResult.error
        }

        lastGenerationResult = generationResult

        // Run QA validation for scientific figures
        if (qaEnabled && this.qaValidator && params.figureStyle) {
          const qaStartTime = Date.now()
          try {
            const qaResult = await this.qaValidator.validate({
              imageData: generationResult.data.imageData,
              figureStyle: params.figureStyle,
              originalPrompt: params.prompt,
            })

            if (qaResult.success) {
              qaReport = {
                ...qaResult.data,
                attempts: attempt,
                evaluationTimeMs: Date.now() - qaStartTime,
              }

              this.logger.info('mcp-server', 'QA validation completed', {
                attempt,
                passed: qaReport.passed,
                score: qaReport.score,
                hardFailCount: qaReport.hardFailCount,
                figureStyle: params.figureStyle,
              })

              // If QA passed or this is the last attempt, stop retrying
              if (qaReport.passed || attempt === maxAttempts) {
                break
              }

              // Patch prompt for retry
              const patch = buildRetryPatch(qaReport.checks)
              if (patch) {
                currentPrompt = structuredPrompt + patch
                this.logger.info('mcp-server', `QA retry ${attempt}: patching prompt`, {
                  hardFailCount: qaReport.hardFailCount,
                  failedChecks: qaReport.checks
                    .filter((c) => c.status === 'fail' && c.severity === 'hard')
                    .map((c) => c.id),
                })
              } else {
                break // No patch needed
              }
            } else {
              this.logger.warn('mcp-server', 'QA validation returned error', {
                error: qaResult.error.message,
              })
              break // Don't retry on QA infrastructure errors
            }
          } catch (qaError) {
            this.logger.warn('mcp-server', 'QA validation error (non-blocking)', {
              error: qaError instanceof Error ? qaError.message : 'Unknown error',
            })
            break // Don't retry on QA infrastructure errors
          }
        } else {
          break // No QA, exit loop after first generation
        }
      }

      if (!lastGenerationResult || !lastGenerationResult.success) {
        throw new Error('Image generation failed')
      }

      // Save image file with correct extension based on actual image format
      let fileName: string
      if (params.fileName) {
        // User provided a filename - ensure extension matches actual image format
        const actualExtension = this.getExtensionFromImageData(lastGenerationResult.data.imageData)
        const baseName = params.fileName.replace(/\.[^/.]+$/, '') // Remove existing extension
        fileName = baseName + actualExtension

        // Warn if user's extension didn't match
        const userExtension = path.extname(params.fileName).toLowerCase()
        if (userExtension && userExtension !== actualExtension) {
          this.logger.warn('mcp-server', 'Filename extension corrected', {
            requested: params.fileName,
            actual: fileName,
            reason: `Gemini returned ${actualExtension} format`,
          })
        }
      } else {
        fileName = this.fileManager.generateFileName(lastGenerationResult.data.imageData)
      }
      const outputPath = path.join(configResult.data.imageOutputDir, fileName)

      const sanitizedPath = this.securityManager.sanitizeFilePath(outputPath)
      if (!sanitizedPath.success) {
        throw sanitizedPath.error
      }

      const saveResult = await this.fileManager.saveImage(
        lastGenerationResult.data.imageData,
        sanitizedPath.data
      )
      if (!saveResult.success) {
        throw saveResult.error
      }

      // Build response with QA metadata
      return this.responseBuilder.buildSuccessResponse(
        lastGenerationResult.data,
        saveResult.data,
        qaReport ? { qaReport } : undefined
      )
    }, 'image-generation')

    if (result.ok) {
      return result.value
    }

    return this.responseBuilder.buildErrorResponse(result.error)
  }

  /**
   * Initialize MCP server with tool handlers
   */
  public initialize(): Server {
    this.server = new Server(
      {
        name: this.config.name,
        version: this.config.version,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    )

    // Setup tool handlers
    this.setupHandlers()

    return this.server
  }

  /**
   * Setup MCP protocol handlers
   */
  private setupHandlers(): void {
    if (!this.server) {
      throw new Error('Server not initialized')
    }

    // Register tool list handler
    this.server.setRequestHandler(ListToolsRequestSchema, async (): Promise<ListToolsResult> => {
      return this.getToolsList()
    })

    // Register tool call handler
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request): Promise<CallToolResult> => {
        const { name, arguments: args } = request.params
        const result = await this.callTool(name, args)
        const response: CallToolResult = {
          content: result.content,
        }
        if (result.structuredContent) {
          response.structuredContent = result.structuredContent as { [x: string]: unknown }
        }
        return response
      }
    )
  }
}

/**
 * Factory function to create MCP server
 */
export function createMCPServer(config: Partial<MCPServerConfig> = {}) {
  return new MCPServerImpl(config)
}
