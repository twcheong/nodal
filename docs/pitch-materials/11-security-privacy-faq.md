# Security & Privacy FAQ — for Agency Owners

Written for a non-technical founder. Answers reflect the product as it is today; where a capability is planned, it says so. **Internal:** items marked ⚠ should be re-verified against the current build before sending externally.

---

**Q. Where does Twixy actually run?**
Twixy is a **desktop app that runs on your team's own computers**. Workflows are built and executed locally — there is no Twixy server remotely operating your accounts.

**Q. Where do our workflow files and results live?**
Workflow outputs (research documents, reports) are saved as files **inside a designated workspace folder on your computer**. Twixy's automation is restricted to writing within that workspace — it does not write files elsewhere on your machine.

**Q. What leaves our computer?**
Three things, and only these:
1. **AI requests** — the text a workflow step needs processed is sent to the AI model provider (e.g. Anthropic) to generate the result.
2. **Web search queries** — when a workflow uses web search, the query goes through Twixy's search service.
3. **Account & team data** — your login, team membership, shared-workflow metadata, and usage credits are stored in Twixy's cloud backend so your team workspace can sync.
Your client files as a whole are not uploaded; only the content a workflow step actively processes is sent to the AI provider.

**Q. Is our data used to train AI models?**
Twixy does not train models on your data. AI processing uses commercial APIs under business terms that do not train on API data by default. ⚠ *Confirm current provider terms before quoting specifics in writing.*

**Q. How does browser automation access our accounts?**
Automation runs in **Chrome on your own machine, in a dedicated Chrome profile** that you sign in to once. Credentials stay in Chrome's own storage on your computer — Twixy does not collect or upload your passwords. You choose which sites the workflows touch.

**Q. Can the AI do things we didn't approve?**
Workflows only do what they're configured to do, and every run is recorded: the **execution log** shows the actions taken, results, errors, and timestamps, so you can review exactly what happened. A formal review-and-approval step for AI outputs is **planned**; today, your team reviews outputs before they're client-facing.

**Q. Who on my team can see what?**
Your team shares a workspace: shared workflows are visible to team members you add. Fine-grained roles and permissions are **planned** — today, treat the team workspace as shared among people you trust, which fits a 2–10-person agency.

**Q. What about our clients' confidentiality?**
Pick pilot clients accordingly, and keep client contracts in mind: the data a workflow processes is typically **publicly visible marketing data** (competitor profiles, public posts, your own analytics). For sensitive client data, start with workflows that don't touch it.

**Q. What happens if a workflow fails midway?**
It fails visibly, not silently: the run is marked failed on the status dashboard and the execution log shows the step, the error, and the timestamp. Nothing retries or continues without the configuration saying so.

**Q. Can we delete our data?**
Local workflow files are yours — delete them like any file. Account and team data deletion requests are handled by Twixy support. ⚠ *Align with the current data-retention policy before committing to specific timelines.*

**Q. Do you have SOC 2 / ISO certification?**
Not yet — Twixy is an early-stage product and we say so. What we offer today: local-first execution, workspace-restricted file access, execution logs for every run, and direct access to the founding team for security questions.

---

*See the companion data-flow diagram (`12-data-flow-diagram.svg`) for a visual of exactly what stays local and what goes to which service.*
