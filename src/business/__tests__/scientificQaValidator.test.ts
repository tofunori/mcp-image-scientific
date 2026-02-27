/**
 * Test suite for Scientific QA Validator
 * Tests post-generation quality assurance for scientific figures
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeminiTextClient } from '../../api/geminiTextClient'
import type { QaCheckDefinition } from '../../types/qa'
import {
  CHART_CHECKS,
  COMMON_CHECKS,
  DIAGRAM_CHECKS,
  MAP_CHECKS,
  getChecksForStyle,
} from '../../types/qa'
import { Err, Ok } from '../../types/result'
import { GeminiAPIError } from '../../utils/errors'
import { buildRetryPatch, createScientificQaValidator } from '../scientificQaValidator'

// Mock the logger
vi.mock('../../utils/logger', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}))

/**
 * Helper to create a mock GeminiTextClient
 */
function createMockTextClient(response?: string, error?: GeminiAPIError): GeminiTextClient {
  return {
    generateText: vi.fn().mockResolvedValue(error ? Err(error) : Ok(response ?? '')),
    validateConnection: vi.fn().mockResolvedValue(Ok(true)),
  }
}

/**
 * Helper to create a passing QA JSON response for a given figure style
 */
function createPassingResponse(figureStyle: string): string {
  const checks = getChecksForStyle(
    figureStyle as 'scientific_map' | 'scientific_chart' | 'scientific_diagram'
  )
  const checkResults = checks.map((c: QaCheckDefinition) => ({
    id: c.id,
    status: 'pass',
    detail: 'Criterion met',
  }))
  return JSON.stringify({ checks: checkResults })
}

/**
 * Helper to create a failing QA response with specific failures
 */
function createFailingResponse(figureStyle: string, failingIds: string[]): string {
  const checks = getChecksForStyle(
    figureStyle as 'scientific_map' | 'scientific_chart' | 'scientific_diagram'
  )
  const checkResults = checks.map((c: QaCheckDefinition) => ({
    id: c.id,
    status: failingIds.includes(c.id) ? 'fail' : 'pass',
    detail: failingIds.includes(c.id) ? `${c.name} is missing or incorrect` : 'Criterion met',
  }))
  return JSON.stringify({ checks: checkResults })
}

describe('ScientificQaValidator', () => {
  describe('getChecksForStyle', () => {
    it('should return common checks plus map-specific checks for scientific_map', () => {
      const checks = getChecksForStyle('scientific_map')
      const ids = checks.map((c) => c.id)

      // Common checks
      expect(ids).toContain('spelling')
      expect(ids).toContain('french_accents')
      expect(ids).toContain('text_readable')
      expect(ids).toContain('clean_background')
      expect(ids).toContain('contrast')

      // Map-specific checks
      expect(ids).toContain('scale_bar')
      expect(ids).toContain('north_arrow')
      expect(ids).toContain('legend_if_needed')

      expect(checks.length).toBe(COMMON_CHECKS.length + MAP_CHECKS.length)
    })

    it('should return common checks plus chart-specific checks for scientific_chart', () => {
      const checks = getChecksForStyle('scientific_chart')
      const ids = checks.map((c) => c.id)

      expect(ids).toContain('axis_labels')
      expect(ids).toContain('units_present')
      expect(ids).toContain('legend_if_multiple')
      expect(ids).toContain('gridlines')

      expect(checks.length).toBe(COMMON_CHECKS.length + CHART_CHECKS.length)
    })

    it('should return common checks plus diagram-specific checks for scientific_diagram', () => {
      const checks = getChecksForStyle('scientific_diagram')
      const ids = checks.map((c) => c.id)

      expect(ids).toContain('components_labeled')
      expect(ids).toContain('flow_arrows')
      expect(ids).toContain('consistent_lineweight')

      expect(checks.length).toBe(COMMON_CHECKS.length + DIAGRAM_CHECKS.length)
    })
  })

  describe('validate', () => {
    it('should return a passing QA report when all checks pass', async () => {
      const response = createPassingResponse('scientific_map')
      const mockClient = createMockTextClient(response)
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_map',
        originalPrompt: 'Create a map of glaciers',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.passed).toBe(true)
        expect(result.data.score).toBe(1)
        expect(result.data.hardFailCount).toBe(0)
        expect(result.data.figureStyle).toBe('scientific_map')
        expect(result.data.checks.length).toBeGreaterThan(0)
        expect(result.data.checks.every((c) => c.status === 'pass')).toBe(true)
      }
    })

    it('should return a failing QA report when hard checks fail', async () => {
      const response = createFailingResponse('scientific_map', ['scale_bar', 'north_arrow'])
      const mockClient = createMockTextClient(response)
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_map',
        originalPrompt: 'Create a map',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.passed).toBe(false)
        expect(result.data.hardFailCount).toBe(2)
        expect(result.data.score).toBeLessThan(1)

        const scaleBarCheck = result.data.checks.find((c) => c.id === 'scale_bar')
        expect(scaleBarCheck?.status).toBe('fail')
        expect(scaleBarCheck?.severity).toBe('hard')

        const northArrowCheck = result.data.checks.find((c) => c.id === 'north_arrow')
        expect(northArrowCheck?.status).toBe('fail')
      }
    })

    it('should handle spelling check failures', async () => {
      const response = createFailingResponse('scientific_diagram', ['spelling'])
      const mockClient = createMockTextClient(response)
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_diagram',
        originalPrompt: 'Create a diagram',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.passed).toBe(false)
        expect(result.data.hardFailCount).toBe(1)

        const spellingCheck = result.data.checks.find((c) => c.id === 'spelling')
        expect(spellingCheck?.status).toBe('fail')
        expect(spellingCheck?.severity).toBe('hard')
      }
    })

    it('should handle chart axis and units failures', async () => {
      const response = createFailingResponse('scientific_chart', ['axis_labels', 'units_present'])
      const mockClient = createMockTextClient(response)
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_chart',
        originalPrompt: 'Create a temperature chart',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.passed).toBe(false)
        expect(result.data.hardFailCount).toBe(2)
      }
    })

    it('should gracefully handle malformed JSON response', async () => {
      const mockClient = createMockTextClient('This is not valid JSON at all')
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_map',
        originalPrompt: 'Create a map',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        // Should be marked as passed (don't block on QA infrastructure failures)
        expect(result.data.passed).toBe(true)
        expect(result.data.hardFailCount).toBe(0)
        // All checks should be skipped
        expect(result.data.checks.every((c) => c.status === 'skipped')).toBe(true)
      }
    })

    it('should handle JSON wrapped in markdown code fences', async () => {
      const innerJson = createPassingResponse('scientific_diagram')
      const response = `\`\`\`json\n${innerJson}\n\`\`\``
      const mockClient = createMockTextClient(response)
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_diagram',
        originalPrompt: 'Create a diagram',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.passed).toBe(true)
        expect(result.data.checks.every((c) => c.status === 'pass')).toBe(true)
      }
    })

    it('should gracefully handle Gemini API errors', async () => {
      const mockClient = createMockTextClient(
        undefined,
        new GeminiAPIError('API quota exceeded', 'Wait and retry')
      )
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_map',
        originalPrompt: 'Create a map',
      })

      // Should return Ok with skipped report, not Err
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.passed).toBe(true) // Don't block
        expect(result.data.checks.every((c) => c.status === 'skipped')).toBe(true)
      }
    })

    it('should pass image data as base64 to the text client', async () => {
      const response = createPassingResponse('scientific_diagram')
      const mockClient = createMockTextClient(response)
      const validator = createScientificQaValidator(mockClient)

      const imageBuffer = Buffer.from('test-image-data')
      await validator.validate({
        imageData: imageBuffer,
        figureStyle: 'scientific_diagram',
        originalPrompt: 'Create a diagram',
      })

      expect(mockClient.generateText).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          temperature: 0.2,
          inputImage: imageBuffer.toString('base64'),
        })
      )
    })

    it('should compute score correctly with mixed results', async () => {
      // 2 out of 9 checks fail for scientific_diagram (common 6 + diagram 3 = 9)
      const response = createFailingResponse('scientific_diagram', ['spelling', 'flow_arrows'])
      const mockClient = createMockTextClient(response)
      const validator = createScientificQaValidator(mockClient)

      const result = await validator.validate({
        imageData: Buffer.from('fake-image'),
        figureStyle: 'scientific_diagram',
        originalPrompt: 'Create a diagram',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        const totalChecks = result.data.checks.length
        const passedChecks = result.data.checks.filter((c) => c.status === 'pass').length
        expect(result.data.score).toBe(Math.round((passedChecks / totalChecks) * 100) / 100)
      }
    })
  })

  describe('buildRetryPatch', () => {
    it('should return empty string when no hard failures', () => {
      const checks = [
        {
          id: 'spelling',
          name: 'Spelling',
          severity: 'hard' as const,
          status: 'pass' as const,
        },
        {
          id: 'flow_arrows',
          name: 'Flow Arrows',
          severity: 'soft' as const,
          status: 'fail' as const,
          detail: 'Arrows unclear',
        },
      ]

      const patch = buildRetryPatch(checks)
      expect(patch).toBe('')
    })

    it('should generate remediation for missing scale bar', () => {
      const checks = [
        {
          id: 'scale_bar',
          name: 'Scale Bar',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'No scale bar found',
        },
      ]

      const patch = buildRetryPatch(checks)
      expect(patch).toContain('CORRECTIONS OBLIGATOIRES')
      expect(patch).toContain('scale bar')
      expect(patch).toContain('No scale bar found')
    })

    it('should generate remediation for missing axis labels and units', () => {
      const checks = [
        {
          id: 'axis_labels',
          name: 'Axis Labels',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'X-axis has no label',
        },
        {
          id: 'units_present',
          name: 'Units',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'No units on Y-axis',
        },
      ]

      const patch = buildRetryPatch(checks)
      expect(patch).toContain('axis')
      expect(patch).toContain('units')
      expect(patch).toContain('MANDATORY')
    })

    it('should generate remediation for spelling errors', () => {
      const checks = [
        {
          id: 'spelling',
          name: 'Spelling',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'Found: "Températre" should be "Température"',
        },
      ]

      const patch = buildRetryPatch(checks)
      expect(patch).toContain('spelling')
      expect(patch).toContain('Températre')
    })

    it('should generate remediation for French accent errors', () => {
      const checks = [
        {
          id: 'french_accents',
          name: 'French Accents',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'Missing accents on "temperature" and "elevation"',
        },
      ]

      const patch = buildRetryPatch(checks)
      expect(patch).toContain('accent')
      expect(patch).toContain('é, è, ê')
    })

    it('should handle multiple hard failures', () => {
      const checks = [
        {
          id: 'spelling',
          name: 'Spelling',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'Typo found',
        },
        {
          id: 'scale_bar',
          name: 'Scale Bar',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'Missing',
        },
        {
          id: 'north_arrow',
          name: 'North Arrow',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'Missing',
        },
      ]

      const patch = buildRetryPatch(checks)
      expect(patch).toContain('spelling')
      expect(patch).toContain('scale bar')
      expect(patch).toContain('north arrow')
    })

    it('should handle unknown check IDs gracefully', () => {
      const checks = [
        {
          id: 'unknown_check',
          name: 'Unknown Check',
          severity: 'hard' as const,
          status: 'fail' as const,
          detail: 'Something failed',
        },
      ]

      const patch = buildRetryPatch(checks)
      expect(patch).toContain('CORRECTIONS OBLIGATOIRES')
      expect(patch).toContain('Unknown Check')
      expect(patch).toContain('Something failed')
    })
  })
})
