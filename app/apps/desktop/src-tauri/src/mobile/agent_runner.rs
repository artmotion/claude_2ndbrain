// SPDX-License-Identifier: Apache-2.0
//! iOS/iPadOS stand-in for `agent_runner.rs`.
//!
//! The desktop module spawns the installed Codex / Claude Code CLIs as child
//! processes. iOS apps cannot spawn processes, so on mobile no agent is ever
//! detected and a run is refused. The command names match the desktop ones so
//! `lib.rs` registers one handler list for every platform; extra arguments in
//! the invoke payload are ignored.

use crate::error::{AppError, AppResult};

/// Managed in `lib.rs` like the desktop state; holds nothing here.
#[derive(Default)]
pub struct AgentRunnerState;

/// Desktop warms the CLI detection cache at launch; there is nothing to detect.
pub fn warm_detection(_app: &tauri::AppHandle) {}

/// No local agent CLIs exist on iOS/iPadOS.
#[tauri::command]
pub async fn detect_agents() -> AppResult<Vec<serde_json::Value>> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn run_agent() -> AppResult<()> {
    Err(AppError::new(
        "Local AI agents are not available on iPad: they run as separate programs on a computer.",
    ))
}

/// Nothing can be running, so cancelling is always a no-op.
#[tauri::command]
pub fn cancel_agent() -> AppResult<()> {
    Ok(())
}
