import { useState } from "react";
import { ProjectState } from "../types";

interface Props {
  project: ProjectState;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onRename: (name: string) => void;
  onSave: () => void;
  savedAt: number | null;
  onExport: () => void;
  onToggleChat: () => void;
  chatOpen: boolean;
}

export default function TopBar(p: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.project.name);
  const [shareCopied, setShareCopied] = useState(false);

  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="logo">LTL<span className="logo-accent">AI</span></span>
        {editing ? (
          <input
            className="project-name-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => { p.onRename(draft || "Untitled Project"); setEditing(false); }}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <button className="project-name" title="Rename project" onClick={() => { setDraft(p.project.name); setEditing(true); }}>
            {p.project.name}
          </button>
        )}
        <span className="aspect-badge">{p.project.aspect}</span>
      </div>
      <div className="topbar-center">
        <button disabled={!p.canUndo} onClick={p.onUndo} title="Undo (Ctrl+Z)">↩ Undo</button>
        <button disabled={!p.canRedo} onClick={p.onRedo} title="Redo (Ctrl+Y)">↪ Redo</button>
        <button onClick={p.onSave} title="Save project">
          💾 {p.savedAt ? "Saved" : "Save"}
        </button>
      </div>
      <div className="topbar-right">
        <button
          onClick={() => {
            navigator.clipboard?.writeText(window.location.href).catch(() => {});
            setShareCopied(true);
            setTimeout(() => setShareCopied(false), 1500);
          }}
        >
          {shareCopied ? "Link copied!" : "Share"}
        </button>
        <button className="export-btn" onClick={p.onExport}>Export</button>
        <button className={p.chatOpen ? "ai-btn active" : "ai-btn"} onClick={p.onToggleChat}>
          ✦ AI Assistant
        </button>
        <div className="avatar" title="Account">N</div>
      </div>
    </header>
  );
}
