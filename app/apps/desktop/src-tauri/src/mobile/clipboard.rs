// SPDX-License-Identifier: Apache-2.0
//! iOS/iPadOS stand-in for `clipboard.rs`.
//!
//! The desktop module writes the clipboard through `arboard`, which has no
//! iOS backend. Until a UIPasteboard path exists the command refuses, and the
//! UI's copy actions report the failure like any other clipboard error.

use crate::error::{AppError, AppResult};

/// Managed in `lib.rs` like the desktop state; holds nothing here.
#[derive(Default)]
pub struct ClipboardState;

#[tauri::command]
pub async fn clipboard_write() -> AppResult<()> {
    Err(AppError::new("Copying to the clipboard is not available on iPad yet."))
}
