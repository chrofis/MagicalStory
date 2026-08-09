---
name: using-superpowers
description: Use when starting any conversation - establishes how to find and use skills
---

# Using Skills

Before starting non-trivial work, check whether a listed skill matches the task — the skill descriptions are the index. If one matches, invoke it with the Skill tool and follow it; if it turns out to be wrong for the situation, say so and drop it.

**In Claude Code:** use the `Skill` tool — invoking loads the skill's content. Don't reconstruct a skill from memory; skills change.

When multiple skills apply, process skills (brainstorming, systematic-debugging) come before implementation skills — they determine the approach.

User instructions say WHAT, not HOW: "add X" or "fix Y" doesn't mean skip the matching workflow skill.
