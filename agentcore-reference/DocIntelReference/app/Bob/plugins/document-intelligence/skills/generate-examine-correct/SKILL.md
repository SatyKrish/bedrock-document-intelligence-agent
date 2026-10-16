---
name: generate-examine-correct
description: Generate Markdown and CSV reports, reopen them, verify evidence and calculations, then correct defects before publishing the result manifest.
---

1. Generate comparison.md and kpis.csv in /mnt/output/<analysisId>/ only. Use
   the application-specified fixed names. Markdown includes question, findings,
   formulas, exact source quotes and limitations. CSV header is
   company,fiscal_year,revenue_usd_billions,operating_income_usd_billions,source_document,source_section.
   Use plain unquoted cells without commas, newlines or formulas. Numeric values
   must be nonnegative decimals in USD billions; unsupported values belong in
   limitations instead of fabricated rows. Prefix unsafe text cells with a plain
   apostrophe or omit them; no spreadsheet formulas are permitted.
2. Examine by reopening both files. Recompute totals and operating margins.
   Match every reported fact to selected sources and inspect each citation.
   Confirm schema, units, selected source IDs and absence of unsupported claims.
3. Correct errors, reopen corrected files, and repeat up to two correction cycles.
   If evidence is inadequate, fail clearly rather than publish guessed facts.
4. Write result.json last, using the exact analysisId supplied by the application,
   with answer, citations[{documentId,location,quote}], and limitations. Never
   include paths, URLs or unselected document IDs as artifacts. A final write is
   not proof of S3 object availability; leave availability checking to the app.
