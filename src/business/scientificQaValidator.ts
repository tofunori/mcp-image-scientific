/**
 * Scientific QA Validator
 * Post-generation quality assurance for scientific figures
 * Uses Gemini 2.0 Flash as a multimodal evaluator to analyze generated images
 */

import type { GeminiTextClient } from '../api/geminiTextClient'
import type { FigureStyle } from '../types/mcp'
import type { QaCheck, QaCheckDefinition, QaReport } from '../types/qa'
import { getChecksForStyle } from '../types/qa'
import type { Result } from '../types/result'
import { Ok } from '../types/result'
import type { GeminiAPIError, NetworkError } from '../utils/errors'
import { Logger } from '../utils/logger'

const logger = new Logger()

/**
 * Parameters for QA validation
 */
export interface QaValidationParams {
  imageData: Buffer
  figureStyle: FigureStyle
  originalPrompt: string
}

/**
 * Scientific QA Validator interface
 */
export interface ScientificQaValidator {
  validate(params: QaValidationParams): Promise<Result<QaReport, GeminiAPIError | NetworkError>>
}

/**
 * System instruction for the QA evaluator
 */
const QA_SYSTEM_INSTRUCTION = `You are a strict scientific figure quality assessor for academic publications (Nature, Science, The Cryosphere quality).

Your role is to evaluate generated scientific images against specific quality criteria.
Be STRICT - publication quality demands perfection.

Pay SPECIAL ATTENTION to:
- Spelling errors in ANY language
- French accent marks: é, è, ê, ë, à, â, ù, û, ô, î, ï, ç (missing or incorrect accents are FAILURES)
- Text readability and legibility
- Mandatory cartographic/chart elements

ALWAYS respond with valid JSON only. No markdown formatting, no code fences, no explanatory text outside the JSON.`

/**
 * Build the evaluation prompt for a given figure style
 */
function buildEvaluationPrompt(figureStyle: FigureStyle, originalPrompt: string): string {
  const checks = getChecksForStyle(figureStyle)

  const checkList = checks
    .map(
      (c: QaCheckDefinition, i: number) => `${i + 1}. [${c.id}] (${c.severity}): ${c.instruction}`
    )
    .join('\n')

  return `Evaluate this scientific figure against the following quality criteria.

ORIGINAL REQUEST: "${originalPrompt}"
FIGURE TYPE: ${figureStyle}

EVALUATION CRITERIA:
${checkList}

RESPOND IN THIS EXACT JSON FORMAT:
{"checks":[{"id":"check_id","status":"pass","detail":"brief explanation"}]}

Rules:
- Evaluate ONLY what is visible in the image
- "pass" = criterion is clearly met
- "fail" = criterion is clearly NOT met
- "warning" = partially met or unclear
- Be concise in detail (max 20 words per check)
- Return ALL ${checks.length} checks listed above, in order
- Use the exact "id" values shown in brackets above`
}

/**
 * Parse the QA response from Gemini into a structured report
 */
function parseQaResponse(
  responseText: string,
  figureStyle: FigureStyle,
  checkDefinitions: QaCheckDefinition[]
): QaReport {
  // Strip markdown code fences if present
  const cleaned = responseText
    .replace(/```json?\n?/g, '')
    .replace(/```/g, '')
    .trim()

  // biome-ignore lint/suspicious/noExplicitAny: JSON.parse returns any
  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // If JSON parse fails, return all checks as skipped
    logger.warn('qa-validator', 'Failed to parse QA response as JSON', {
      responsePreview: responseText.substring(0, 200),
    })
    return buildSkippedReport(figureStyle, checkDefinitions)
  }

  // Validate parsed structure
  if (!parsed || !Array.isArray(parsed.checks)) {
    logger.warn('qa-validator', 'QA response missing checks array')
    return buildSkippedReport(figureStyle, checkDefinitions)
  }

  // Map check definitions to results
  const results: QaCheck[] = checkDefinitions.map((checkDef: QaCheckDefinition) => {
    const found = parsed.checks?.find((c: { id?: string }) => c?.id === checkDef.id)

    const status = found?.status
    const validStatus = status === 'pass' || status === 'fail' || status === 'warning'

    return {
      id: checkDef.id,
      name: checkDef.name,
      severity: checkDef.severity,
      status: validStatus ? status : ('skipped' as const),
      detail: typeof found?.detail === 'string' ? found.detail : undefined,
    }
  })

  return buildReportFromResults(results, figureStyle)
}

/**
 * Build a QaReport from check results
 */
function buildReportFromResults(checks: QaCheck[], figureStyle: FigureStyle): QaReport {
  const evaluatedChecks = checks.filter((r) => r.status !== 'skipped')
  const passedChecks = evaluatedChecks.filter((r) => r.status === 'pass')
  const hardFailures = checks.filter((r) => r.severity === 'hard' && r.status === 'fail')

  const score =
    evaluatedChecks.length > 0
      ? Math.round((passedChecks.length / evaluatedChecks.length) * 100) / 100
      : 0

  return {
    passed: hardFailures.length === 0,
    score,
    hardFailCount: hardFailures.length,
    checks,
    attempts: 1, // Will be updated by the caller for retries
    figureStyle,
    evaluationTimeMs: 0, // Will be set by the caller
  }
}

/**
 * Build a report where all checks are skipped (fallback for parse errors)
 */
function buildSkippedReport(
  figureStyle: FigureStyle,
  checkDefinitions: QaCheckDefinition[]
): QaReport {
  const checks: QaCheck[] = checkDefinitions.map((def) => ({
    id: def.id,
    name: def.name,
    severity: def.severity,
    status: 'skipped' as const,
    detail: 'QA evaluation could not be completed',
  }))

  return {
    passed: true, // Don't block on QA infrastructure failures
    score: 0,
    hardFailCount: 0,
    checks,
    attempts: 1,
    figureStyle,
    evaluationTimeMs: 0,
  }
}

/**
 * Remediation instructions for each check type
 */
const REMEDIATION_INSTRUCTIONS: Record<string, string> = {
  spelling:
    'CRITICAL FIX: There are spelling errors in the figure. Double-check and correct ALL text, labels, and annotations.',
  french_accents:
    'CRITICAL FIX: French accent marks are missing or incorrect. Ensure all French text has correct accents: é, è, ê, ë, à, â, ù, û, ô, î, ï, ç.',
  text_readable:
    'CRITICAL FIX: Some text is not readable. All text must be clearly visible, at a sufficient font size, with no overlapping.',
  clean_background:
    'CRITICAL FIX: The background must be clean white or neutral. Remove any gradients, artistic effects, or decorative elements.',
  contrast:
    'CRITICAL FIX: Insufficient contrast. Use dark text/lines on a light background for clear readability.',
  scale_bar:
    'MANDATORY ELEMENT MISSING: You MUST include a clearly visible scale bar with metric units (m or km) in the bottom-left or bottom-right corner.',
  north_arrow:
    'MANDATORY ELEMENT MISSING: You MUST include a clearly visible north arrow (standard cartographic symbol) in the top-right corner.',
  axis_labels:
    'MANDATORY ELEMENT MISSING: BOTH x-axis and y-axis MUST have clearly visible labels.',
  units_present:
    'MANDATORY ELEMENT MISSING: All axis labels MUST include appropriate SI units in parentheses (e.g., Temperature (°C), Distance (km)).',
  legend_if_multiple:
    'MANDATORY ELEMENT MISSING: You MUST include a legend that explains all data series, colors, and symbols.',
  components_labeled:
    'MANDATORY ELEMENT MISSING: ALL major components and elements in the diagram MUST be clearly labeled with text annotations.',
}

/**
 * Build a retry patch from failed QA checks
 * Returns additional instructions to append to the prompt for retry
 */
export function buildRetryPatch(failedChecks: QaCheck[]): string {
  const hardFailures = failedChecks.filter((c) => c.severity === 'hard' && c.status === 'fail')

  if (hardFailures.length === 0) {
    return ''
  }

  const remediations = hardFailures
    .map((f) => {
      const instruction = REMEDIATION_INSTRUCTIONS[f.id]
      const detail = f.detail ? ` (Issue found: ${f.detail})` : ''
      return instruction
        ? `- ${instruction}${detail}`
        : `- FIX REQUIRED for "${f.name}": ${f.detail || 'This element is mandatory.'}`
    })
    .join('\n')

  return `\n\n[CORRECTIONS OBLIGATOIRES - QA REMEDIATION]
The previous generation FAILED quality checks. You MUST address ALL of the following issues:
${remediations}

These fixes are MANDATORY for publication-quality scientific figures. Do not omit any of them.`
}

/**
 * Implementation of the Scientific QA Validator
 */
class ScientificQaValidatorImpl implements ScientificQaValidator {
  constructor(private readonly textClient: GeminiTextClient) {}

  async validate(
    params: QaValidationParams
  ): Promise<Result<QaReport, GeminiAPIError | NetworkError>> {
    const { imageData, figureStyle, originalPrompt } = params
    const checkDefinitions = getChecksForStyle(figureStyle)

    // Convert image buffer to base64
    const imageBase64 = imageData.toString('base64')

    // Build evaluation prompt
    const evaluationPrompt = buildEvaluationPrompt(figureStyle, originalPrompt)

    // Call Gemini 2.0 Flash with the image for multimodal evaluation
    const result = await this.textClient.generateText(evaluationPrompt, {
      temperature: 0.2,
      maxTokens: 4096,
      systemInstruction: QA_SYSTEM_INSTRUCTION,
      inputImage: imageBase64,
    })

    if (!result.success) {
      // QA failure should not block image delivery
      logger.warn('qa-validator', 'Gemini QA evaluation failed', {
        error: result.error.message,
        figureStyle,
      })
      return Ok(buildSkippedReport(figureStyle, checkDefinitions))
    }

    // Parse the response into a structured QA report
    const report = parseQaResponse(result.data, figureStyle, checkDefinitions)

    logger.info('qa-validator', 'QA evaluation completed', {
      figureStyle,
      passed: report.passed,
      score: report.score,
      hardFailCount: report.hardFailCount,
      totalChecks: report.checks.length,
    })

    return Ok(report)
  }
}

/**
 * Factory function to create a Scientific QA Validator
 */
export function createScientificQaValidator(textClient: GeminiTextClient): ScientificQaValidator {
  return new ScientificQaValidatorImpl(textClient)
}
