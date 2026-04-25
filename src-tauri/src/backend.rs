use font_kit::source::SystemSource;
use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

const WATCH_EVENT_NAME: &str = "fs-event";

#[derive(Default)]
pub struct WatchState(pub Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFileResponse {
    path: String,
    content: String,
    modified_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileResponse {
    path: String,
    modified_at: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    root_path: String,
    markdown_file_count: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    path: String,
    line: usize,
    column: usize,
    preview: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropClassification {
    kind: String,
    markdown_paths: Vec<String>,
    folder_path: Option<String>,
    rejected_paths: Vec<String>,
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchEventPayload {
    path: String,
    kind: String,
}

#[tauri::command]
pub fn open_file(path: String) -> Result<OpenFileResponse, String> {
    let normalized = normalize_existing_path(&path)?;
    ensure_markdown_file(&normalized)?;

    let content = fs::read_to_string(&normalized)
        .map_err(|error| format!("Failed to read {}: {error}", normalized.display()))?;

    Ok(OpenFileResponse {
        path: path_to_string(&normalized),
        content,
        modified_at: file_modified_at(&normalized)?,
    })
}

#[tauri::command]
pub fn save_file(path: String, content: String) -> Result<SaveFileResponse, String> {
    let target_path = PathBuf::from(path);
    ensure_markdown_extension(&target_path)?;

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to prepare {}: {error}", parent.display()))?;
    }

    fs::write(&target_path, content)
        .map_err(|error| format!("Failed to save {}: {error}", target_path.display()))?;

    Ok(SaveFileResponse {
        path: path_to_string(&target_path),
        modified_at: file_modified_at(&target_path)?,
    })
}

#[tauri::command]
pub fn open_workspace(root_path: String) -> Result<WorkspaceInfo, String> {
    let normalized = normalize_existing_path(&root_path)?;
    if !normalized.is_dir() {
        return Err(format!("{} is not a folder.", normalized.display()));
    }

    Ok(WorkspaceInfo {
        root_path: path_to_string(&normalized),
        markdown_file_count: collect_markdown_files(&normalized).len(),
    })
}

#[tauri::command]
pub fn search_workspace(root_path: String, query: String) -> Result<Vec<SearchHit>, String> {
    let normalized = normalize_existing_path(&root_path)?;
    if !normalized.is_dir() {
        return Err(format!("{} is not a folder.", normalized.display()));
    }

    let trimmed_query = query.trim();
    if trimmed_query.is_empty() {
        return Ok(Vec::new());
    }

    search_markdown_files(&normalized, trimmed_query)
}

#[tauri::command]
pub fn watch_paths(
    app: AppHandle,
    state: State<'_, WatchState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut unique_paths = Vec::new();
    let mut seen = HashSet::new();

    for path in paths {
        let Ok(normalized) = normalize_existing_path(&path) else {
            continue;
        };
        let key = normalize_key(&normalized);
        if seen.insert(key) {
            unique_paths.push(normalized);
        }
    }

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Failed to access the file watcher state.".to_string())?;

    *guard = None;

    if unique_paths.is_empty() {
        return Ok(());
    }

    let watcher_app = app.clone();
    let mut watcher = recommended_watcher(move |result| {
        if let Err(error) = handle_watch_result(&watcher_app, result) {
            eprintln!("watch error: {error}");
        }
    })
    .map_err(|error| format!("Failed to create file watcher: {error}"))?;

    for path in unique_paths {
        let mode = if path.is_dir() {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };

        watcher
            .watch(&path, mode)
            .map_err(|error| format!("Failed to watch {}: {error}", path.display()))?;
    }

    *guard = Some(watcher);

    Ok(())
}

#[tauri::command]
pub fn classify_drop_paths(paths: Vec<String>) -> Result<DropClassification, String> {
    classify_paths(paths)
}

#[tauri::command]
pub fn list_system_fonts() -> Result<Vec<String>, String> {
    let source = SystemSource::new();
    let mut families = source.all_families().unwrap_or_default();
    families.extend(list_platform_font_families()?);

    let families = normalize_font_families(families);

    Ok(families)
}

#[tauri::command]
pub fn startup_file_paths() -> Vec<String> {
    collect_startup_markdown_paths(std::env::args_os().skip(1))
}

fn normalize_font_families(families: Vec<String>) -> Vec<String> {
    let mut normalized = families
        .into_iter()
        .filter_map(|family| {
            let trimmed = family.trim();
            if trimmed.is_empty() || trimmed.starts_with('@') {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
        .collect::<Vec<_>>();

    normalized.sort_by_key(|family| family.to_lowercase());
    normalized.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    normalized
}

#[cfg(target_os = "windows")]
fn list_platform_font_families() -> Result<Vec<String>, String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    const FONT_REGISTRY_PATH: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts";

    let roots = [
        RegKey::predef(HKEY_LOCAL_MACHINE),
        RegKey::predef(HKEY_CURRENT_USER),
    ];
    let mut families = Vec::new();

    for root in roots {
        let Ok(fonts_key) = root.open_subkey_with_flags(FONT_REGISTRY_PATH, KEY_READ) else {
            continue;
        };

        for value in fonts_key.enum_values().filter_map(Result::ok) {
            if let Some(family) = font_registry_name_to_family(&value.0) {
                families.push(family);
            }
        }
    }

    Ok(families)
}

#[cfg(not(target_os = "windows"))]
fn list_platform_font_families() -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

#[cfg(target_os = "windows")]
fn font_registry_name_to_family(registry_name: &str) -> Option<String> {
    let base_name = registry_name
        .split(" (")
        .next()
        .unwrap_or(registry_name)
        .trim();
    if base_name.is_empty() || base_name.starts_with('@') {
        return None;
    }

    let mut family = base_name.to_string();
    for suffix in [
        " Bold Italic",
        " Bold Oblique",
        " SemiBold Italic",
        " Semibold Italic",
        " Semi Bold Italic",
        " Light Italic",
        " Regular Italic",
        " Black Italic",
        " Medium Italic",
        " Condensed Italic",
        " Narrow Italic",
        " Bold",
        " Oblique",
        " Italic",
        " Regular",
        " SemiBold",
        " Semibold",
        " Semi Bold",
        " Light",
        " Black",
        " Medium",
        " Condensed",
        " Narrow",
    ] {
        if family.ends_with(suffix) {
            family.truncate(family.len() - suffix.len());
            break;
        }
    }

    let family = family.trim();
    if family.is_empty() {
        None
    } else {
        Some(family.to_string())
    }
}

fn handle_watch_result(app: &AppHandle, result: notify::Result<Event>) -> Result<(), String> {
    let event = result.map_err(|error| format!("Watch callback failed: {error}"))?;
    let Some(kind) = map_watch_kind(&event.kind) else {
        return Ok(());
    };

    let mut seen = HashSet::new();
    for path in event.paths {
        let printable = if path.exists() {
            path_to_string(&path.canonicalize().unwrap_or(path.clone()))
        } else {
            path_to_string(&path)
        };

        if seen.insert(printable.clone()) {
            let payload = WatchEventPayload {
                path: printable,
                kind: kind.to_string(),
            };
            let _ = app.emit(WATCH_EVENT_NAME, payload);
        }
    }

    Ok(())
}

fn map_watch_kind(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) | EventKind::Modify(_) => Some("changed"),
        EventKind::Remove(_) => Some("deleted"),
        _ => None,
    }
}

fn classify_paths(paths: Vec<String>) -> Result<DropClassification, String> {
    if paths.is_empty() {
        return Ok(invalid_drop("Drop a markdown file or a single folder."));
    }

    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut rejected_paths = Vec::new();

    for raw_path in paths {
        let candidate = PathBuf::from(&raw_path);
        let normalized = match normalize_existing_path(&raw_path) {
            Ok(path) => path,
            Err(_) => {
                rejected_paths.push(path_to_string(&candidate));
                continue;
            }
        };

        if normalized.is_dir() {
            directories.push(normalized);
        } else if normalized.is_file() {
            files.push(normalized);
        } else {
            rejected_paths.push(path_to_string(&normalized));
        }
    }

    if !files.is_empty() && !directories.is_empty() {
        return Ok(invalid_drop(
            "Drop either markdown files or a single folder, not both together.",
        ));
    }

    if directories.len() > 1 {
        return Ok(invalid_drop(
            "Drop a single folder to open it as a workspace.",
        ));
    }

    if let Some(folder) = directories.into_iter().next() {
        return Ok(DropClassification {
            kind: "folder".to_string(),
            markdown_paths: Vec::new(),
            folder_path: Some(path_to_string(&folder)),
            rejected_paths,
            message: None,
        });
    }

    let mut markdown_paths = Vec::new();
    for file in files {
        if is_markdown_path(&file) {
            markdown_paths.push(path_to_string(&file));
        } else {
            rejected_paths.push(path_to_string(&file));
        }
    }

    if markdown_paths.is_empty() {
        return Ok(invalid_drop(
            "Only .md and .markdown files can be dropped into the editor.",
        ));
    }

    Ok(DropClassification {
        kind: "files".to_string(),
        markdown_paths,
        folder_path: None,
        rejected_paths,
        message: None,
    })
}

fn invalid_drop(message: &str) -> DropClassification {
    DropClassification {
        kind: "invalid".to_string(),
        markdown_paths: Vec::new(),
        folder_path: None,
        rejected_paths: Vec::new(),
        message: Some(message.to_string()),
    }
}

fn search_markdown_files(root: &Path, query: &str) -> Result<Vec<SearchHit>, String> {
    let query_lower = query.to_lowercase();
    let mut hits = Vec::new();

    for file in collect_markdown_files(root) {
        let content = fs::read_to_string(&file)
            .map_err(|error| format!("Failed to read {}: {error}", file.display()))?;

        for (index, line) in content.lines().enumerate() {
            let line_lower = line.to_lowercase();
            if let Some(column_index) = line_lower.find(&query_lower) {
                hits.push(SearchHit {
                    path: path_to_string(&file),
                    line: index + 1,
                    column: column_index + 1,
                    preview: compact_preview(line),
                });
            }

            if hits.len() >= 250 {
                return Ok(hits);
            }
        }
    }

    Ok(hits)
}

fn collect_markdown_files(root: &Path) -> Vec<PathBuf> {
    WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .map(|entry| entry.into_path())
        .filter(|path| path.is_file() && is_markdown_path(path))
        .collect()
}

fn compact_preview(line: &str) -> String {
    let preview = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if preview.is_empty() {
        return "(blank line)".to_string();
    }

    if preview.chars().count() > 140 {
        let truncated = preview.chars().take(137).collect::<String>();
        format!("{truncated}...")
    } else {
        preview
    }
}

fn collect_startup_markdown_paths<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = OsString>,
{
    args.into_iter()
        .filter_map(|arg| {
            let candidate = PathBuf::from(arg);
            let normalized = candidate.canonicalize().ok()?;

            if normalized.is_file() && is_markdown_path(&normalized) {
                Some(path_to_string(&normalized))
            } else {
                None
            }
        })
        .collect()
}

fn normalize_existing_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);
    if !candidate.exists() {
        return Err(format!("{} does not exist.", candidate.display()));
    }

    candidate
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {}: {error}", candidate.display()))
}

fn file_modified_at(path: &Path) -> Result<Option<u64>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to access metadata for {}: {error}", path.display()))?;

    match metadata.modified() {
        Ok(modified) => Ok(system_time_to_millis(modified)),
        Err(_) => Ok(None),
    }
}

fn system_time_to_millis(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn ensure_markdown_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }

    ensure_markdown_extension(path)
}

fn ensure_markdown_extension(path: &Path) -> Result<(), String> {
    if is_markdown_path(path) {
        Ok(())
    } else {
        Err(format!(
            "{} is not a supported markdown file.",
            path.display()
        ))
    }
}

fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "md" | "markdown"))
        .unwrap_or(false)
}

fn normalize_key(path: &Path) -> String {
    path_to_string(path).replace('\\', "/").to_lowercase()
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::{classify_paths, collect_startup_markdown_paths, search_markdown_files};
    use std::ffi::OsString;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn classifies_markdown_files_and_ignores_other_files() {
        let temp = tempdir().expect("temp dir");
        let markdown = temp.path().join("note.md");
        let image = temp.path().join("image.png");
        fs::write(&markdown, "# note").expect("markdown file");
        fs::write(&image, "png").expect("image file");

        let result = classify_paths(vec![
            markdown.to_string_lossy().into_owned(),
            image.to_string_lossy().into_owned(),
        ])
        .expect("classification");

        assert_eq!(result.kind, "files");
        assert_eq!(result.markdown_paths.len(), 1);
        assert_eq!(result.rejected_paths.len(), 1);
    }

    #[test]
    fn rejects_mixed_files_and_folders() {
        let temp = tempdir().expect("temp dir");
        let markdown = temp.path().join("note.md");
        let folder = temp.path().join("vault");
        fs::write(&markdown, "# note").expect("markdown file");
        fs::create_dir(&folder).expect("folder");

        let result = classify_paths(vec![
            markdown.to_string_lossy().into_owned(),
            folder.to_string_lossy().into_owned(),
        ])
        .expect("classification");

        assert_eq!(result.kind, "invalid");
    }

    #[test]
    fn finds_workspace_search_hits() {
        let temp = tempdir().expect("temp dir");
        let markdown = temp.path().join("note.md");
        fs::write(
            &markdown,
            "# Title\nThis editor should find markdown search terms.\n",
        )
        .expect("markdown file");

        let hits = search_markdown_files(temp.path(), "markdown").expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 2);
    }

    #[test]
    fn collects_markdown_paths_from_startup_args() {
        let temp = tempdir().expect("temp dir");
        let markdown = temp.path().join("note.md");
        let text = temp.path().join("note.txt");
        fs::write(&markdown, "# note").expect("markdown file");
        fs::write(&text, "plain").expect("text file");

        let paths = collect_startup_markdown_paths(vec![
            OsString::from("--ignored"),
            markdown.as_os_str().to_owned(),
            text.as_os_str().to_owned(),
        ]);

        assert_eq!(
            paths,
            vec![markdown
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        );
    }
}
