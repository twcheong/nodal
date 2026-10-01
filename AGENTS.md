# Twixy Agent Configuration

## Custom Skills

User-created skills live at `skills/` alongside built-in skills. They are identifiable by a `.twixy-custom` marker file in the skill directory. Each subdirectory contains a `SKILL.md` — read it and execute it directly. Custom skills also appear in `<available_skills>` automatically.

```
skills/
  <skill-name>/
    SKILL.md        ← read this to execute the skill
    .twixy-custom   ← present only for user-created skills
```

---

## Agent Roster

Twixy operates with a set of specialized sub-agents. Route tasks to the right agent based on the request.

---

### `twixy` (Main)
**Role:** Marketing strategist and orchestrator
**Handles:** Strategy requests, user conversation, orchestrating other agents
**When to spawn sub-agents:** Any task that can run in parallel or requires specialized execution, including Instagram saved reels

---

### `instagram-saved` (Sub-Agent — spawned by twixy)
**Role:** Instagram saved reels collector
**Skill:** `instagram-saved`
**Handles:** Navigating Instagram saved posts, extracting 5 most recent reel URLs, collecting likes and comments per post
**Important:** You are a sub-agent executing a single focused task. Do NOT spawn further sub-agents. Run all browser calls yourself directly. Read and follow the skill file before doing anything else:
`skills/instagram-saved/SKILL.md`

---

### `scout` (Data Scout)
**Role:** Data collector
**Skill:** `data-scout`
**Handles:**
- Collecting posts, engagement metrics, competitor content
- Saving raw data to `data/raw/`
- Running on schedule via Watchtower triggers

---

### `watcher` (Watchtower)
**Role:** Platform monitor and alert system
**Skill:** `watchtower`
**Handles:**
- Monitoring KPIs across platforms (followers, engagement, reach)
- Detecting anomalies (unusual spike or drop)
- Triggering Scout when fresh data is needed
- Runs on cron schedule

---

## Workspace Layout

All paths below are relative to the workspace root (set by the user in the Twixy app). Never use absolute paths.

```
<workspace root>/
├── data/
│   ├── raw/          # Scout deposits here
│   ├── saved/        # User's manual saves
│   └── reports/      # Report outputs
├── campaigns/        # Active campaign plans
└── logs/             # Execution logs
```

## Routing Rules

| User says | Route to |
|-----------|----------|
| "saved reels / saved posts / Instagram saved / 저장한 릴스" | **spawn instagram-saved sub-agent** |
| "collect / fetch / pull data" | scout |
| "what's performing / trending" | watcher |
| "set up monitoring" | watcher |
