import { createFileRoute } from "@tanstack/react-router";

import { DocumentsBrowser } from "#/components/documents/documents-browser";

/** Document library: `/documents`. */
export const Route = createFileRoute("/_workspace/documents/")({
  component: DocumentsIndexRoute,
});

function DocumentsIndexRoute() {
  return <DocumentsBrowser key="workspace-documents" />;
}
