export type FixtureChunk = {
  chunkId: string;
  documentId: string;
  filename: string;
  pageId: string;
  pageIndex: number;
  chunkIndex: number;
  chunkText: string;
  hasNextPage: boolean;
};

export const FIXTURE_DOCUMENTS: Array<{
  id: string;
  filename: string;
  firstPageSummary: string;
  summary: string;
  pageCount: number;
  pages: Array<{ id: string; pageIndex: number; summary: string; rawMarkdown: string; images?: Array<{ id: string; mediaType: string; r2Key: string; annotation?: string }> }>;
  chunks: FixtureChunk[];
}> = [
  {
    id: "doc-remote-policy",
    filename: "remote-work-policy.pdf",
    firstPageSummary:
      "Acme is a remote-first company. Every quarter each employee receives an office stipend of $500, and all remote work policy details are covered in this document.",
    summary:
      "Acme's remote work policy: the company is remote-first, employees get a $500 per quarter office stipend, core hours are 10am-4pm Eastern, and equipment is provided.",
    pageCount: 4,
    pages: [
      {
        id: "remote-policy-p0",
        pageIndex: 0,
        summary: "Remote-first policy overview",
        rawMarkdown:
          "# Remote Work Policy\n\nAcme is a remote-first company. This remote work policy describes how employees work from anywhere while staying connected to their teams.",
        images: [
          {
            id: "fixture-img-remote-p0",
            mediaType: "image/png",
            r2Key: "eval/fixture-remote-p0.png",
            annotation: "Illustration of Acme's distributed team over a world map",
          },
        ],
      },
      {
        id: "remote-policy-p1",
        pageIndex: 1,
        summary: "Office stipend",
        rawMarkdown:
          "# Office Stipend\n\nEvery quarter, each employee receives an office stipend of $500 to cover home office equipment, internet, and other remote workspace costs.",
        images: [
          {
            id: "fixture-img-remote-p1",
            mediaType: "image/png",
            r2Key: "eval/fixture-remote-p1.png",
            annotation: "Home office setup with a laptop and a coffee mug",
          },
        ],
      },
      {
        id: "remote-policy-p2",
        pageIndex: 2,
        summary: "Core hours and schedule",
        rawMarkdown:
          "# Core Hours\n\nEmployees enjoy flexible schedules. The required core hours are 10am to 4pm Eastern, with the rest of the day scheduled freely.",
      },
      {
        id: "remote-policy-p3",
        pageIndex: 3,
        summary: "Equipment and support",
        rawMarkdown:
          "# Equipment\n\nAcme provides a company laptop and a $200 equipment budget for monitors, desks, and chairs. IT support is available remotely for all employees.",
      },
    ],
    chunks: [
      {
        chunkId: "remote-policy-p0-c0",
        documentId: "doc-remote-policy",
        filename: "remote-work-policy.pdf",
        pageId: "remote-policy-p0",
        pageIndex: 0,
        chunkIndex: 0,
        chunkText:
          "Acme is a remote-first company. This remote work policy describes how employees work from anywhere while staying connected to their teams. Key facts: remote-first, remote policy, remote work policy.",
        hasNextPage: true,
      },
      {
        chunkId: "remote-policy-p1-c0",
        documentId: "doc-remote-policy",
        filename: "remote-work-policy.pdf",
        pageId: "remote-policy-p1",
        pageIndex: 1,
        chunkIndex: 0,
        chunkText:
          "Office stipend: every quarter, each employee receives an office stipend of $500 to cover home office equipment, internet, and other remote workspace costs. Key fact: office stipend $500 per quarter.",
        hasNextPage: true,
      },
      {
        chunkId: "remote-policy-p2-c0",
        documentId: "doc-remote-policy",
        filename: "remote-work-policy.pdf",
        pageId: "remote-policy-p2",
        pageIndex: 2,
        chunkIndex: 0,
        chunkText:
          "Core hours: employees enjoy flexible schedules. The required core hours are 10am to 4pm Eastern, with the rest of the day scheduled freely. Key fact: core hours 10am to 4pm Eastern.",
        hasNextPage: true,
      },
      {
        chunkId: "remote-policy-p3-c0",
        documentId: "doc-remote-policy",
        filename: "remote-work-policy.pdf",
        pageId: "remote-policy-p3",
        pageIndex: 3,
        chunkIndex: 0,
        chunkText:
          "Equipment: Acme provides a company laptop and a $200 equipment budget for monitors, desks, and chairs. IT support is available remotely for all employees. Key fact: equipment provided.",
        hasNextPage: false,
      },
    ],
  },
  {
    id: "doc-saas-pricing",
    filename: "saas-pricing.pdf",
    firstPageSummary:
      "Acme SaaS pricing: the Pro plan costs $29 per month, and annual billing saves 20% compared to monthly billing.",
    summary:
      "Acme SaaS pricing guide: Free plan at $0, Pro plan at $29 per month, and Enterprise with custom pricing. Annual billing saves 20% on all paid plans.",
    pageCount: 4,
    pages: [
      {
        id: "saas-pricing-p0",
        pageIndex: 0,
        summary: "Pro plan pricing",
        rawMarkdown:
          "# Pricing\n\nThe Pro plan costs $29 per month. The Pro plan includes unlimited projects, priority support, and integrations. Annual billing saves 20%.",
      },
      {
        id: "saas-pricing-p1",
        pageIndex: 1,
        summary: "Annual billing discount",
        rawMarkdown:
          "# Annual Billing\n\nAnnual billing saves 20% on the Pro plan: a full year costs $278.40 instead of 12 months at $29. You can switch from monthly to annual billing at any time.",
      },
      {
        id: "saas-pricing-p2",
        pageIndex: 2,
        summary: "Free plan",
        rawMarkdown:
          "# Free Plan\n\nThe Free plan costs $0 per month and includes 3 projects and community support. Free plan users are limited to 100 MB of storage.",
      },
      {
        id: "saas-pricing-p3",
        pageIndex: 3,
        summary: "Enterprise plan",
        rawMarkdown:
          "# Enterprise\n\nThe Enterprise plan has custom pricing with SSO, dedicated support, and an uptime SLA of 99.9%. Contact the sales team for a quote.",
      },
    ],
    chunks: [
      {
        chunkId: "saas-pricing-p0-c0",
        documentId: "doc-saas-pricing",
        filename: "saas-pricing.pdf",
        pageId: "saas-pricing-p0",
        pageIndex: 0,
        chunkIndex: 0,
        chunkText:
          "Pricing: the Pro plan costs $29 per month. The Pro plan includes unlimited projects, priority support, and integrations. Annual billing saves 20%. Key facts: Pro plan, $29 per month, annual billing saves 20%.",
        hasNextPage: true,
      },
      {
        chunkId: "saas-pricing-p1-c0",
        documentId: "doc-saas-pricing",
        filename: "saas-pricing.pdf",
        pageId: "saas-pricing-p1",
        pageIndex: 1,
        chunkIndex: 0,
        chunkText:
          "Annual billing: annual billing saves 20% on the Pro plan; a full year costs $278.40 instead of 12 months at $29. You can switch from monthly to annual billing at any time.",
        hasNextPage: true,
      },
      {
        chunkId: "saas-pricing-p2-c0",
        documentId: "doc-saas-pricing",
        filename: "saas-pricing.pdf",
        pageId: "saas-pricing-p2",
        pageIndex: 2,
        chunkIndex: 0,
        chunkText:
          "Free plan: the Free plan costs $0 per month and includes 3 projects and community support. Free plan users are limited to 100 MB of storage.",
        hasNextPage: true,
      },
      {
        chunkId: "saas-pricing-p3-c0",
        documentId: "doc-saas-pricing",
        filename: "saas-pricing.pdf",
        pageId: "saas-pricing-p3",
        pageIndex: 3,
        chunkIndex: 0,
        chunkText:
          "Enterprise: the Enterprise plan has custom pricing with SSO, dedicated support, and an uptime SLA of 99.9%. Contact the sales team for a quote.",
        hasNextPage: false,
      },
    ],
  },
];

export const FIXTURE_DOCUMENT_TEXT: string = FIXTURE_DOCUMENTS.flatMap((document) =>
  document.chunks.map((chunk) => chunk.chunkText),
).join("\n\n");

export function stubSearchResults(query: string): {
  answer: string | null;
  results: Array<{ title: string; url: string; content: string; publishedDate?: string; score?: number }>;
} {
  return {
    answer: `Fixture web answer for: ${query}`,
    results: [
      { title: "Fixture result 1", url: "https://fixture.example.com/1", content: `Fixture web content matching "${query}"...`, publishedDate: "2026-08-01", score: 0.95 },
    ],
  };
}

export const FIXTURE_CLARIFICATION_ANSWERS: Record<string, string> = {
  style: "watercolor",
  dimensions: "1024x1024",
  tone: "friendly",
};

export const FIXTURE_CITATION_SOURCES: Array<{ source: string }> = [
  { source: "doc-remote-policy" },
  { source: "doc-saas-pricing" },
];
