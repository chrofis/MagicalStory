---
name: analyze-story-log
description: "Analyze Railway log files from story generation runs. Shows timing, costs, issues, and quality findings."
---

# Analyze Story Log

## Overview

Analyzes Railway log files downloaded to `~/Downloads/logs.*.log` to understand story generation performance, costs, and issues.

## Usage

**Analyze the latest log file:**
```bash
node scripts/analyze-story-log.js
```

**Analyze a specific log file:**
```bash
node scripts/analyze-story-log.js ~/Downloads/logs.1769344683488.log
```

## What It Shows

### Story Info
- Title, language, characters, pages
- Job ID and user

### Timing
- Start/end times
- Total duration

### Image Generation
- Cover generation status
- Page images (first attempt vs retries)
- Content blocked retries (should be 0 after prompt fix)
- Auto-repair status

### Cost Breakdown
- By provider: Anthropic, Gemini Text, Gemini Image, Gemini Quality
- By function: Unified Story, Scene Expand, Cover/Page Images, Quality evals, Avatars
- Total cost

### Issues Found
- Errors (critical failures)
- Warnings (potential problems)
- Fallbacks (graceful degradation)
- Low quality scores (pages scoring below threshold)

### Quality Findings
- Consistency check results
- Text check findings

## Downloading Logs

Logs are downloaded from Railway dashboard:
1. Go to Railway project → Logs
2. Click "Download logs"
3. File saves to `~/Downloads/logs.<timestamp>.log`

## Key Metrics to Watch

| Metric | Good | Bad |
|--------|------|-----|
| Content blocked retries | 0 | >0 (evaluation prompt issue) |
| First attempt success | = total pages | < total pages |
| Avatar fallbacks | 0 | >0 (missing avatar variants) |
| Low quality scores | 0-1 | >3 (image gen issues) |

## Troubleshooting

**"Content blocked by gemini-2.5-flash (PROHIBITED_CONTENT)"**
- Evaluation prompt contains triggering terms
- Check `prompts/image-evaluation.txt` for age/child/adult terms
- Sanitized prompt fallback should handle this

**"Avatar fallback" warnings**
- Characters assigned costumes that don't exist as avatars
- Check scene expansion is selecting from available avatars only
- Fix: `buildAvailableAvatarsForPrompt()` in storyHelpers.js

**"No Characters section found, using fallback"**
- Outline parsing issue
- Check if outline format changed

## Related Commands

```bash
# List recent story IDs from database
node scripts/list-stories.js

# Check specific story structure
node scripts/check-story-structure.js <storyId>
```

## Log File Location

Default search path: `~/Downloads/logs.*.log`

The script automatically finds the most recent log file if no path is specified.
