import { createFileRoute, Link } from "@tanstack/react-router";
import { AnrealMark, AnrealWordmark } from "#/components/layout/anreal-brand";
import {
  AnonymousShareRoom,
  AuthenticatedShareRoom,
  ShareLoading,
  useShareAuth,
  useShareThreadData,
} from "#/components/share/share-thread";

/**
 * Public share page: no sidebar, no auth gate. Anonymous readers get the
 * exact chat room (bubbles, composer shell, right rail) in read-only mode
 * with a login/register CTA above the composer. Signed-in readers get the
 * same room with a live CTA composer: Send forks the snapshot server-side
 * into their own session, then the draft auto-sends there through the
 * standard chat pipeline so the AI reacts in place.
 */
export const Route = createFileRoute("/share/$shareToken")({
  component: SharePage,
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
});

function SharePage() {
  const { shareToken } = Route.useParams();
  const thread = useShareThreadData(shareToken);
  const { signedIn, authChecked } = useShareAuth();

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] flex-col overflow-hidden text-text">
      <div className="relative z-[1] flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="glass-top-bar flex h-14 shrink-0 items-center gap-2.5 px-3 md:px-4">
          <AnrealMark />
          <AnrealWordmark className="truncate" />
          <span className="min-w-0 flex-1" />
          {!authChecked ? null : signedIn ? (
            <Link
              to="/"
              className="glass glass-interactive inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98]"
            >
              Open my chats
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                search={{ redirect: `/share/${shareToken}` }}
                className="inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text-muted transition hover:text-text active:scale-[0.98]"
              >
                Log in
              </Link>
              <Link
                to="/register"
                search={{ redirect: `/share/${shareToken}` }}
                className="glass glass-interactive inline-flex min-h-9 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98]"
              >
                Sign up
              </Link>
            </>
          )}
        </header>

        <main className="relative flex min-h-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            {thread.status === "loading" || !authChecked ? <ShareLoading /> : null}

            {thread.status === "missing" && authChecked ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center animate-fade-up">
                <AnrealMark className="opacity-80" />
                <h1 className="text-lg font-semibold text-text">
                  Shared link not found
                </h1>
                <p className="max-w-md text-sm text-text-muted">
                  This link was deactivated or the original chat was deleted.
                  Ask the owner for a fresh link.
                </p>
                <Link
                  to="/"
                  className="glass glass-interactive mt-1 inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98]"
                >
                  New chat
                </Link>
              </div>
            ) : null}

            {thread.status === "ready" && thread.messages && authChecked ? (
              signedIn ? (
                <AuthenticatedShareRoom
                  shareToken={shareToken}
                  title={thread.title}
                  ownerName={thread.ownerName}
                  createdAt={thread.createdAt}
                  messages={thread.messages}
                />
              ) : (
                <AnonymousShareRoom
                  shareToken={shareToken}
                  title={thread.title}
                  ownerName={thread.ownerName}
                  createdAt={thread.createdAt}
                  messages={thread.messages}
                />
              )
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
