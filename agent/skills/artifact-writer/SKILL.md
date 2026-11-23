---
name: artifact-writer
description: Produce a structured document or reusable report in the Agent workspace. Use when the user asks for a report, brief, plan, summary, or downloadable deliverable.
---

# Artifact writer

1. Determine the audience, purpose, and required format from the request.
2. Draft the material before filing it.
3. Use `workspace_write` to save the final artifact under a descriptive relative path.
4. Include a title, date, scope, findings, and next actions when appropriate.
5. Preserve source links and clearly label assumptions.
6. Read the saved file back with `workspace_read` if exact formatting matters.
7. End the response with the workspace-relative artifact path and a concise summary.
