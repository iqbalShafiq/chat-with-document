export type ToolCallRecord = {
  name: string;
  args: Record<string, unknown>;
  status: "called" | "approval_requested" | "approved" | "rejected" | "error";
  error?: string;
};

export type ApprovalRecord = {
  toolName: string;
  reason: string;
  decision: "approved" | "rejected" | "none";
};

export type ClarificationRecord = {
  title?: string;
  questions: Array<{ id: string; question: string; type: string }>;
};

export type BehaviorTrace = {
  output: string;
  toolCalls: ToolCallRecord[];
  approvals: ApprovalRecord[];
  clarifications: ClarificationRecord[];
  citations: Array<{ source: string }>;
  usage: { inputTokens?: number; outputTokens?: number };
  durationMs: number;
};

export type ApprovalMode = "auto-approve" | "auto-reject";

export type SessionConfig = {
  webSearchEnabled: boolean;
  imageGenEnabled: boolean;
  hasDocuments: boolean;
  visionModelAvailable?: boolean;
  approvalMode?: ApprovalMode;
  models?: string[];
};

export type BehaviorExpectation = {
  /** Tool names that MUST appear in toolCalls. */
  requiresTools?: string[];
  /** Tool names that MUST NOT appear in toolCalls. */
  forbidsTools?: string[];
  /** Tool names that must have an approval request recorded. */
  requiresApprovalFor?: string[];
  /** Tool names that must NOT have an approval request recorded. */
  forbidsApprovalFor?: string[];
  /** Requires at least one request_clarification call. */
  requiresClarification?: boolean;
  /** Requires NO request_clarification call. */
  forbidsClarification?: boolean;
  /** Requires at least one citation source. */
  requiresCitation?: boolean;
  /** Requires output text to contain this substring. */
  outputContains?: string[];
  /** Requires output text to NOT contain this substring. */
  outputNotContains?: string[];
};

export type EvalCaseInput = {
  prompt: string;
  sessionConfig: SessionConfig;
  expected: BehaviorExpectation;
};
