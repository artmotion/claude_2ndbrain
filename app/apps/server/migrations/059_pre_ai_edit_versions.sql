-- SPDX-License-Identifier: Apache-2.0
--
-- A fourth version cause: `pre-ai-edit`, the note's text kept immediately
-- before an MCP (AI) tool changed it (`src/mcp/service.ts aiEditContent`), so an
-- agent's damaging edit can be undone with the `restore_version` tool or from
-- the app's Version History.
ALTER TABLE note_versions DROP CONSTRAINT IF EXISTS note_versions_cause_check;
ALTER TABLE note_versions
  ADD CONSTRAINT note_versions_cause_check
  CHECK (cause IN ('idle', 'pre-revert', 'pre-shrink', 'pre-ai-edit'));
