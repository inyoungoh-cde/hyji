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
