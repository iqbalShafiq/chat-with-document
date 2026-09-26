import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Download, ExternalLink, MessageSquare } from "lucide-react";
import { DialogShell } from "#/components/ui/dialog-shell";
import { API_BASE, createChatSession } from "#/lib/api";
import {
  getChatSessionDetail,
  listScopeSites,
  type ScopeSite,
} from "#/lib/api-artifacts";
import { queueShareForkDraft } from "#/lib/chat/queued-messages";
import { sessionNavigate } from "#/lib/workspace-urls";

/**
 * Sidebar sites entry: every static site in the active session scope
 * (cross-session registry), with preview + download. Version history and
 * rollback stay in the chat build panel where the build ran.
 */
export function SitesBrowser({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  const [sites, setSites] = useState<ScopeSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chatTarget, setChatTarget] = useState<ScopeSite | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) {
      setChatTarget(null);
      setChatError(null);
      setChatBusy(false);
    }
  }, [open]);

  const openChatInOriginSession = async (site: ScopeSite) => {
    setChatBusy(true);
    setChatError(null);
    try {
      // Site manifests only carry their origin session; resolve its project
      // for the canonical URL (standalone vs project room).
      const origin = await getChatSessionDetail(site.sessionId);
      await navigate(sessionNavigate({ sessionId: site.sessionId, projectId: origin.projectId }));
      setChatTarget(null);
      setChatError(null);
      onClose();
    } catch (fetchError) {
      setChatError(fetchError instanceof Error ? fetchError.message : "Could not open chat");
    } finally {
      setChatBusy(false);
    }
  };

  const openChatInNewSession = async (site: ScopeSite) => {
    setChatBusy(true);
    setChatError(null);
    try {
      const origin = await getChatSessionDetail(site.sessionId).catch(() => null);
      const created = await createChatSession({ projectId: origin?.projectId ?? null });
      queueShareForkDraft(created.sessionId, {
        text: "Lanjutkan site ini",
        attachments: [],
        autoSend: false,
        pinnedArtifacts: [
          {
            type: "site",
            id: site.siteId,
            label: site.siteId.slice(0, 8),
          },
        ],
      });
      await navigate(
        sessionNavigate({ sessionId: created.sessionId, projectId: created.projectId }),
      );
      setChatTarget(null);
      setChatError(null);
      onClose();
    } catch (fetchError) {
      setChatError(fetchError instanceof Error ? fetchError.message : "Could not open chat");
    } finally {
      setChatBusy(false);
    }
  };

  useEffect(() => {
    if (!open || !sessionId) return;
    let cancelled = false;
    setSites(null);
    setError(null);
    void listScopeSites(sessionId)
      .then((loaded) => {
        if (!cancelled) setSites(loaded);
      })
      .catch((fetchError) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load sites");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId]);

  if (!open) return null;
  return (
    <>
    <DialogShell
      open={open && chatTarget === null}
      onClose={onClose}
      title="Sites"
      description="Static sites in this scope, from any session."
      size="lg"
      heightMode="viewport"
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <div className="chat-scroll-bleed absolute inset-0 overflow-y-auto overscroll-contain p-4">
          <div className="flex flex-col gap-3">
      {!sessionId ? (
        <p className="text-[12px] text-text-muted">
          Open a chat first — sites live in the active session scope.
        </p>
      ) : error ? (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              setError(null);
              setSites(null);
              void listScopeSites(sessionId).then(setSites).catch((e) => {
                setError(e instanceof Error ? e.message : "Failed to load sites");
              });
            }}
            className="h-7 w-fit cursor-pointer rounded-lg border border-white/[0.08] px-2.5 text-[11px] text-text-muted hover:text-text"
          >
            Retry
          </button>
        </div>
      ) : sites === null ? (
        <div className="flex flex-col gap-1.5" aria-label="Loading sites">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton-shimmer h-12 rounded-xl" />
          ))}
        </div>
      ) : sites.length === 0 ? (
        <p className="text-[12px] text-text-muted">
          No sites yet — ask the agent to build one in chat.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {sites.map((site) => (
            <li
              key={site.siteId}
              className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {site.siteName ?? site.siteId.slice(0, 8)} · v{site.version}
                </p>
                <p className="truncate text-[11px] text-text-faint">{site.status}</p>
              </div>
              {site.previewUrl ? (
                <a
                  href={`${API_BASE}${site.previewUrl}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Preview site ${site.siteId.slice(0, 8)}`}
                  className="inline-flex size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.08] hover:text-text"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              ) : null}
              <a
                href={`${API_BASE}${site.downloadUrl}`}
                aria-label={`Download site ${site.siteId.slice(0, 8)}`}
                className="inline-flex size-7 items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.08] hover:text-text"
              >
                <Download className="size-3.5" />
              </a>
              <button
                type="button"
                aria-label={`Chat about site ${site.siteId.slice(0, 8)}`}
                title="Chat about this site"
                onClick={() => {
                  setChatTarget(site);
                  setChatError(null);
                }}
                className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.08] hover:text-text active:scale-95"
              >
                <MessageSquare className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
          </div>
        </div>
      </div>
    </DialogShell>

    <DialogShell
      open={chatTarget !== null}
      onClose={() => {
        if (!chatBusy) {
          setChatTarget(null);
          setChatError(null);
        }
      }}
      title="Chat about this site"
      description={
        chatTarget ? `Site ${chatTarget.siteId.slice(0, 8)} · v${chatTarget.version}` : undefined
      }
      size="sm"
      heightMode="content"
    >
      <div className="p-4">
      <div className="flex flex-col gap-2">
        {chatError ? (
          <p role="alert" className="text-[11px] text-danger">
            {chatError}
          </p>
        ) : null}
        <button
          type="button"
          disabled={chatBusy || !chatTarget}
          onClick={() => chatTarget && void openChatInOriginSession(chatTarget)}
          className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-left transition hover:bg-white/[0.07] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-[12px] font-semibold text-text">Continue in its session</span>
          <span className="text-[11px] text-text-muted">
            Full history and build context stay intact.
          </span>
        </button>
        <button
          type="button"
          disabled={chatBusy || !chatTarget}
          onClick={() => chatTarget && void openChatInNewSession(chatTarget)}
          className="flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2.5 text-left transition hover:bg-white/[0.07] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <span className="text-[12px] font-semibold text-text">Start a new chat</span>
          <span className="text-[11px] text-text-muted">
            Clean room with the site pinned for the agent.
          </span>
        </button>
      </div>
      </div>
    </DialogShell>
    </>
  );
}
