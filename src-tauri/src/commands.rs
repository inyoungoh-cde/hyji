use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Paper {
    pub id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub first_author: String,
    pub authors: String,
    pub year: Option<i32>,
    pub venue: String,
    pub code_link: String,
    pub raw_bibtex: String,
    pub task: String,
    pub input_modality: String,
    pub status: String,
    pub importance: String,
    pub date_read: String,
    pub summary: String,
    pub differentiation: String,
    pub questions: String,
    pub pdf_path: String,
    pub pdf_storage: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    pub parent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreatePaperInput {
    pub project_id: Option<String>,
    pub title: String,
    pub first_author: Option<String>,
    pub authors: Option<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePaperInput {
    pub id: String,
    pub title: Option<String>,
    pub first_author: Option<String>,
    pub authors: Option<String>,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub code_link: Option<String>,
    pub task: Option<String>,
    pub input_modality: Option<String>,
    pub status: Option<String>,
    pub importance: Option<String>,
    pub date_read: Option<String>,
    pub summary: Option<String>,
    pub differentiation: Option<String>,
    pub questions: Option<String>,
    pub pdf_path: Option<String>,
    pub pdf_storage: Option<String>,
    pub project_id: Option<String>,
}

// ── Project commands ──

#[tauri::command]
pub async fn create_project(input: CreateProjectInput) -> Result<String, String> {
    // SQL is executed from the frontend via tauri-plugin-sql in Phase 0.1.
    // These commands are placeholders for future Rust-side logic.
    Ok(format!("Project '{}' delegated to frontend SQL", input.name))
}

#[tauri::command]
pub async fn list_projects() -> Result<Vec<Project>, String> {
    Ok(vec![])
}

#[tauri::command]
pub async fn rename_project(id: String, name: String) -> Result<(), String> {
    let _ = (id, name);
    Ok(())
}

#[tauri::command]
pub async fn delete_project(id: String) -> Result<(), String> {
    let _ = id;
    Ok(())
}

// ── Paper commands ──

#[tauri::command]
pub async fn create_paper(input: CreatePaperInput) -> Result<String, String> {
    let _ = input;
    Ok(String::new())
}

#[tauri::command]
pub async fn list_papers(project_id: Option<String>) -> Result<Vec<Paper>, String> {
    let _ = project_id;
    Ok(vec![])
}

#[tauri::command]
pub async fn get_paper(id: String) -> Result<Option<Paper>, String> {
    let _ = id;
    Ok(None)
}

#[tauri::command]
pub async fn update_paper(input: UpdatePaperInput) -> Result<(), String> {
    let _ = input;
    Ok(())
}

#[tauri::command]
pub async fn delete_paper(id: String) -> Result<(), String> {
    let _ = id;
    Ok(())
}

/// Fetch text from an allowlisted metadata API. Runs in Rust because the
/// WebView enforces CORS (arXiv's API sends no CORS headers) and because a
/// proper User-Agent (Crossref "polite pool") must be attached.
///
/// `mailto` is the user's optional polite-pool contact (v2.4): with it,
/// Crossref serves from a per-contact pool with generous limits; without it,
/// requests share the anonymous pool, which intermittently answers HTTP 429.
/// Transient 429/503 responses are retried honoring Retry-After.
#[tauri::command]
pub async fn http_get_text(url: String, mailto: Option<String>) -> Result<String, String> {
    const ALLOWED_PREFIXES: [&str; 2] = [
        "https://api.crossref.org/",
        "https://export.arxiv.org/",
    ];
    if !ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p)) {
        return Err(format!("URL not allowed: {url}"));
    }

    let mut ua = format!(
        "HYJI/{} (+https://github.com/inyoungoh-cde/hyji",
        env!("CARGO_PKG_VERSION")
    );
    if let Some(m) = mailto
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty() && m.contains('@') && m.len() <= 100 && m.is_ascii())
    {
        ua.push_str("; mailto:");
        ua.push_str(m);
    }
    ua.push(')');

    let client = reqwest::Client::builder()
        .user_agent(ua)
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;

    // Walk the source chain so "error sending request" carries its actual
    // cause (dns error / connect timeout / ...) into the user-facing dialog.
    fn err_chain(e: &dyn std::error::Error) -> String {
        let mut s = e.to_string();
        let mut src = e.source();
        while let Some(inner) = src {
            s.push_str(" — ");
            s.push_str(&inner.to_string());
            src = inner.source();
        }
        s
    }

    const MAX_ATTEMPTS: u32 = 3;
    for attempt in 1..=MAX_ATTEMPTS {
        // Connection-level failures (DNS hiccup, transient network drop) are
        // retried just like 429/503 — they are usually gone a second later.
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) if attempt < MAX_ATTEMPTS => {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                let _ = e;
                continue;
            }
            Err(e) => {
                return Err(format!(
                    "Request failed after {MAX_ATTEMPTS} attempts: {}. \
                     Check the network connection and try again.",
                    err_chain(&e)
                ))
            }
        };

        let status = resp.status().as_u16();
        if (status == 429 || status == 503) && attempt < MAX_ATTEMPTS {
            let wait = resp
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(2)
                .clamp(1, 5);
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            continue;
        }
        if status == 429 {
            return Err(
                "HTTP 429 — the metadata service is rate-limiting anonymous requests right now. \
                 Try again in a minute, or set a polite-pool email in Tools → Preferences… → \
                 Network & privacy for a dedicated, faster lane."
                    .to_string(),
            );
        }
        if !resp.status().is_success() {
            return Err(format!("HTTP {status}"));
        }
        return resp.text().await.map_err(|e| format!("Read body: {e}"));
    }
    unreachable!("retry loop always returns")
}
