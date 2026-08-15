export const UUID_EXAMPLE = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
export const SESSION_ID_EXAMPLE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const PROJECT_ID_EXAMPLE = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
export const DOCUMENT_ID_EXAMPLE = "550e8400-e29b-41d4-a716-446655440000";
export const IMAGE_ID_EXAMPLE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
export const USER_ID_EXAMPLE = "c56a4180-65aa-42ec-a945-5fd21dec0538";
export const STREAM_ID_EXAMPLE = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
export const ISO_EXAMPLE = "2026-08-15T10:15:30.000Z";

export const errorSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: { type: "string" },
    code: { type: "string" },
  },
} as const;

export const okSchema = {
  type: "object",
  required: ["ok"],
  properties: {
    ok: { type: "boolean", const: true },
  },
} as const;

export const userSchema = {
  type: "object",
  required: ["id", "email", "name"],
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    name: { type: "string" },
    image: { type: ["string", "null"] },
    emailVerified: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const sessionRowSchema = {
  type: "object",
  required: ["id", "userId", "expiresAt"],
  properties: {
    id: { type: "string" },
    userId: { type: "string", format: "uuid" },
    token: { type: "string" },
    expiresAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    ipAddress: { type: ["string", "null"] },
    userAgent: { type: ["string", "null"] },
  },
} as const;

export const chatSessionSchema = {
  type: "object",
  required: ["sessionId", "projectId", "title"],
  properties: {
    sessionId: { type: "string", format: "uuid" },
    projectId: { type: ["string", "null"], format: "uuid" },
    title: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const sessionListItemSchema = {
  type: "object",
  required: ["sessionId", "updatedAt", "title", "projectId", "unread"],
  properties: {
    sessionId: { type: "string", format: "uuid" },
    updatedAt: { type: "string", format: "date-time" },
    title: { type: "string" },
    projectId: { type: ["string", "null"], format: "uuid" },
    unread: { type: "boolean" },
  },
} as const;

export const chatMessageSchema = {
  type: "object",
  required: ["role", "content"],
  properties: {
    role: { type: "string", enum: ["user", "assistant", "system", "tool"] },
    content: {
      type: "array",
      items: {
        type: "object",
        required: ["type"],
        properties: {
          type: { type: "string" },
          text: { type: "string" },
        },
        additionalProperties: true,
      },
    },
    metadata: { type: "object", additionalProperties: true },
  },
} as const;

export const contextSnippetSchema = {
  type: "object",
  required: ["id", "text", "sourceRole", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    text: { type: "string", maxLength: 2000 },
    sourceRole: { type: "string", enum: ["user", "assistant"] },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const projectSchema = {
  type: "object",
  required: [
    "id",
    "name",
    "description",
    "documentCount",
    "chatCount",
    "lastOpenedAt",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    description: { type: ["string", "null"] },
    documentCount: { type: "integer" },
    chatCount: { type: "integer" },
    lastOpenedAt: { type: ["string", "null"], format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const documentLibraryItemSchema = {
  type: "object",
  required: [
    "id",
    "filename",
    "firstPageSummary",
    "sizeBytes",
    "mimeType",
    "pageCount",
    "createdAt",
    "originSessionId",
    "projectId",
    "projectName",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    filename: { type: "string" },
    firstPageSummary: { type: "string" },
    sizeBytes: { type: "integer" },
    mimeType: { type: "string" },
    pageCount: { type: "integer" },
    createdAt: { type: "string", format: "date-time" },
    originSessionId: { type: "string", format: "uuid" },
    projectId: { type: ["string", "null"], format: "uuid" },
    projectName: { type: ["string", "null"] },
  },
} as const;

export const sessionDocumentSchema = {
  type: "object",
  required: [
    "id",
    "filename",
    "firstPageSummary",
    "sizeBytes",
    "mimeType",
    "pageCount",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    filename: { type: "string" },
    firstPageSummary: { type: "string" },
    sizeBytes: { type: "integer" },
    mimeType: { type: "string" },
    pageCount: { type: "integer" },
  },
} as const;

export const imageMetadataSchema = {
  type: "object",
  required: [
    "id",
    "userId",
    "projectId",
    "sessionId",
    "mediaType",
    "width",
    "height",
    "modelId",
    "prompt",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    userId: { type: "string", format: "uuid" },
    projectId: { type: ["string", "null"], format: "uuid" },
    sessionId: { type: "string", format: "uuid" },
    mediaType: { type: "string" },
    width: { type: "integer" },
    height: { type: "integer" },
    modelId: { type: "string" },
    prompt: { type: "string" },
    nOfTotal: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

export const storageUsageSchema = {
  type: "object",
  required: ["usedBytes", "maxBytes", "remainingBytes"],
  properties: {
    usedBytes: { type: "integer" },
    maxBytes: { type: "integer" },
    remainingBytes: { type: "integer" },
  },
} as const;

export const profileDtoSchema = {
  type: "object",
  required: ["sections", "explicitFacts", "updatedAt"],
  properties: {
    sections: { type: "object", additionalProperties: true },
    explicitFacts: {
      type: "array",
      items: {
        type: "object",
        required: ["section", "fact", "createdAt"],
        properties: {
          section: { type: ["string", "null"] },
          fact: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          source: {
            type: "object",
            properties: {
              sessionId: { type: "string" },
              messageId: { type: "string" },
            },
          },
        },
      },
    },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const modelInfoSchema = {
  type: "object",
  required: [
    "modelId",
    "label",
    "name",
    "provider",
    "contextWindowTokens",
    "prices",
    "reasoningEfforts",
    "outputType",
    "inputModalities",
    "sortOrder",
  ],
  properties: {
    modelId: { type: "string" },
    label: { type: "string" },
    name: { type: "string" },
    hint: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    iconSvg: { type: "string" },
    provider: {
      type: "object",
      required: ["slug", "name"],
      properties: {
        slug: { type: "string" },
        name: { type: "string" },
      },
    },
    contextWindowTokens: { type: "integer" },
    maxInputTokens: { type: ["integer", "null"] },
    maxOutputTokens: { type: ["integer", "null"] },
    prices: { type: "object", additionalProperties: true },
    reasoningEfforts: { type: "array", items: { type: "string" } },
    outputType: { type: "string", enum: ["text", "image"] },
    imageCapabilities: { type: ["object", "null"], additionalProperties: true },
    inputModalities: { type: "array", items: { type: "string" } },
    sortOrder: { type: "integer" },
  },
} as const;

export const exampleUser = {
  id: USER_ID_EXAMPLE,
  email: "ada@example.com",
  name: "Ada Lovelace",
  image: null,
  emailVerified: false,
  createdAt: ISO_EXAMPLE,
  updatedAt: ISO_EXAMPLE,
};

export const exampleChatSession = {
  sessionId: SESSION_ID_EXAMPLE,
  projectId: null,
  title: "New chat",
  createdAt: ISO_EXAMPLE,
  updatedAt: ISO_EXAMPLE,
};

export const exampleProject = {
  id: PROJECT_ID_EXAMPLE,
  name: "Q3 research",
  description: "Papers for the quarterly review",
  documentCount: 4,
  chatCount: 2,
  lastOpenedAt: ISO_EXAMPLE,
  createdAt: ISO_EXAMPLE,
  updatedAt: ISO_EXAMPLE,
};

export const exampleImage = {
  id: IMAGE_ID_EXAMPLE,
  userId: USER_ID_EXAMPLE,
  projectId: null,
  sessionId: SESSION_ID_EXAMPLE,
  mediaType: "image/png",
  width: 1024,
  height: 1024,
  modelId: "openai/gpt-5-image-mini",
  prompt: "A watercolor fox in a library",
  nOfTotal: "1/1",
  createdAt: ISO_EXAMPLE,
};

export const exampleSessionDocument = {
  id: DOCUMENT_ID_EXAMPLE,
  filename: "quarterly-report.pdf",
  firstPageSummary: "Q3 revenue grew 12% year over year.",
  sizeBytes: 245760,
  mimeType: "application/pdf",
  pageCount: 8,
};

export const openApiComponents = {
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      description:
        "Session token from the `set-auth-token` response header on `POST /api/auth/sign-in/email` or `POST /api/auth/sign-up/email`. Send as `Authorization: Bearer <token>`. Preferred for mobile and extra-repo clients.",
    },
    cookieAuth: {
      type: "apiKey",
      in: "cookie",
      name: "better-auth.session_token",
      description:
        "HTTP-only session cookie set by Better Auth. Used by the web platform with `credentials: include`.",
    },
  },
  schemas: {
    Error: errorSchema,
    Ok: okSchema,
    User: userSchema,
    Session: sessionRowSchema,
    ChatSession: chatSessionSchema,
    SessionListItem: sessionListItemSchema,
    ChatMessage: chatMessageSchema,
    ContextSnippet: contextSnippetSchema,
    Project: projectSchema,
    DocumentLibraryItem: documentLibraryItemSchema,
    SessionDocument: sessionDocumentSchema,
    ImageMetadata: imageMetadataSchema,
    StorageUsage: storageUsageSchema,
    Profile: profileDtoSchema,
    ModelInfo: modelInfoSchema,
  },
};
