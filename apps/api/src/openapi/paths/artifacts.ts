import {
  badRequest,
  bearerOrCookie,
  jsonResponse,
  notFound,
  unauthorized,
} from "../helpers.js";

const artifactItem = {
  type: "object",
  required: ["type"],
  properties: {
    type: { type: "string" },
    id: { type: "string" },
    sessionId: { type: "string" },
    title: { type: "string" },
    filename: { type: "string" },
    caption: { type: "string" },
    projectId: { type: ["string", "null"] },
  },
};

const ex = (summary: string, value: unknown) => ({ default: { summary, value } });

export const artifactsPaths = {
  "/api/artifacts": {
    get: {
      operationId: "listArtifacts",
      tags: ["Artifacts"],
      summary: "List workspace artifacts in session scope",
      description:
        "Standalone sessions see only standalone artifacts; project sessions see only that project's. Filter by type and search query.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Artifacts.",
          { type: "object", properties: { items: { type: "array", items: artifactItem } } },
          ex("Artifacts", { items: [{ type: "image", id: "cuid123", caption: "hero logo" }] }),
        ),
        "400": badRequest({ error: "Unknown artifact type" }),
        "401": unauthorized,
        "404": notFound({ error: "Session not found", code: "SESSION_NOT_FOUND" }),
      },
    },
  },
  "/api/artifacts/{id}": {
    get: {
      operationId: "getArtifact",
      tags: ["Artifacts"],
      summary: "Read one scoped artifact",
      description: "Requires the `type` query; out-of-scope ids yield 404, never 403 detail.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Artifact.",
          artifactItem,
          ex("Artifact", { type: "image", id: "cuid123", caption: "hero logo" }),
        ),
        "400": badRequest({ error: "type query is required" }),
        "401": unauthorized,
        "404": notFound({ error: "Artifact not found", code: "ARTIFACT_NOT_FOUND" }),
      },
    },
  },
  "/api/artifacts/images/{id}": {
    patch: {
      operationId: "updateImageCaption",
      tags: ["Artifacts"],
      summary: "Update an image caption",
      description: "Captions are 1-280 characters and power find_images for PDF/site reuse.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Updated caption.",
          {
            type: "object",
            required: ["id", "caption"],
            properties: { id: { type: "string" }, caption: { type: "string" } },
          },
          ex("Caption", { id: "cuid123", caption: "hero logo" }),
        ),
        "400": badRequest({ error: "Caption must be 1-280 characters." }),
        "401": unauthorized,
        "404": notFound({ error: "Image not found", code: "IMAGE_NOT_FOUND" }),
      },
    },
  },
  "/api/reports": {
    post: {
      operationId: "createReport",
      tags: ["Artifacts"],
      summary: "Build a PDF report from markdown, chart assets, and citations",
      description: "Renders server-side and stores a derived report document in scope.",
      security: bearerOrCookie,
      responses: {
        "201": jsonResponse(
          "Created report.",
          {
            type: "object",
            required: ["documentId", "filename"],
            properties: { documentId: { type: "string" }, filename: { type: "string" } },
          },
          ex("Report", { documentId: "cuid123", filename: "report.pdf" }),
        ),
        "400": badRequest({ error: "Invalid report payload" }),
        "401": unauthorized,
        "404": notFound({ error: "Session not found", code: "SESSION_NOT_FOUND" }),
      },
    },
  },
  "/api/reports/{id}": {
    patch: {
      operationId: "editReport",
      tags: ["Artifacts"],
      summary: "Revise a report in place",
      description: "Re-renders the same document; edits never mint duplicates.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Revised report.",
          {
            type: "object",
            required: ["documentId", "filename"],
            properties: { documentId: { type: "string" }, filename: { type: "string" } },
          },
          ex("Report", { documentId: "cuid123", filename: "report.pdf" }),
        ),
        "400": badRequest({ error: "Invalid report payload" }),
        "401": unauthorized,
        "404": notFound({ error: "Report not found", code: "REPORT_NOT_FOUND" }),
      },
    },
  },
  "/api/reports/{id}/pdf": {
    get: {
      operationId: "getReportPdf",
      tags: ["Artifacts"],
      summary: "Serve a report PDF for in-chat preview",
      description:
        "Scoped by the caller's session; out-of-scope or non-report ids return 404. Response body is the PDF bytes (inline).",
      security: bearerOrCookie,
      parameters: [
        {
          name: "sessionId",
          in: "query",
          required: true,
          schema: { type: "string", maxLength: 120 },
        },
      ],
      responses: {
        "200": {
          description: "PDF bytes.",
          content: {
            "application/pdf": {
              schema: { type: "string", format: "binary" },
              example: "%PDF-1.7 …",
            },
          },
        },
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
        "404": notFound({ error: "Report not found", code: "REPORT_NOT_FOUND" }),
      },
    },
  },
  "/api/charts/snapshot": {
    post: {
      operationId: "snapshotChart",
      tags: ["Artifacts"],
      summary: "Freeze a chart spec into a captioned image asset",
      description: "Charts render as SVG assets reusable in PDFs and sites.",
      security: bearerOrCookie,
      responses: {
        "201": jsonResponse(
          "Chart snapshot.",
          { type: "object", properties: { image: artifactItem } },
          ex("Snapshot", { image: { type: "image", id: "cuid123", caption: "sales by region" } }),
        ),
        "400": badRequest({ error: "Invalid chart spec" }),
        "401": unauthorized,
      },
    },
  },
  "/api/web-bundles/freeze": {
    post: {
      operationId: "freezeWebBundle",
      tags: ["Artifacts"],
      summary: "Freeze web sources into a bundle for citations",
      description: "Snapshots URLs so reports and sites never link-rot.",
      security: bearerOrCookie,
      responses: {
        "201": jsonResponse(
          "Frozen bundle.",
          {
            type: "object",
            required: ["id", "title"],
            properties: { id: { type: "string" }, title: { type: "string" } },
          },
          ex("Bundle", { id: "cuid123", title: "Market research" }),
        ),
        "400": badRequest({ error: "Invalid bundle payload" }),
        "401": unauthorized,
      },
    },
  },
  "/api/sites": {
    get: {
      operationId: "listScopeSites",
      tags: ["Artifacts"],
      summary: "List sites in the session scope",
      description:
        "Cross-session site registry: edits from any session in scope bump the version, never mint a new site.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Sites.",
          { type: "object", properties: { sites: { type: "array", items: artifactItem } } },
          ex("Sites", { sites: [{ type: "site", siteId: "cuid123", version: 2 }] }),
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
        "404": notFound({ error: "Session not found" }),
      },
    },
  },
  "/api/tasks": {
    get: {
      operationId: "listTasks",
      tags: ["Artifacts"],
      summary: "List scoped workspace tasks",
      description: "Checklist shared by the user and the agent in one scope.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Tasks.",
          { type: "object", properties: { items: { type: "array", items: artifactItem } } },
          ex("Tasks", { items: [{ type: "task", id: "cuid123", title: "Review v2" }] }),
        ),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "createTask",
      tags: ["Artifacts"],
      summary: "Create a workspace task",
      description: "Titles are 1-200 characters; updates mutate the same row.",
      security: bearerOrCookie,
      responses: {
        "201": jsonResponse(
          "Created task.",
          artifactItem,
          ex("Task", { type: "task", id: "cuid123", title: "Review v2" }),
        ),
        "400": badRequest({ error: "Title must be 1-200 characters." }),
        "401": unauthorized,
      },
    },
  },
  "/api/tasks/{id}": {
    patch: {
      operationId: "updateTask",
      tags: ["Artifacts"],
      summary: "Update a task status or title",
      description: "Status moves inbox/doing/done on the same artifact.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Updated task.",
          artifactItem,
          ex("Task", { type: "task", id: "cuid123", title: "Review v2" }),
        ),
        "400": badRequest({ error: "Nothing to update." }),
        "401": unauthorized,
        "404": notFound({ error: "Task not found", code: "TASK_NOT_FOUND" }),
      },
    },
    delete: {
      operationId: "deleteTask",
      tags: ["Artifacts"],
      summary: "Delete a task",
      description: "Scoped delete; out-of-scope ids yield 404.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Deleted.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          ex("Deleted", { ok: true }),
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
        "404": notFound({ error: "Task not found", code: "TASK_NOT_FOUND" }),
      },
    },
  },
  "/api/schedules": {
    get: {
      operationId: "listSchedules",
      tags: ["Artifacts"],
      summary: "List scoped schedules",
      description: "One-shot, daily, and weekly reminders owned by the user.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Schedules.",
          { type: "object", properties: { items: { type: "array", items: artifactItem } } },
          ex("Schedules", { items: [{ type: "schedule", id: "cuid123", title: "Monday brief" }] }),
        ),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "createSchedule",
      tags: ["Artifacts"],
      summary: "Create a schedule",
      description: "Enqueues a BullMQ workspace-schedule job; failures cap at 3 attempts.",
      security: bearerOrCookie,
      responses: {
        "201": jsonResponse(
          "Created schedule.",
          artifactItem,
          ex("Schedule", { type: "schedule", id: "cuid123", title: "Monday brief" }),
        ),
        "400": badRequest({ error: "Invalid schedule payload" }),
        "401": unauthorized,
      },
    },
  },
  "/api/schedules/{id}": {
    delete: {
      operationId: "cancelSchedule",
      tags: ["Artifacts"],
      summary: "Cancel a schedule",
      description: "Marks cancelled and removes the queued job.",
      security: bearerOrCookie,
      responses: {
        "200": jsonResponse(
          "Cancelled.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          ex("Cancelled", { ok: true }),
        ),
        "401": unauthorized,
        "404": notFound({ error: "Schedule not found", code: "SCHEDULE_NOT_FOUND" }),
      },
    },
  },
};
