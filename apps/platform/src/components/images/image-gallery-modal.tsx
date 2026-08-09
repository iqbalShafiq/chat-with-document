import { useEffect, useRef, useState } from "react";
import { FolderKanban } from "lucide-react";
import { GeneratedImageThumbnail } from "#/components/images/generated-image-thumbnail";
import { DialogShell } from "#/components/ui/dialog-shell";
import { Select } from "#/components/ui/select";
import { toGeneratedImageItem } from "#/lib/chat/generated-images";
import {
  fetchProjectImages,
  fetchUserImages,
  listProjects,
  type GeneratedImageMeta,
  type ProjectListItem,
} from "#/lib/api";

export type ImageGalleryModalProps = {
  open: boolean;
  onClose: () => void;
  /** Project to preselect when the gallery opens (current workspace). */
  activeProjectId?: string | null;
};

/** "" = user scope ("Semua"), mirroring the backend's scope=user list. */
const ALL_IMAGES = "";

const PROJECTS_PAGE_SIZE = 50;

export function ImageGalleryModal({
  open,
  onClose,
  activeProjectId = null,
}: ImageGalleryModalProps) {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] =
    useState<string>(ALL_IMAGES);
  const [images, setImages] = useState<GeneratedImageMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  // Per open: refresh the project list and reset the filter to the current scope.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setSelectedProjectId(activeProjectId ?? ALL_IMAGES);
      void listProjects({ limit: PROJECTS_PAGE_SIZE, sort: "name" })
        .then((page) => setProjects(page.items))
        .catch(() => setProjects([]));
    }
    wasOpenRef.current = open;
  }, [open, activeProjectId]);

  // Project-scoped lists include images from ANY session in the project.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const request = selectedProjectId
      ? fetchProjectImages(selectedProjectId)
      : fetchUserImages();
    request
      .then((items) => {
        if (cancelled) return;
        setImages(items);
      })
      .catch(() => {
        if (cancelled) return;
        setImages([]);
        setError("Could not load images");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedProjectId]);

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Images"
      description="Images you generated across chats"
      size="xl"
    >
      {/*
        One scroll surface: project filter sticks at the top with an opaque
        elevated background so grid tiles never show through the toolbar edge.
      */}
      <div className="chat-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="sticky top-0 z-10 border-b border-white/[0.06] bg-canvas-elevated px-3 py-2.5">
          <Select
            ariaLabel="Filter images by project"
            value={selectedProjectId}
            onChange={setSelectedProjectId}
            leadingIcon={
              <FolderKanban className="size-4" strokeWidth={1.75} />
            }
            className="w-full sm:w-56"
            options={[
              { value: ALL_IMAGES, label: "Semua" },
              ...projects.map((project) => ({
                value: project.id,
                label: project.name,
              })),
            ]}
          />
          {error ? (
            <p className="mt-2 text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <div className="p-3">
          {loading ? (
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton-shimmer aspect-square w-full rounded-lg"
                  style={{ opacity: 1 - i * 0.12 }}
                />
              ))}
            </div>
          ) : null}

          {!loading && images.length === 0 ? (
            <p className="px-3 py-12 text-center text-sm text-text-faint">
              Belum ada gambar
            </p>
          ) : null}

          {!loading && images.length > 0 ? (
            <ul className="grid list-none grid-cols-3 gap-2 p-0">
              {images.map((image) => (
                <li key={image.id} className="min-w-0">
                  <GeneratedImageThumbnail image={toGeneratedImageItem(image)} />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </DialogShell>
  );
}
