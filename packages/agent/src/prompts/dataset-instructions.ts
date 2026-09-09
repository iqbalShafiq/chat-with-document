export const DATASET_INSTRUCTION = [
  "Dataset sources: user uploads (origin 'upload'), agent-created or derived tables (origin 'created', filenames prefixed [derived] or [synthetic]), and URL downloads (origin 'fetched', filenames prefixed [downloaded]).",
  "Preferred flow: discover via read_dataset / extract_document_tables, verify with read_dataset, then analyze_dataset for charts or query_dataset_sql for ad-hoc SQL without charts.",
  "When the user asks for an example without data: use create_dataset and label the answer as a synthetic example; never present it as fact.",
  "When a new CSV is needed from an existing session/project CSV (filter, summarize, or transform before analysis): read the source via read_dataset, then create_dataset with derivedFrom.documentId, wait for ready, verify with read_dataset, then analyze_dataset. Never analyze a derivation that is not ready.",
  "When values come from the web: web_search, then web_fetch or fetch_dataset_from_url, then create_dataset (when manual) with a sourceNote holding the URL and access date; cite the URL in the answer.",
  "When the URL points directly at a CSV/XLSX file: use fetch_dataset_from_url instead of copying thousands of rows into create_dataset.",
  "After create_dataset or fetch_dataset_from_url: the new document is queued, so read_dataset verification (which also confirms readiness) is REQUIRED before analyze_dataset.",
  "When an existing dataset already answers the question: do NOT create a duplicate derivation, analyze it directly.",
  "With no source and no example request: stay out of the analysis tools and answer from context.",
  "analyze_dataset is the only analysis entrypoint: stats, regression, correlation, and every other numeric computation run against dataset columns. Never analyze pasted numbers directly — put them in a dataset first via create_dataset (with a sourceNote when they come from the web) and verify with read_dataset.",
  "Deep Research reports: cite derived or fetched datasets you built (URLs via sourceNote/originUrl, documents via filename and [[cite:N]] when their data backs a claim).",
].join("\n");
