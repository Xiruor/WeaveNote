"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CaretRight,
  FolderPlus,
  Folder,
  FolderOpen,
  Notebook,
  NotePencil,
  PencilSimple,
  Plus,
  PushPin,
  SidebarSimple,
  Trash,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface FolderLite {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: Date;
}

export interface NoteLite {
  id: string;
  title: string;
  folderId: string | null;
  pinned: boolean;
  updatedAt: Date;
  /** 正文纯文本摘要（列表接口附加字段，卡片展示用） */
  snippet: string;
}

interface TreeNode extends FolderLite {
  children: TreeNode[];
  noteCount: number;
}

type DialogState =
  | { mode: "input"; title: string; action: "new-folder" | "rename-folder" | "new-note" | "rename-note"; folderId?: string; value: string; placeholder: string }
  | { mode: "confirm"; title: string; description: string; action: "delete-folder" | "delete-note"; targetId: string };

function formatTime(date: Date): string {
  const d = new Date(date);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function NotesLibrary({
  initialFolders,
  initialNotes,
}: {
  initialFolders: FolderLite[];
  initialNotes: NoteLite[];
}) {
  const router = useRouter();
  const [folders, setFolders] = useState(initialFolders);
  const [notes, setNotes] = useState(initialNotes);
  // null=全部笔记，"root"=未归档，其余=文件夹 id
  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [busy, setBusy] = useState(false);
  // 文件夹侧栏：默认收起，点击才展开
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [foldersRes, notesRes] = await Promise.all([
        fetch("/api/folders"),
        fetch("/api/notes"),
      ]);
      if (!foldersRes.ok || !notesRes.ok) throw new Error();
      const foldersData = await foldersRes.json();
      const notesData = await notesRes.json();
      setFolders(foldersData.folders ?? []);
      setNotes(notesData.notes ?? []);
    } catch {
      toast.error("刷新失败，请重试");
    }
  }, []);

  const noteCountByFolder = useMemo(() => {
    const map = new Map<string | null, number>();
    for (const n of notes) map.set(n.folderId, (map.get(n.folderId) ?? 0) + 1);
    return map;
  }, [notes]);

  // 扁平 → 树；父文件夹被删/异主时孤儿挂到根
  const tree = useMemo(() => {
    const byParent = new Map<string | null, TreeNode[]>();
    const nodes = new Map(folders.map((f) => [f.id, { ...f, children: [] as TreeNode[], noteCount: noteCountByFolder.get(f.id) ?? 0 }]));
    for (const node of nodes.values()) {
      const parentKey = node.parentId && nodes.has(node.parentId) ? node.parentId : null;
      if (!byParent.has(parentKey)) byParent.set(parentKey, []);
      byParent.get(parentKey)!.push(node);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }
    return byParent.get(null) ?? [];
  }, [folders, noteCountByFolder]);

  const visibleNotes = useMemo(() => {
    if (selected === null) return notes;
    if (selected === "root") return notes.filter((n) => !n.folderId);
    const ids = new Set<string>([selected]);
    // 把子树里的笔记也算进来（树渲染已保证无环）
    const queue = [selected];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const f of folders) {
        if (f.parentId === cur && !ids.has(f.id)) {
          ids.add(f.id);
          queue.push(f.id);
        }
      }
    }
    return notes.filter((n) => n.folderId && ids.has(n.folderId));
  }, [notes, folders, selected]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function mutate(fn: () => Promise<boolean>, successMsg?: string) {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await fn();
      if (ok && successMsg) toast.success(successMsg);
      if (ok) await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function api(method: string, url: string, body?: unknown): Promise<unknown> {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      toast.error(data?.error ?? "操作失败");
      return null;
    }
    return res.json();
  }

  function createNote(folderId: string | null) {
    setDialog({
      mode: "input",
      title: "新建笔记",
      action: "new-note",
      folderId: folderId ?? undefined,
      value: "",
      placeholder: "笔记标题（留空则用「未命名笔记」）",
    });
  }

  function createFolder(parentId: string | null) {
    setDialog({
      mode: "input",
      title: parentId ? "新建子文件夹" : "新建文件夹",
      action: "new-folder",
      folderId: parentId ?? undefined,
      value: "",
      placeholder: "文件夹名称",
    });
  }

  function renameFolder(folder: FolderLite) {
    setDialog({
      mode: "input",
      title: "重命名文件夹",
      action: "rename-folder",
      folderId: folder.id,
      value: folder.name,
      placeholder: "文件夹名称",
    });
  }

  function renameNote(note: NoteLite) {
    setDialog({
      mode: "input",
      title: "重命名笔记",
      action: "rename-note",
      folderId: note.id,
      value: note.title,
      placeholder: "笔记标题",
    });
  }

  function deleteFolder(folder: FolderLite) {
    setDialog({
      mode: "confirm",
      title: `删除文件夹「${folder.name}」？`,
      description: "子文件夹会一并删除，其中的笔记不会删除，将回到根目录。",
      action: "delete-folder",
      targetId: folder.id,
    });
  }

  function deleteNote(note: NoteLite) {
    setDialog({
      mode: "confirm",
      title: `删除笔记「${note.title}」？`,
      description: "笔记内容与 AI 对话记录将被删除，无法恢复。",
      action: "delete-note",
      targetId: note.id,
    });
  }

  function handleDialogConfirm() {
    if (!dialog) return;
    if (dialog.mode === "input") {
      const value = dialog.value.trim();
      if (dialog.action === "new-folder") {
        if (!value) {
          toast.error("文件夹名称不能为空");
          return;
        }
        void mutate(
          () => api("POST", "/api/folders", { name: value, parentId: dialog.folderId ?? null }).then(Boolean),
          "文件夹已创建"
        );
      } else if (dialog.action === "rename-folder") {
        if (!value) {
          toast.error("文件夹名称不能为空");
          return;
        }
        void mutate(
          () => api("PATCH", `/api/folders/${dialog.folderId}`, { name: value }).then(Boolean),
          "已重命名"
        );
      } else if (dialog.action === "rename-note") {
        if (!value) {
          toast.error("标题不能为空");
          return;
        }
        void mutate(
          () => api("PATCH", `/api/notes/${dialog.folderId}`, { title: value }).then(Boolean),
          "已重命名"
        );
      } else if (dialog.action === "new-note") {
        void mutate(async () => {
          const data = (await api("POST", "/api/notes", {
            title: value || undefined,
            folderId: dialog.folderId ?? null,
            content: "",
          })) as { note?: { id: string } } | null;
          if (data?.note?.id) router.push(`/notes/${data.note.id}`);
          return true;
        });
      }
    } else if (dialog.mode === "confirm") {
      if (dialog.action === "delete-folder") {
        void mutate(
          () => api("DELETE", `/api/folders/${dialog.targetId}`).then(Boolean),
          "文件夹已删除"
        );
      } else if (dialog.action === "delete-note") {
        void mutate(
          () => api("DELETE", `/api/notes/${dialog.targetId}`).then(Boolean),
          "笔记已删除"
        );
      }
    }
    setDialog(null);
  }

  function moveNote(note: NoteLite, folderId: string | null) {
    if (note.folderId === folderId) return;
    void mutate(
      () => api("PATCH", `/api/notes/${note.id}`, { folderId }).then(Boolean),
      folderId ? "已移动到新文件夹" : "已移出文件夹"
    );
  }

  function togglePin(note: NoteLite) {
    void mutate(() => api("PATCH", `/api/notes/${note.id}`, { pinned: !note.pinned }).then(Boolean));
  }

  const renderFolderNode = (node: TreeNode, depth: number) => {
    const isOpen = expanded.has(node.id);
    const isSelected = selected === node.id;
    return (
      <div key={node.id}>
        <div
          className={`group flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm transition-colors ${
            isSelected ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-white/[0.06]"
          }`}
          style={{ paddingLeft: `${8 + depth * 16}px` }}
        >
          <button
            type="button"
            onClick={() => toggleExpand(node.id)}
            className={`shrink-0 rounded p-0.5 text-muted-foreground transition-transform hover:text-foreground ${isOpen ? "rotate-90" : ""} ${node.children.length === 0 ? "invisible" : ""}`}
            aria-label={isOpen ? "收起" : "展开"}
          >
            <CaretRight className="size-3.5" weight="bold" />
          </button>
          <button
            type="button"
            onClick={() => setSelected(node.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {isOpen ? (
              <FolderOpen className="size-4 shrink-0 text-primary/80" weight="duotone" />
            ) : (
              <Folder className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
            )}
            <span className="truncate">{node.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground/60">{node.noteCount}</span>
          </button>
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              title="新建子文件夹"
              onClick={() => createFolder(node.id)}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <FolderPlus className="size-3.5" />
            </button>
            <button
              type="button"
              title="重命名"
              onClick={() => renameFolder(node)}
              className="rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <PencilSimple className="size-3.5" />
            </button>
            <button
              type="button"
              title="删除"
              onClick={() => deleteFolder(node)}
              className="rounded p-1 text-muted-foreground hover:text-red-400"
            >
              <Trash className="size-3.5" />
            </button>
          </div>
        </div>
        {isOpen && node.children.map((child) => renderFolderNode(child, depth + 1))}
      </div>
    );
  };

  const folderOptions = useMemo(() => {
    const list: { id: string; label: string }[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const n of nodes) {
        list.push({ id: n.id, label: `${"　".repeat(depth)}${n.name}` });
        walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    return list;
  }, [tree]);

  return (
    <div className="flex w-full flex-1 gap-3 px-3 py-6">
      {/* 侧栏：文件夹树，默认收起，点击才展开 */}
      <aside
        className={`shrink-0 self-start rounded-2xl border border-white/10 bg-white/[0.04] backdrop-blur-xl transition-all ${
          sidebarOpen ? "w-60 p-3" : "w-11 p-1.5"
        }`}
      >
        <div className={`mb-2 flex items-center ${sidebarOpen ? "justify-between px-1" : "justify-center"}`}>
          {sidebarOpen ? (
            <>
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                文件夹
              </span>
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => createFolder(null)}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  title="新建文件夹"
                >
                  <FolderPlus className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarOpen(false)}
                  className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                  title="收起文件夹"
                >
                  <SidebarSimple className="size-4" />
                </button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:text-foreground"
              title="展开文件夹"
            >
              <SidebarSimple className="size-4" />
            </button>
          )}
        </div>
        {sidebarOpen && (
          <div className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                selected === null ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-white/[0.06]"
              }`}
            >
              <Notebook className="size-4 shrink-0" weight="duotone" />
              全部笔记
              <span className="ml-auto text-[10px] text-muted-foreground/60">{notes.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setSelected("root")}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors ${
                selected === "root" ? "bg-primary/15 text-primary" : "text-foreground/80 hover:bg-white/[0.06]"
              }`}
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" weight="duotone" />
              未归档
              <span className="ml-auto text-[10px] text-muted-foreground/60">{noteCountByFolder.get(null) ?? 0}</span>
            </button>
            {tree.map((node) => renderFolderNode(node, 0))}
          </div>
        )}
      </aside>

      {/* 主区：笔记列表，水平居中 */}
      <section className="flex min-w-0 flex-1 justify-center">
        <div className="w-full max-w-6xl px-1">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">
            {selected === null ? "全部笔记" : selected === "root" ? "未归档" : folders.find((f) => f.id === selected)?.name ?? "笔记"}
          </h1>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => createFolder(selected === "root" ? null : selected)}>
              <FolderPlus className="size-4" />
              新建文件夹
            </Button>
            <Button onClick={() => createNote(selected === "root" ? null : selected)}>
              <Plus className="size-4" weight="bold" />
              新建笔记
            </Button>
          </div>
        </div>

        {visibleNotes.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/15 py-16 text-center">
            <Notebook className="size-10 text-muted-foreground/50" weight="duotone" />
            <p className="text-sm text-muted-foreground">还没有笔记，写下第一篇吧</p>
            <Button variant="outline" onClick={() => createNote(selected === "root" ? null : selected)}>
              <NotePencil className="size-4" />
              新建笔记
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
            {visibleNotes.map((note) => (
              <div
                key={note.id}
                className="group relative flex min-h-[190px] cursor-pointer flex-col rounded-xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-xl transition-all hover:border-primary/40 hover:bg-white/[0.07]"
                onClick={() => router.push(`/notes/${note.id}`)}
              >
                <div className="flex items-start gap-2">
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{note.title}</h3>
                  {note.pinned && <PushPin className="mt-0.5 size-3.5 shrink-0 text-primary" weight="fill" />}
                </div>
                <p
                  className={`mt-2 line-clamp-4 flex-1 text-xs leading-relaxed ${
                    note.snippet ? "text-muted-foreground/70" : "italic text-muted-foreground/40"
                  }`}
                >
                  {note.snippet || "空笔记"}
                </p>
                <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                  <p className="shrink-0 text-[11px] text-muted-foreground/60">{formatTime(note.updatedAt)}</p>
                  <div
                    className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <select
                      value={note.folderId ?? ""}
                      onChange={(e) => moveNote(note, e.target.value || null)}
                      onClick={(e) => e.stopPropagation()}
                      className="max-w-[7rem] rounded-md border border-white/10 bg-white/[0.06] px-1.5 py-1 text-[10px] text-muted-foreground outline-none"
                      aria-label="移动到文件夹"
                    >
                      <option value="">未归档</option>
                      {folderOptions.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      title={note.pinned ? "取消置顶" : "置顶"}
                      onClick={() => togglePin(note)}
                      className="rounded p-1 text-muted-foreground hover:text-primary"
                    >
                      <PushPin className="size-3.5" weight={note.pinned ? "fill" : "regular"} />
                    </button>
                    <button
                      type="button"
                      title="重命名"
                      onClick={() => renameNote(note)}
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                    >
                      <PencilSimple className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      title="删除"
                      onClick={() => deleteNote(note)}
                      className="rounded p-1 text-muted-foreground hover:text-red-400"
                    >
                      <Trash className="size-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
      </section>

      {/* 新建 / 重命名 / 删除确认 公用对话框 */}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          {dialog?.mode === "input" ? (
            <>
              <DialogHeader>
                <DialogTitle>{dialog.title}</DialogTitle>
              </DialogHeader>
              <Input
                autoFocus
                value={dialog.value}
                onChange={(e) =>
                  setDialog((prev) => (prev?.mode === "input" ? { ...prev, value: e.target.value } : prev))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleDialogConfirm();
                }}
                placeholder={dialog.placeholder}
              />
              <DialogFooter className="bg-transparent">
                <Button variant="outline" onClick={() => setDialog(null)}>
                  取消
                </Button>
                <Button onClick={handleDialogConfirm} disabled={busy}>
                  确定
                </Button>
              </DialogFooter>
            </>
          ) : (
            dialog && (
              <>
                <DialogHeader>
                  <DialogTitle>{dialog.title}</DialogTitle>
                  <DialogDescription>{dialog.description}</DialogDescription>
                </DialogHeader>
                <DialogFooter className="bg-transparent">
                  <Button variant="outline" onClick={() => setDialog(null)}>
                    取消
                  </Button>
                  <Button variant="destructive" onClick={handleDialogConfirm} disabled={busy}>
                    删除
                  </Button>
                </DialogFooter>
              </>
            )
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
