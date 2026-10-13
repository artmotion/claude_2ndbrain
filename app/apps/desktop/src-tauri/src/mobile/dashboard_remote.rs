// SPDX-License-Identifier: Apache-2.0
//! iOS/iPadOS stand-in for `dashboard_remote.rs`.
//!
//! Linked Claude/ChatGPT dashboard tabs are native child webviews created with
//! Tauri's `unstable` multi-webview API, which exists on desktop only. On
//! mobile mounting refuses with a clear error; update/unmount have nothing to
//! act on and succeed.

use crate::error::{AppError, AppResult};

#[tauri::command]
pub async fn mount_dashboard_link() -> AppResult<String> {
    Err(AppError::new("Linked dashboards are not available on iPad yet."))
}

#[tauri::command]
pub async fn update_dashboard_link() -> AppResult<()> {
    Ok(())
}

#[tauri::command]
pub async fn unmount_dashboard_link() -> AppResult<()> {
    Ok(())
}
