# Scientific QA Loop and Vector-First Contract

## Goal
Make scientific figure generation reliable enough for publication workflows by adding:
- a vector-first rendering path for schemas/charts/maps
- a deterministic QA gate with auto-repair retries
- explicit output guarantees in the MCP response

## Problems This Solves
- Text spelling and unit errors in generated figures.
- Missing mandatory components (legend, axis labels, scale bar, north arrow).
- Inconsistent style and layout across iterations.
- Raster-only generation for content that should be vector-native.

## High-Level Architecture
1. `request classifier` decides `vector` vs `image` path.
2. `spec builder` converts user intent into a structured figure spec.
3. `renderer` produces SVG/PDF/PNG.
4. `qa validator` runs deterministic checks and scores result.
5. `repair loop` retries with targeted fixes when hard checks fail.

## Routing Policy (Vector-First)
Use vector pipeline by default when `figureStyle` is:
- `scientific_diagram`
- `scientific_chart`
- `scientific_map`

Use image model pipeline only for:
- photo-like scientific illustrations
- terrain/texture-heavy scenes where vector is not appropriate

If user explicitly requests raster art style, honor it and skip vector path.

## MCP Tool Contract (Proposed)
Keep current `generate_image`, and add a scientific entrypoint:

```json
{
  "name": "generate_scientific_figure",
  "input": {
    "prompt": "string",
    "figureStyle": "scientific_diagram|scientific_chart|scientific_map|scientific_illustration",
    "preferredEngine": "auto|vector|image",
    "outputFormat": "svg|pdf|png",
    "dimensions": { "width": 1800, "height": 1200, "dpi": 300 },
    "data": {
      "series": [],
      "labels": [],
      "units": {},
      "metadata": {}
    },
    "constraints": {
      "mustInclude": [],
      "mustNotChange": [],
      "colorblindSafe": true,
      "fontFamily": "Arial",
      "background": "white"
    },
    "qa": {
      "enabled": true,
      "maxRetries": 2,
      "failOnWarnings": false,
      "minScore": 0.9
    },
    "inputImagePath": "/absolute/path/optional.png",
    "editMode": "strict|creative"
  }
}
```

## Response Contract (Proposed)
Always return both artifact and QA report:

```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///.../figure.svg",
    "name": "figure.svg",
    "mimeType": "image/svg+xml"
  },
  "metadata": {
    "engineUsed": "vector|image",
    "attempts": 1,
    "qaScore": 0.96,
    "qaPassed": true,
    "checks": [
      { "id": "spelling", "status": "pass" },
      { "id": "axis_labels", "status": "pass" }
    ]
  }
}
```

## QA Validator Rules
Hard fail checks:
- spelling errors in visible text
- missing axis labels for charts
- missing units for numeric axes
- missing legend when multiple series exist
- missing scale bar for maps
- missing north arrow for maps (unless explicitly disabled)
- low contrast text below threshold (WCAG-like rule)

Soft checks:
- label overlap risk
- dense annotation clutter
- inconsistent line weights
- non-colorblind-safe palette

## Auto-Repair Loop
Algorithm:
1. render candidate
2. run QA
3. if hard fail and attempts remaining, build targeted repair prompt/spec delta
4. regenerate
5. return first passing result, else return best result with explicit failed checks

Pseudo-flow:

```text
for attempt in [1..maxRetries+1]:
  artifact = render(spec)
  report = validate(artifact, spec, rules)
  if report.hardFails == 0 and report.score >= minScore:
    return pass
  spec = patchSpecFromFailures(spec, report)
return fail_with_report
```

## Vector Engines by Figure Type
- `scientific_diagram`: D2 or Mermaid to SVG, then optional PDF/PNG export.
- `scientific_chart`: Vega-Lite or matplotlib generated from structured data.
- `scientific_map`: cartographic stack with explicit layers, legend, scale bar, north arrow.

Output preference:
- primary: `svg` (editable, publication-ready)
- secondary: `pdf` for manuscript submission
- tertiary: `png` for quick preview

## Determinism and Traceability
Store sidecar JSON for every figure:
- normalized input spec
- engine and version
- QA report
- retry history
- timestamp and output paths

This makes each figure reproducible and reviewable.

## Incremental Rollout Plan
Phase 1:
- Add new tool contract and router (`auto|vector|image`).
- Return QA metadata skeleton.

Phase 2:
- Implement deterministic QA checks for chart/map/diagram essentials.
- Add retry loop with targeted spec patching.

Phase 3:
- Make vector default for chart/diagram/map.
- Keep image model fallback only when vector path cannot satisfy request.

Phase 4:
- Add strict regression tests with golden outputs and QA thresholds.

## Minimum Acceptance Criteria
- At least 95 percent pass rate on internal scientific figure benchmark.
- Zero hard-check violations in accepted outputs.
- Mean attempts <= 1.4 per successful figure.
- SVG output for all chart/diagram requests unless user overrides.
