# Post-launch measurement plan

The Measurement page combines development quality, policy-change comparisons, operational review signals, and independently assessed delayed outcomes. Its initial data is the app's loaded cases and saved logs, which may contain development and practice data. These figures must not be presented as production evidence.

## Measures and evidence

- Report correct recommendations, incorrect routine recommendations, and unnecessary human escalations for each selected policy. All three rates divide by all labelled examples in the displayed cohort. Show counts and denominators, including an explicit empty state rather than 0% when no examples exist.
- Show affected and unaffected examples separately. An example is affected when either its prediction or expected label changes. Confirm policy-specific labels independently in Validation; v1 reference labels are marked as provisional for changed rules.
- Operational review coverage divides applicable current reviews by loaded claims. Override share divides actual corrections by applicable reviewed claims. Resolving a correct human escalation is excluded. Selection bias means these are signals, not population error rates. Earlier reviews remain in claim history.
- Record independently assessed correct next steps at triage, with an assessor and evidence reference. Preserve the assessed automated decision, facts and policy version. New assessments append rather than erase history. The latest assessment per claim contributes to the displayed outcome cohort, grouped by the assessed policy. A settlement is not automatically a triage label.

## Responsibilities and proposed thresholds

These are starting targets for agreement with the insurer, not measured industry benchmarks.

| Cadence | Owner | Action and investigation trigger |
| --- | --- | --- |
| Daily | Operations lead | Inspect missing facts, coverage, conflicts and every open policy recheck. |
| Weekly | Quality lead | Randomly sample 10% of routine and information requests, at least 30 per route or all if fewer. Stratify by policy and repair type; record selection probabilities and denominators. Also inspect every flagged conflict and recheck. |
| Same day | Quality lead | Any independently confirmed incorrect routine recommendation triggers investigation. Trace policy and original facts; temporarily route the affected segment to a person pending a policy-owner decision. |
| Weekly | Quality lead | Investigate override share above 5% of reviewed cases or unnecessary escalation above 10% of independently assessed cases, with at least 30 observations. Compare the previous four weeks and investigate bias. |
| After 30 days, then weekly | Claims assessor | Reconcile unresolved cohorts with delayed evidence; record an independent assessment. Do not count missing outcomes as successes or failures. |
| Monthly | Operations and policy owners | Compare errors, escalation and missing facts by policy and repair type. A rise of 5 percentage points in missing facts or human-review share versus the prior four weeks triggers investigation. Collect handling time and cost before estimating realized value. |
| Before each release | Policy owner | Confirm changed-case labels; rerun all development examples and historical claims. Inspect affected and unaffected errors, resolve new unsafe routine errors, document trade-offs and approve by name. Recheck affected open claims; preserve closed decisions. |

## Release and incident process

The quality lead investigates evidence and categorizes causes as input errors, rule implementation faults, or policy gaps. The policy owner approves a versioned correction after a fresh comparison. Operations tracks affected open cases to review completion. Keep the original decisions and assessments for audit; document the incident, corrective action, and evidence used for approval.

## Current implementation boundary

The page reads live app data on entry, policy selection and Refresh data. The delayed-outcome form persists assessments to an append-only local log. The app does not yet automate random sample assignment, alert delivery, outcome ingestion, cohort ageing, or four-week trend calculations. Those steps are manual under this plan. No reviewer correction is silently converted into ground truth. This page supplies measurement inputs for a future business case, but does not calculate ROI.
