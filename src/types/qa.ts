/**
 * QA types for scientific figure validation
 * Used by the post-generation QA system to evaluate figure quality
 */

import type { FigureStyle } from './mcp'

/**
 * Status of an individual QA check
 */
export type QaCheckStatus = 'pass' | 'fail' | 'warning' | 'skipped'

/**
 * Severity of a QA check
 * - hard: mandatory for publication quality, triggers retry on failure
 * - soft: advisory, reported but does not trigger retry
 */
export type QaCheckSeverity = 'hard' | 'soft'

/**
 * Individual QA check result
 */
export interface QaCheck {
  /** Unique identifier for this check */
  id: string
  /** Human-readable name */
  name: string
  /** Whether this check is mandatory (hard) or advisory (soft) */
  severity: QaCheckSeverity
  /** Result of the check */
  status: QaCheckStatus
  /** Explanation from the evaluator */
  detail?: string | undefined
}

/**
 * Complete QA report for a generated scientific figure
 */
export interface QaReport {
  /** Overall pass/fail based on hard checks only */
  passed: boolean
  /** Numeric score 0.0 - 1.0 (ratio of passed checks to total evaluated checks) */
  score: number
  /** Count of hard check failures */
  hardFailCount: number
  /** Individual check results */
  checks: QaCheck[]
  /** Number of generation attempts (1 = first try, 2+ = retried) */
  attempts: number
  /** Figure style that was evaluated */
  figureStyle: FigureStyle
  /** Time spent on QA evaluation in milliseconds */
  evaluationTimeMs: number
}

/**
 * Definition of a QA check to be evaluated
 */
export interface QaCheckDefinition {
  /** Unique identifier */
  id: string
  /** Human-readable name */
  name: string
  /** Severity level */
  severity: QaCheckSeverity
  /** Instruction for the evaluator */
  instruction: string
}

/**
 * Common checks applied to all scientific figure styles
 */
export const COMMON_CHECKS: QaCheckDefinition[] = [
  {
    id: 'spelling',
    name: 'Spelling Accuracy',
    severity: 'hard',
    instruction:
      'Are there any spelling errors in ANY visible text, labels, or annotations? Check every single word carefully.',
  },
  {
    id: 'french_accents',
    name: 'French Accent Marks',
    severity: 'hard',
    instruction:
      'If the figure contains French text, are all accent marks correct? Check for é, è, ê, ë, à, â, ù, û, ô, î, ï, ç, and other diacritics. Missing or incorrect accents count as failures.',
  },
  {
    id: 'text_readable',
    name: 'Text Readability',
    severity: 'hard',
    instruction:
      'Is ALL text visible, legible, and at a sufficient font size for publication? No text should overlap other text or elements.',
  },
  {
    id: 'clean_background',
    name: 'Clean Background',
    severity: 'hard',
    instruction:
      'Is the background clean white or neutral? There should be no distracting gradients, artistic effects, or decorative elements.',
  },
  {
    id: 'contrast',
    name: 'Sufficient Contrast',
    severity: 'hard',
    instruction:
      'Is there sufficient contrast between text/lines and the background for clear readability? Dark text/lines on light background.',
  },
  {
    id: 'scientific_terminology',
    name: 'Scientific Terminology',
    severity: 'soft',
    instruction:
      'Is the scientific terminology used correctly and consistently throughout the figure?',
  },
]

/**
 * Checks specific to scientific_map figures
 */
export const MAP_CHECKS: QaCheckDefinition[] = [
  {
    id: 'scale_bar',
    name: 'Scale Bar Present',
    severity: 'hard',
    instruction: 'Is there a clearly visible scale bar with metric units (m or km)?',
  },
  {
    id: 'north_arrow',
    name: 'North Arrow Present',
    severity: 'hard',
    instruction: 'Is there a clearly visible north arrow or compass indicator?',
  },
  {
    id: 'legend_if_needed',
    name: 'Legend If Needed',
    severity: 'soft',
    instruction:
      'If there are color-coded regions, symbols, or multiple data layers, is there a legend explaining them?',
  },
]

/**
 * Checks specific to scientific_chart figures
 */
export const CHART_CHECKS: QaCheckDefinition[] = [
  {
    id: 'axis_labels',
    name: 'Axis Labels',
    severity: 'hard',
    instruction: 'Are BOTH x-axis and y-axis clearly labeled?',
  },
  {
    id: 'units_present',
    name: 'Units Present',
    severity: 'hard',
    instruction: 'Do axis labels include appropriate SI units (e.g., °C, m, km, W/m², years)?',
  },
  {
    id: 'legend_if_multiple',
    name: 'Legend for Multiple Series',
    severity: 'hard',
    instruction: 'If there are multiple data series, lines, or bars, is there a legend?',
  },
  {
    id: 'gridlines',
    name: 'Grid Lines',
    severity: 'soft',
    instruction: 'Are grid lines present if they would help reading values from the chart?',
  },
]

/**
 * Checks specific to scientific_diagram figures
 */
export const DIAGRAM_CHECKS: QaCheckDefinition[] = [
  {
    id: 'components_labeled',
    name: 'Components Labeled',
    severity: 'hard',
    instruction:
      'Are all major components and elements in the diagram clearly labeled with text annotations?',
  },
  {
    id: 'visual_style_consistency',
    name: 'Visual Style Consistency',
    severity: 'hard',
    instruction:
      'Is the visual style homogeneous throughout the diagram? There should be no mixing of flat 2D and semi-realistic 3D elements, no mixing of icon styles, and no inconsistent rendering approaches within the same figure.',
  },
  {
    id: 'subpanel_labels',
    name: 'Sub-panel Labels',
    severity: 'hard',
    instruction:
      'If the figure contains multiple sub-panels or sections, are they clearly labeled with lowercase letters (a, b, c, d) or numbers following journal conventions? Single-panel figures pass this check automatically.',
  },
  {
    id: 'color_palette_coherent',
    name: 'Coherent Color Palette',
    severity: 'hard',
    instruction:
      'Is the color palette coherent and unified across the entire diagram? Colors should follow a consistent scheme (e.g., blues for water/ice, greens for vegetation, reds for heat/danger). Random or clashing colors are a failure.',
  },
  {
    id: 'flow_arrows',
    name: 'Flow Arrows',
    severity: 'soft',
    instruction:
      'If this is a process diagram, are arrows and flow direction clear and unambiguous?',
  },
  {
    id: 'consistent_lineweight',
    name: 'Consistent Line Weight',
    severity: 'soft',
    instruction: 'Are line weights consistent and professional throughout the diagram?',
  },
]

/**
 * Get all QA checks applicable to a given figure style
 */
export function getChecksForStyle(figureStyle: FigureStyle): QaCheckDefinition[] {
  const styleChecks: Record<FigureStyle, QaCheckDefinition[]> = {
    scientific_map: MAP_CHECKS,
    scientific_chart: CHART_CHECKS,
    scientific_diagram: DIAGRAM_CHECKS,
  }

  return [...COMMON_CHECKS, ...(styleChecks[figureStyle] ?? [])]
}
