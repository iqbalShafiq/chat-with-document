import { Link } from "@tanstack/react-router";
import { AnrealMark } from "#/components/layout/anreal-brand";

const linkClass =
  "glass glass-interactive inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text transition active:scale-[0.98]";
const secondaryLinkClass =
  "inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text-muted transition hover:text-text active:scale-[0.98]";

function NotFoundFrame(input: {
  title: string;
  description: string;
  action: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center animate-fade-up">
      <AnrealMark className="opacity-80" />
      <h1 className="text-lg font-semibold text-text">{input.title}</h1>
      <p className="max-w-md text-sm text-text-muted">{input.description}</p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        {input.action}
        <Link to="/" className={secondaryLinkClass}>
          New chat
        </Link>
      </div>
    </div>
  );
}

export function SessionNotFound(input: {
  projectId: string | null;
}): React.JSX.Element {
  return (
    <NotFoundFrame
      title="Conversation not found"
      description="This link points to a conversation that was deleted or belongs to another workspace. Check the address or pick another chat."
      action={
        input.projectId ? (
          <Link
            to="/projects/$projectId"
            params={{ projectId: input.projectId }}
            className={linkClass}
          >
            Back to project
          </Link>
        ) : (
          <Link to="/" className={linkClass}>
            Back to chats
          </Link>
        )
      }
    />
  );
}

export function ProjectNotFound(): React.JSX.Element {
  return (
    <NotFoundFrame
      title="Project not found"
      description="This link points to a project that was deleted or you no longer own. Browse your projects or open the document library."
      action={
        <Link to="/projects" className={linkClass}>
          Back to projects
        </Link>
      }
    />
  );
}
