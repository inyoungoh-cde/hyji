export interface Project {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  folder_path: string;
  created_at: string;
  updated_at: string;
}

export interface Paper {
  id: string;
  project_id: string | null;
  sort_order: number;
  title: string;
  first_author: string;
  authors: string;
  year: number | null;
  venue: string;
  link: string;
  raw_bibtex: string;
  status: "Surveyed" | "Fully Reviewed" | "Revisit Needed";
  importance: "Noted" | "Potentially Relevant" | "Must-Cite";
  date_read: string;
  summary: string;
  differentiation: string;
  questions: string;
  pdf_path: string;
  pdf_storage: "copy" | "link";
  created_at: string;
  updated_at: string;
}

export interface Annotation {
  id: string;
  paper_id: string;
  type: "highlight" | "memo";
  page: number;
  rects_json: string;
  selected_text: string;
  color: string;
  memo_text: string;
  created_at: string;
}

export interface NoteLink {
  id: string;
  paper_id: string;
  annotation_id: string;
  note_field: "summary" | "differentiation" | "questions";
  bullet_index: number;
  created_at: string;
}

export interface Keyword {
  id: string;
  paper_id: string;
  keyword: string;
  source: "auto" | "manual";
}
