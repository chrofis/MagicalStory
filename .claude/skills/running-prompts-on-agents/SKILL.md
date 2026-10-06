---
name: running-prompts-on-agents
description: Use when a text-stage prompt or builder change (arc, beats, plan-check, writer, refine, audit, lector, Art Director briefs) needs a test run and the owner wants no Lab run and no paid model call — "you are the lab", "run it on an agent", "use a subagent as the model"
---

# Running prompts on agents

## Overview
A subagent acts as the model. The production code builds the exact prompt, one fresh agent per stage answers it, and the production parser reads the answer. Cost: zero API spend. What you get is a direction, not a measurement.

## When to use
- Console test of a prompt or builder edit on any TEXT stage, including chained stages (arc → writer).
- Not for images, and not for judges whose verdict feeds a calibrated threshold (Jev AUCs, eval scores). Those need the real model.

## Steps
1. **Build with the real builder.** Load the stored story (staging DB via `STAGING_DATABASE_URL`) and call the production builder function. Write the system and user prompts, exactly as they would be sent, to `<scratchpad>/<run>/<stage>_prompt.txt`. Never hand-assemble a prompt, because a proxy hides builder bugs. Grep the file for `{UNFILLED}` placeholders.
2. **One fresh agent per stage.** Use the Agent tool with `model` set to match the production model of that stage (`sonnet` for Sonnet 5.5 stages; the production model is in `server/config/models.js`). Prompt:
   > Read `<prompt file>`. You are the model this prompt is sent to. Follow it exactly and write ONLY your answer, in the exact output format it asks for, to `<output file>`. Do not read the repository or any other file.
   
   Tell the agent nothing about the change, the expected result or the review. It must answer blind.
3. **Parse with the real parser.** A parse failure is a finding; fix the prompt, never the output by hand.
4. **Chain.** Build the next stage's prompt from the PARSED output with its real builder (step 1), then use a new agent. Never let one agent do two stages, because it would carry the first stage's intent into the second.
5. **Judge separately.** Read the output against the agreed bar yourself or in another fresh agent, and quote the worst lines.
6. **Record.** Add an `evals/results/results.jsonl` row with `model_id: "agent:<model>"` and the note "agent-as-model, not production". Save the raw prompts and outputs to `evals/runs/<date>_<id>/`.

## Common mistakes
| Mistake | Fix |
|---|---|
| Agent told what the fix is meant to achieve | Give it the prompt file path only |
| Opus agent standing in for a Sonnet stage | Match `model` to production; say so in the report if you can't |
| Claiming "production now does X" | Say "agent-as-model run"; a real-model check comes before any adoption claim |
| Prompt rebuilt from a template, not the builder | Call the builder that `storyJobPipeline`/`beatsPipeline` calls |
| Reasoning effort ignored | An agent can't set effort; note it as a known gap |
