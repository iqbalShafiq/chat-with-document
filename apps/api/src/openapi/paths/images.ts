import {
  IMAGE_ID_EXAMPLE,
  PROJECT_ID_EXAMPLE,
  SESSION_ID_EXAMPLE,
  exampleImage,
  imageMetadataSchema,
} from "../components.js";
import {
  badRequest,
  bearerOrCookie,
  forbidden,
  jsonResponse,
  jsonSchema,
  notFound,
  unauthorized,
} from "../helpers.js";

const imageList = {
  type: "object",
  required: ["images"],
  properties: {
    images: { type: "array", items: imageMetadataSchema },
  },
};

export const imagesPaths = {
  "/api/images": {
    get: {
      operationId: "listImages",
      tags: ["Images"],
      summary: "List generated / uploaded images",
      description:
        "Exactly one filter is required:\n\n- `sessionId` — gallery for that chat\n- `projectId` — gallery for that project\n- `scope=user` — every image the user owns\n\n`r2Key` is never returned.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "sessionId",
          in: "query",
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
        {
          name: "projectId",
          in: "query",
          schema: { type: "string", format: "uuid" },
          example: PROJECT_ID_EXAMPLE,
        },
        {
          name: "scope",
          in: "query",
          schema: { type: "string", enum: ["user"] },
          example: "user",
        },
      ],
      responses: {
        "200": jsonResponse("Image metadata list.", imageList, {
          default: {
            summary: "One image",
            value: { images: [exampleImage] },
          },
          empty: { summary: "None yet", value: { images: [] } },
        }),
        "400": badRequest({
          error: "sessionId, projectId, or scope=user is required",
        }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "uploadImage",
      tags: ["Images"],
      summary: "Upload an image into a session",
      description:
        "Multipart. Fields: `file` (must be `image/*`), `sessionId`, optional `projectId`, `width`, `height`. Stored as `modelId: \"user-upload\"`. The session must belong to the user.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: {
          "multipart/form-data": {
            schema: {
              type: "object",
              required: ["file", "sessionId"],
              properties: {
                file: { type: "string", format: "binary" },
                sessionId: { type: "string", format: "uuid" },
                projectId: { type: "string", format: "uuid" },
                width: { type: "integer" },
                height: { type: "integer" },
              },
            },
            examples: {
              default: {
                summary: "PNG into a chat",
                value: {
                  file: "(binary)",
                  sessionId: SESSION_ID_EXAMPLE,
                  width: 1024,
                  height: 1024,
                },
              },
            },
          },
        },
      },
      responses: {
        "201": jsonResponse(
          "Uploaded.",
          {
            type: "object",
            required: ["image"],
            properties: { image: imageMetadataSchema },
          },
          {
            default: {
              summary: "Saved",
              value: {
                image: { ...exampleImage, modelId: "user-upload", prompt: "photo.png" },
              },
            },
          },
        ),
        "400": badRequest({ error: "file is required" }),
        "401": unauthorized,
        "404": notFound({ error: "Session not found" }),
        "500": jsonResponse(
          "Upload failed (R2 or persistence).",
          { type: "object", required: ["error"], properties: { error: { type: "string" } } },
          {
            default: {
              summary: "Storage error",
              value: { error: "Could not upload image" },
            },
          },
        ),
      },
    },
  },
  "/api/images/context": {
    get: {
      operationId: "listSessionImageContext",
      tags: ["Images"],
      summary: "Images pinned as chat context",
      description:
        "Subset of session images the user pinned so the agent can see them on later turns.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "sessionId",
          in: "query",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse("Pinned images.", imageList, {
          default: { summary: "One pin", value: { images: [exampleImage] } },
          empty: { summary: "None pinned", value: { images: [] } },
        }),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
    post: {
      operationId: "pinSessionImageContext",
      tags: ["Images"],
      summary: "Pin an image as session context",
      description:
        "The image must already belong to the session. Returns `404` when it does not.",
      security: bearerOrCookie,
      requestBody: {
        required: true,
        content: jsonSchema(
          {
            type: "object",
            required: ["sessionId", "imageId"],
            properties: {
              sessionId: { type: "string", format: "uuid" },
              imageId: { type: "string", format: "uuid" },
            },
          },
          {
            default: {
              summary: "Pin",
              value: {
                sessionId: SESSION_ID_EXAMPLE,
                imageId: IMAGE_ID_EXAMPLE,
              },
            },
          },
        ),
      },
      responses: {
        "200": jsonResponse(
          "Pinned.",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          { default: { summary: "Pinned", value: { ok: true } } },
        ),
        "400": badRequest({ error: "sessionId and imageId are required" }),
        "401": unauthorized,
        "404": notFound({ error: "Image not found in this session" }),
      },
    },
  },
  "/api/images/context/{imageId}": {
    delete: {
      operationId: "unpinSessionImageContext",
      tags: ["Images"],
      summary: "Unpin an image from session context",
      description: "`sessionId` is required as a query parameter.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "imageId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: IMAGE_ID_EXAMPLE,
        },
        {
          name: "sessionId",
          in: "query",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: SESSION_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": jsonResponse(
          "Unpinned (idempotent even if it was not pinned).",
          { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } },
          { default: { summary: "Unpinned", value: { ok: true } } },
        ),
        "400": badRequest({ error: "sessionId is required" }),
        "401": unauthorized,
      },
    },
  },
  "/api/images/{id}": {
    get: {
      operationId: "getImageBytes",
      tags: ["Images"],
      summary: "Download image bytes",
      description:
        "Serves the R2 object after an ownership check. `403` if the user cannot access the image, `404` if the object is missing.",
      security: bearerOrCookie,
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
          example: IMAGE_ID_EXAMPLE,
        },
      ],
      responses: {
        "200": {
          description: "Image bytes.",
          content: {
            "image/png": {
              schema: { type: "string", format: "binary" },
              examples: { default: { summary: "PNG", value: "(binary)" } },
            },
            "image/jpeg": {
              schema: { type: "string", format: "binary" },
              examples: { default: { summary: "JPEG", value: "(binary)" } },
            },
            "image/webp": {
              schema: { type: "string", format: "binary" },
              examples: { default: { summary: "WebP", value: "(binary)" } },
            },
          },
        },
        "401": unauthorized,
        "403": forbidden,
        "404": notFound({ error: "Image not found" }),
      },
    },
  },
};
