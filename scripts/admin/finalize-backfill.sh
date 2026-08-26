#!/bin/bash
# Finalize the backfill after the full run completes

echo "Generating final report..."
node scripts/admin/generate-report.js

echo ""
echo "Staging files for commit..."
git add migrations/025_landmark_fame.sql
git add scripts/admin/backfill-landmark-fame.js
git add tasks/landmark-fame-report.md

echo ""
echo "Commit ready. Files staged:"
git status --short

echo ""
echo "Next: review the report and run: git commit -m \"...\""
