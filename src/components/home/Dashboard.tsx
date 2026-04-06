import { useState, useRef } from "react";
import { usePapersStore } from "../../stores/papers";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";
import type { Paper } from "../../types";

const statusColors: Record<string, string> = {
  Surveyed: "bg-[#ffd16636] text-[#ffd166] border-[#ffd16644]",
  "Fully Reviewed": "bg-[#06d6a036] text-[#06d6a0] border-[#06d6a044]",
  "Revisit Needed": "bg-[#ff6b6b36] text-[#ff6b6b] border-[#ff6b6b44]",
};

interface DashboardProps {
  onImportPdf: () => void;
  onSmartPaste: () => void;
}

export function Dashboard({ onImportPdf, onSmartPaste }: DashboardProps) {
  const papers = usePapersStore((s) => s.papers);
  const { projects, createProject } = useProjectsStore();
  const setActivePaper = useUiStore((s) => s.setActivePaper);
  const setSelectedProject = useUiStore((s) => s.setSelectedProject);

  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);


  // Stats
  const surveyed = papers.filter((p) => p.status === "Surveyed").length;
  const reviewed = papers.filter((p) => p.status === "Fully Reviewed").length;
  const revisit = papers.filter((p) => p.status === "Revisit Needed").length;
  const mustCite = papers.filter((p) => p.importance === "Must-Cite").length;

  // Recent papers: sort by date_read desc, top 6
  const recentPapers = [...papers]
    .sort((a, b) => b.date_read.localeCompare(a.date_read))
    .slice(0, 6);

  const handleNewProjectClick = () => {
    setCreatingProject(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleCreateProject = async () => {
    const name = newProjectName.trim();
    if (!name) { setCreatingProject(false); return; }
    await createProject(name);
    setNewProjectName("");
    setCreatingProject(false);
  };

  const handleProjectKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleCreateProject();
    if (e.key === "Escape") { setCreatingProject(false); setNewProjectName(""); }
  };

  const handleProjectClick = (projectId: string) => {
    setSelectedProject(projectId);
  };

  return (
    <div className="h-full overflow-y-auto bg-bg-primary">
      <div className="max-w-2xl mx-auto px-10 py-12">

        {/* Title */}
        <h1 className="text-[22px] font-semibold text-text-primary mb-8">
          HYJI — Highlight Your Journey of Insights
        </h1>

        {/* Quick actions */}
        <div className="flex gap-3 mb-10 flex-wrap">
          <QuickAction icon="📄" label="Import PDF" onClick={onImportPdf} />
          <QuickAction icon="📋" label="Smart Paste" onClick={onSmartPaste} />
          {creatingProject ? (
            <div className="flex items-center gap-2 px-4 py-3 rounded-[10px] border border-accent/50 bg-bg-tertiary">
              <span className="text-[18px]">📁</span>
              <input
                ref={inputRef}
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={handleProjectKeyDown}
                onBlur={handleCreateProject}
                placeholder="Project name…"
                className="bg-transparent text-small text-text-primary outline-none w-28 placeholder:text-text-tertiary selectable"
              />
            </div>
          ) : (
            <QuickAction icon="📁" label="New Project" onClick={handleNewProjectClick} />
          )}
        </div>

        {/* Stats */}
        {papers.length > 0 && (
          <section className="mb-10">
            <SectionHeader>Overview</SectionHeader>
            <div className="grid grid-cols-5 gap-2 mt-3">
              <StatCard label="Total" value={papers.length} />
              <StatCard label="Surveyed" value={surveyed} accent="#ffd166" />
              <StatCard label="Reviewed" value={reviewed} accent="#06d6a0" />
              <StatCard label="Revisit" value={revisit} accent="#ff6b6b" />
              <StatCard label="Must-Cite" value={mustCite} accent="#d62828" />
            </div>
          </section>
        )}

        {/* Recent papers */}
        {recentPapers.length > 0 && (
          <section className="mb-10">
            <SectionHeader>Recent Papers</SectionHeader>
            <div className="flex flex-col gap-1.5 mt-3">
              {recentPapers.map((paper) => (
                <RecentPaperCard
                  key={paper.id}
                  paper={paper}
                  onClick={() => setActivePaper(paper.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Projects */}
        {projects.length > 0 && (
          <section className="mb-10">
            <SectionHeader>Projects</SectionHeader>
            <div className="flex gap-2 flex-wrap mt-3">
              {projects.map((proj) => {
                const count = papers.filter((p) => p.project_id === proj.id).length;
                return (
                  <button
                    key={proj.id}
                    onClick={() => handleProjectClick(proj.id)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-[8px] border border-border bg-bg-secondary hover:border-accent/40 hover:bg-bg-tertiary transition-colors text-small text-text-secondary hover:text-text-primary"
                  >
                    <span className="text-[12px]">📁</span>
                    <span>{proj.name}</span>
                    {count > 0 && (
                      <span className="text-[10px] text-text-tertiary ml-0.5">{count}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Getting Started — shown only when no papers exist yet */}
        {papers.length === 0 && (
          <section className="mb-10">
            <SectionHeader>Getting Started</SectionHeader>
            <div className="grid grid-cols-3 gap-3 mt-3">
              <StartStep
                num={1}
                icon="📁"
                title="Create a project"
                description="Organize papers by topic or reading list. Optional — you can import without a project."
                actionLabel="New Project"
                onAction={handleNewProjectClick}
              />
              <StartStep
                num={2}
                icon="📄"
                title="Import a PDF"
                description="Drag a PDF onto the window, or press Ctrl+O to browse. Metadata is extracted automatically."
                actionLabel="Import PDF"
                onAction={onImportPdf}
              />
              <StartStep
                num={3}
                icon="📋"
                title="Paste BibTeX / arXiv ID"
                description="Have a citation or arXiv ID? Press Ctrl+N to parse it and pre-fill all fields."
                actionLabel="Smart Paste"
                onAction={onSmartPaste}
              />
            </div>
            <div className="mt-5 px-4 py-3 rounded-[8px] bg-bg-secondary border border-border">
              <p className="text-small text-text-tertiary leading-relaxed">
                <span className="text-text-secondary font-medium">Keyboard shortcuts: </span>
                <span className="font-mono text-accent">Ctrl+O</span> Import PDF &nbsp;·&nbsp;
                <span className="font-mono text-accent">Ctrl+N</span> Smart Paste &nbsp;·&nbsp;
                <span className="font-mono text-accent">Ctrl+F</span> Find in PDF &nbsp;·&nbsp;
                <span className="font-mono text-accent">Ctrl+B</span> Toggle sidebar &nbsp;·&nbsp;
                <span className="font-mono text-accent">Ctrl+J</span> Toggle tracker
              </p>
            </div>
          </section>
        )}

      </div>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-wider text-text-tertiary">
      {children}
    </div>
  );
}

function QuickAction({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 px-5 py-3 rounded-[10px] border border-border bg-bg-secondary hover:border-accent/40 hover:bg-bg-tertiary transition-colors duration-150 text-text-secondary hover:text-text-primary"
    >
      <span className="text-[22px]">{icon}</span>
      <span className="text-small font-medium">{label}</span>
    </button>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-3 rounded-[8px] bg-bg-secondary border border-border">
      <span
        className="text-[22px] font-semibold leading-none"
        style={{ color: accent ?? "var(--text-primary)" }}
      >
        {value}
      </span>
      <span className="text-[10px] text-text-tertiary font-medium">{label}</span>
    </div>
  );
}

function StartStep({
  num,
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: {
  num: number;
  icon: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-4 rounded-[10px] border border-border bg-bg-secondary">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold text-text-tertiary bg-bg-tertiary rounded-full w-5 h-5 flex items-center justify-center shrink-0">
          {num}
        </span>
        <span className="text-[18px]">{icon}</span>
        <span className="text-body font-semibold text-text-primary">{title}</span>
      </div>
      <p className="text-small text-text-tertiary leading-relaxed">{description}</p>
      <button
        onClick={onAction}
        className="mt-auto self-start text-[11px] font-medium text-accent hover:opacity-80 transition-opacity"
      >
        {actionLabel} →
      </button>
    </div>
  );
}

function RecentPaperCard({
  paper,
  onClick,
}: {
  paper: Paper;
  onClick: () => void;
}) {
  const author = paper.first_author || paper.authors.split(",")[0]?.trim() || "";
  const meta = [author, paper.year, paper.venue].filter(Boolean).join(" · ");

  return (
    <button
      onClick={onClick}
      className="flex items-start gap-3 px-3 py-2.5 rounded-[8px] border border-transparent hover:bg-bg-secondary hover:border-border transition-colors text-left w-full group"
    >
      <div className="flex-1 min-w-0">
        <div className="text-body font-medium text-text-primary truncate group-hover:text-accent transition-colors">
          {paper.title}
        </div>
        {meta && (
          <div className="text-small text-text-tertiary mt-0.5 truncate">{meta}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold border ${statusColors[paper.status] ?? ""}`}
        >
          {paper.status === "Fully Reviewed"
            ? "Reviewed"
            : paper.status === "Revisit Needed"
              ? "Revisit"
              : paper.status}
        </span>
        <span className="text-[10px] text-text-tertiary">{paper.date_read}</span>
      </div>
    </button>
  );
}
