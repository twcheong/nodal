# Agency Workflow Catalog — 100 Workflows for Social Media Agencies

100 example workflows for Twixy Marketing Copilot, built for **social media agencies
with 2–10 employees** (founder/owner, social media managers, marketing specialists,
account managers). Not a random list — a system: the **agency delivery lifecycle
(8 pillars) × channels** matrix, where every workflow attacks at least one of the
agency's three core problems:

1. **Repetitive browser work** — the same research/monitoring/reporting repeated for
   every client across Google, social platforms, AI chats, and spreadsheets.
2. **Knowledge locked in individuals** — prompts and processes live in personal files;
   output quality varies by employee, onboarding is slow, knowledge walks out the door.
3. **The founder is the bottleneck** — reviews, status-chasing, and client reporting
   all flow through one person.

Every workflow here is a **process captured as a runnable asset**: run it for any
client, share it with the team, and the "how" no longer depends on who does it.

## System structure

### Pillars (agency delivery lifecycle)

| Pillar | Prefix | Count | Tag | Kills problem |
|---|---|---|---|---|
| A. Client Onboarding & Research | `client` | 12 | `client` | #1 — per-client repetition |
| B. Competitor & Market Intelligence | `intel` | 12 | `research` | #1 |
| C. Strategy & Planning | `strategy` | 12 | `campaign` | #2 — process becomes an asset |
| D. Content Production | `create` | 22 | `content` | #1, #2 |
| E. Publishing & Engagement | `engage` | 12 | `social` | #1 |
| F. Monitoring & Listening | `watch` | 8 | `analytics` | #1, #3 — early warning |
| G. Reporting & Client Comms | `report` | 14 | `reporting` | #3 — founder bottleneck |
| H. Agency Ops & Knowledge | `ops` | 8 | `client` | #2, #3 |

### Channels

Instagram (Reels/Stories/Feed) · Threads · YouTube (long-form/Shorts) · X · TikTok ·
LinkedIn · Facebook · Google Business Profile · Reddit · Newsletter/Email ·
Client website/SEO · Cross-channel

### Conventions

- **id**: `wf_agency_<prefix>_<slug>` (prepend `wf_agency_` to the slug column below)
- **Standard input IDs** (reused across workflows): `client_name` (text) · `niche` (text) ·
  `target_audience` (text) · `account_url` (url) · `competitor_urls` (list/url) ·
  `hashtags` (list/text) · `topic` (text) · `target_keyword` (query) ·
  `draft_path` (path) · `brand_voice` (text)
- **Node patterns** — research type: `collect (chrome/web-fetch) → validation → analyze
  (read) → save (write)`. Execution type: `read prep → act (chrome) → self-report results`
  (a workflow whose last node is `write` derives as research, so execution workflows end
  on a chrome action).
- **outputDir mapping**: raw collection → `data/raw/<platform>` · analysis/libraries →
  `data/insights` · strategy/calendars → `strategies` · drafts → `content/drafts` ·
  reports → `data/reports`
- **Batch limits**: repetitive work capped at 10–15 items per node (one node = one
  9-minute agent turn)
- **Safety rules**: publishing/comment/DM workflows cap at 10–15 actions per round,
  operate transparently from the client's own account, and forbid spam/copy-paste
  behavior in the node detail
- No image generation or screenshots → all deliverables are text; visuals are described
  as "shooting/design directions"
- No cron/schedule inputs — recurrence lives outside the workflow
- LinkedIn, Facebook, GBP, Reddit, TikTok use generic `chrome` automation (no dedicated
  toolSkill); Instagram/Threads/YouTube have dedicated skills and are the most robust

---

## A. Client Onboarding & Research (12) — tag `client`

The "new client = week of grunt work" killer. Run the same intake battery for every
client and get identical-quality onboarding artifacts.

| # | slug | Title — what it does | Inputs | Node chain → outputDir |
|---|---|---|---|---|
| 1 | `client_intake_brief` | Client Intake → Kickoff Brief — turn a raw intake questionnaire/notes file into a structured kickoff brief | intake_path(path), client_name | read → write(md) → `strategies` |
| 2 | `client_presence_audit` | Full Social Presence Audit — every handle: bio, link, consistency, activity level, follower counts | client_name, account_urls(list) | chrome → validation → write(xlsx) → `data/reports` |
| 3 | `client_ig_audit` | Instagram Account Deep Audit — last 30 posts in 2 batches: engagement patterns, winning formats, gaps | account_url, client_name | chrome(instagram) ×2 → validation → write(xlsx) → `data/reports` |
| 4 | `client_voice_guide` | Brand Voice & Tone Guide Extraction — derive a written voice guide from the client's existing content | account_url, website_url(url) | chrome → write(md) → `strategies` |
| 5 | `client_audience_persona` | Audience Persona from Community Language — mine Reddit/comments for real customer language | niche, target_audience | chrome(data-scout) → write(md) → `strategies` |
| 6 | `client_site_seo_snapshot` | Website & SEO Snapshot Audit — crawl key pages, capture SEO basics and content state | website_url(url) | chrome(seo-crawl) → validation → write(md) → `data/reports` |
| 7 | `client_hashtag_baseline` | Niche Hashtag Landscape Baseline — map the client's hashtag territory and volumes | niche, hashtags | chrome(instagram) → write(csv) → `data/raw/instagram` |
| 8 | `client_content_inventory` | Content Inventory & Top-Performer Analysis — catalog existing content, find what already works | account_url | chrome → read → write(xlsx) → `data/reports` |
| 9 | `client_gbp_audit` | Google Business Profile Audit — listing completeness, reviews, posts, photos (as text), Q&A | business_name(text), location(text) | chrome → write(md) → `data/reports` |
| 10 | `client_onboarding_pack` | Client Onboarding Summary Pack — merge audit outputs into one kickoff deck | client_name, reports_dir(path) | read → validation → write(report-pack) → `data/reports` |
| 11 | `client_competitor_set` | Competitor Set Identification — find and profile the client's 5 true social competitors | client_name, niche | chrome → read → write(md) → `data/insights` |
| 12 | `client_quick_wins` | Quick-Wins Scan — bio, link-in-bio, pinned posts, highlights: fixes shippable this week | account_url | chrome(instagram) → write(md) → `data/reports` |

## B. Competitor & Market Intelligence (12) — tag `research`

| # | slug | Title — what it does | Inputs | Node chain → outputDir |
|---|---|---|---|---|
| 13 | `intel_ig_teardown` | Competitor IG Teardown — 30 posts, engagement patterns, steal-worthy tactics | account_url, client_name | chrome(instagram) ×2 → validation → write(xlsx) → `data/reports` |
| 14 | `intel_content_mix_matrix` | Competitor Content Mix Matrix — top 5 accounts × format ratios in one grid | competitor_urls | chrome(instagram) → validation → write(xlsx) → `data/reports` |
| 15 | `intel_yt_strategy` | Competitor YouTube Strategy Analysis — upload cadence, title patterns, view distribution | channel_url(url) | chrome(youtube) → validation → write(xlsx) → `data/reports` |
| 16 | `intel_yt_outliers` | YouTube Outlier Video Finder — views-to-subscribers anomalies and their shared traits | niche, seed_channels(list/url) | chrome(youtube) → validation → read → write(xlsx) → `data/reports` |
| 17 | `intel_linkedin_analysis` | Competitor LinkedIn Page Analysis — post cadence, formats, engagement drivers | company_urls(list/url) | chrome → write(md) → `data/insights` |
| 18 | `intel_tiktok_scan` | Competitor TikTok Presence Scan — format choices, posting rhythm, standout videos | competitor_handles(list) | chrome → write(md) → `data/insights` |
| 19 | `intel_ad_library_scan` | Meta Ad Library Competitor Scan — active ads, angles, hooks, longevity signals | competitor_names(list) | chrome → validation → write(xlsx) → `data/reports` |
| 20 | `intel_reels_hook_harvest` | Competitor Reels Hook Harvest — collect and classify the first-3-second hooks | competitor_urls | chrome(instagram) → read → write(md) → `data/insights` |
| 21 | `intel_trend_scan` | Niche Trend & Format Scan — what formats/hooks are winning in the niche right now | niche, hashtags | chrome(instagram) → validation → write(md) → `data/insights` |
| 22 | `intel_reddit_intel` | Reddit Community Intelligence — pain points, objections, and customer language | subreddits(list) | chrome → read → write(md) → `data/insights` |
| 23 | `intel_serp_gap` | SERP Content Gap Analysis — topics top-ranking pages fail to cover | target_keyword, niche | chrome(seo-crawl) → read → write(md) → `data/insights` |
| 24 | `intel_viral_teardown` | Viral Case Study Teardown — reconstruct the timeline and spread path of one viral hit | case_url(url) | chrome → read → write(md) → `data/insights` |

## C. Strategy & Planning (12) — tag `campaign` · outputDir `strategies`

This is where the agency's *thinking process* becomes a reusable asset instead of a
senior employee's private method.

| # | slug | Title — what it does | Inputs | Node chain |
|---|---|---|---|---|
| 25 | `strategy_content_pillars` | Content Pillar Framework — 4–5 pillars with mix ratios per channel | client_name, niche | read → write(md) |
| 26 | `strategy_calendar_30day` | 30-Day Content Calendar — date × channel × pillar × hook, 30 rows | client_name, niche, insights_path | read → write(csv) → validation |
| 27 | `strategy_hook_library` | Verified Hook Library — 40 harvested + 60 pattern-derived = 100 hooks | niche, client_name | chrome ×3 (IG·YT·Threads) → validation → read → write(csv) → `data/insights` |
| 28 | `strategy_campaign_concepts` | Campaign Concept Brief — 3 distinct concepts with hooks, CTA, success metric | client_name, campaign_goal(text) | read → write(md) |
| 29 | `strategy_ugc_campaign` | UGC / Hashtag Campaign Design — rules, hashtag, rewards, seeding plan | client_name, target_audience | read → write(md) |
| 30 | `strategy_creator_shortlist` | Creator Shortlist + Outreach Plan — prioritize discovered creators, draft angles | creator_list_path(path), client_name | read → write(xlsx) |
| 31 | `strategy_launch_sequence` | Launch Teaser→Reveal Sequence — D-14 to D+7 channel-by-channel plan | client_name, launch_date(text) | read → write(md) |
| 32 | `strategy_newsjack_playbook` | Trend/Newsjacking Playbook — verify an issue, pick the angle, 24-hour response plan | issue_topic(text), client_name | chrome → write(md) |
| 33 | `strategy_bio_positioning` | Positioning & Bio Rewrite — diagnose the profile, propose rewrites | account_url, client_name | chrome → write(md) |
| 34 | `strategy_quarterly_roadmap` | Quarterly Social Roadmap — monthly themes, goals, channel allocation | client_name, quarter_goal(text) | read → write(md) |
| 35 | `strategy_crisis_playbook` | Crisis Response Playbook — negative-virality scenarios, holding statements, escalation | client_name, niche | read → write(md) |
| 36 | `strategy_repurpose_system` | Repurposing System Design — map 1 pillar piece → 10 derivative assets | client_name | read → write(md) |

## D. Content Production (22) — tag `content` · outputDir `content/drafts`

Batch production with consistent quality regardless of who hits Run. All text-only;
visuals described as shooting/design directions.

| # | slug | Title — what it does | Inputs | Node chain |
|---|---|---|---|---|
| 37 | `create_reels_scripts` | Reels Script Batch — 10 scripts: hook (3s), body, CTA, shot directions | client_name, niche, hook_library_path | read → write(md) → validation |
| 38 | `create_caption_sets` | Captions + Hashtag Sets Batch — captions and tag sets for a script batch | draft_path | read → write(md) |
| 39 | `create_carousel_copy` | Carousel Copy Batch — 3 carousels × 8–10 slides, per-slide copy | topic, client_name | read → write(md) |
| 40 | `create_story_series` | Story Interaction Series — 7 days of polls/quizzes/sliders | client_name, niche | read → write(md) |
| 41 | `create_threads_batch` | Threads Post Batch — 10 conversation-starter posts from trend scan output | topics_path(path), client_name | read → write(md) → validation |
| 42 | `create_x_threads` | X Thread Batch — 3 long-form storytelling threads (8–12 posts each) | topic, client_name | read → write(md) |
| 43 | `create_hook_bank` | One-liner Hook Bank — 30 single-line hooks by psychological trigger | client_name, niche | read → write(md) |
| 44 | `create_shorts_scripts` | Shorts Script Batch — 10 scripts: 2-second hook, payoff, loop ending | niche, topic | read → write(md) → validation |
| 45 | `create_longform_script` | Long-form Video Script + Chapters — analyze a reference transcript, write the script | reference_video_url(url), topic | chrome(youtube-transcript) → write(md) |
| 46 | `create_title_thumb_ab` | Title/Thumbnail Copy A/B — 10 title variants + thumbnail text per video | video_topic(text) | read → write(md) |
| 47 | `create_tiktok_scripts` | TikTok Script Batch — 10 scripts mapped to current trends | trends_path(path), client_name | read → write(md) |
| 48 | `create_linkedin_batch` | LinkedIn Post Batch — 5 posts in the founder's voice | client_name, brand_voice | read → write(md) |
| 49 | `create_linkedin_article` | LinkedIn Article Draft — thought-leadership long-form with hook-first intro | topic, client_name | read → write(md) |
| 50 | `create_facebook_batch` | Facebook Post Batch — 5 page/group posts tuned for shares and comments | client_name, topic | read → write(md) |
| 51 | `create_seo_blog_post` | SEO Blog Post That Outranks — SERP teardown → outline → 1,500+ word draft | target_keyword, client_name | chrome(seo-crawl) → read → write(md) → validation |
| 52 | `create_newsletter_issue` | Newsletter Issue Draft — subject lines ×5, story-driven body, CTA | topic, client_name | read → write(md) |
| 53 | `create_press_release` | Press Release + Journalist Pitch — release plus personalized pitch notes | announcement(text), client_name | read → write(pdf) |
| 54 | `create_ugc_remix` | UGC/Testimonial Remix Scripts — turn customer reviews into video scripts | reviews_path(path) | read → write(md) |
| 55 | `create_social_proof` | Review Mining → Social Proof Copy — harvest real reviews, convert to copy | product_url(url) | chrome → read → write(md) |
| 56 | `create_landing_copy` | Landing Page Copy Set — 10 headlines + section copy from page analysis | product_url(url), target_audience | chrome → write(md) |
| 57 | `create_repurpose_pack` | Long Video → 10-Asset Repurpose Pack — transcript → posts, threads, shorts ideas | reference_video_url(url) | chrome(youtube-transcript) → write(md) |
| 58 | `create_voice_rewrite` | Client-Voice Rewrite Batch — adapt generic drafts to the client's voice guide | draft_path, voice_guide_path(path) | read → write(md) |

## E. Publishing & Engagement (12) — tag `social` · execution type

Ends on a chrome action (self-reported results) so the workflow derives as execution.
Round caps of 10–15, no spam, client's own account, transparent behavior.

| # | slug | Title — what it does | Inputs | Node chain |
|---|---|---|---|---|
| 59 | `engage_ig_publish` | IG Post Publish — read approved draft, publish, report post URL | draft_path | read → chrome(instagram) |
| 60 | `engage_threads_publish` | Threads Publish — publish from draft, report URL | draft_path | read → chrome(threads) |
| 61 | `engage_x_publish` | X Publish + Engage — post, then join 5–10 relevant conversations | draft_path | read → chrome |
| 62 | `engage_crosspost` | Cross-posting Round — one piece adapted and posted to IG → Threads → X | draft_path | read → chrome(instagram) → chrome(threads) → chrome |
| 63 | `engage_ig_comment_round` | Targeted Comment Engagement Round — 10–12 value comments on niche posts | hashtags, brand_voice | chrome(instagram) scout+draft → validation → chrome post |
| 64 | `engage_threads_round` | Threads Conversation Round — 10–12 replies in niche conversations | niche, brand_voice | chrome(threads) scout → chrome reply |
| 65 | `engage_creator_dm` | Creator DM Outreach Batch — 10–15 personalized DMs from a shortlist | shortlist_path(path) | read → validation → chrome(instagram) |
| 66 | `engage_mention_replies` | Mention & Reply Round — find brand mentions, reply to 10 | client_name | chrome(watchtower) → chrome reply |
| 67 | `engage_inbound_replies` | Inbound Comment Reply Round — answer comments on the client's own recent posts | account_url, brand_voice | chrome(instagram) collect → chrome reply |
| 68 | `engage_yt_community` | YouTube Community Tab Post — publish poll/text post | draft_path, channel_url(url) | read → chrome(youtube) |
| 69 | `engage_gbp_post` | GBP Post Publish — publish update/offer post on the listing | draft_path, business_name(text) | read → chrome |
| 70 | `engage_ugc_thanks` | UGC Reposter Thank-You Round — thank accounts using the campaign tag | campaign_hashtags(list) | chrome(instagram) collect → chrome comment |

## F. Monitoring & Listening (8) — tag `analytics`

The founder's early-warning system — problems surface in a report, not in a client call.

| # | slug | Title — what it does | Inputs | Node chain → outputDir |
|---|---|---|---|---|
| 71 | `watch_brand_mentions` | Brand Mention Sweep — X/Threads/Reddit mentions, triaged by urgency | client_name, product_names(list) | chrome(watchtower) ×2 → validation → write(md) → `data/reports` |
| 72 | `watch_review_sites` | Review Site Sweep — Google/Yelp/Trustpilot new reviews + response drafts | business_name(text) | chrome → write(md) → `data/reports` |
| 73 | `watch_competitor_activity` | Competitor Activity Weekly Sweep — what each competitor shipped this week | competitor_urls | chrome → write(md) → `data/insights` |
| 74 | `watch_trend_alerts` | Multi-Client Trend Alert Scan — one sweep, trend alerts routed per client niche | client_niches(list) | chrome(data-scout) → write(md) → `data/insights` |
| 75 | `watch_comment_sentiment` | Comment Sentiment & Topic Analysis — classify recent comments, surface themes | account_url | chrome → read → write(md) → `data/reports` |
| 76 | `watch_negative_signals` | Negative-Signal Early Warning Scan — complaint spikes, risky threads, brewing issues | client_name | chrome(watchtower) → write(md) → `data/reports` |
| 77 | `watch_campaign_hashtag` | Campaign Hashtag UGC Tracker — participation counts and top UGC | campaign_hashtags(list) | chrome(instagram) → write(xlsx) → `data/reports` |
| 78 | `watch_follower_tracker` | Multi-Account Follower Tracker — snapshot all client+competitor accounts, append | account_urls(list) | chrome → edit(csv append) → `data/reports` |

## G. Reporting & Client Comms (14) — tag `reporting` · outputDir `data/reports`

The founder-bottleneck killer: client-ready artifacts produced the same way every time,
reviewable in minutes instead of built by hand.

| # | slug | Title — what it does | Inputs | Node chain |
|---|---|---|---|---|
| 79 | `report_ig_weekly` | Weekly IG Performance Report — account insights → xlsx + summary | account_url, client_name | chrome(instagram) → validation → write(xlsx) |
| 80 | `report_weekly_snapshot` | Weekly Multi-Channel Snapshot — one-page status across all client channels | client_name, account_urls(list) | chrome → write(md) |
| 81 | `report_yt_monthly` | Monthly YouTube Report — studio metrics, top videos, retention notes | channel_url(url) | chrome(youtube) → write(xlsx) |
| 82 | `report_monthly_pack` | Monthly Client Report Pack — merge the month's outputs into a client-ready pack | client_name, month_label(text) | read → validation → write(report-pack) |
| 83 | `report_content_winners` | Content Winners & Learnings — top 10% posts and the why | account_url | chrome ×2 → read → write(md) |
| 84 | `report_best_times` | Best Posting Time Analysis — post-time × engagement correlation | account_url | chrome(instagram) → read → write(md) |
| 85 | `report_sov` | Share-of-Voice Report — client vs competitors mention share | client_name, competitor_names(list) | chrome(data-scout) → write(xlsx) |
| 86 | `report_campaign_wrap` | Campaign Wrap-Up Report — results vs goals, learnings, next steps | campaign_path(path) | read → chrome → write(md) |
| 87 | `report_creator_roi` | Creator Campaign ROI Report — per-creator reach/engagement/conversion | campaign_path(path) | read → chrome → write(xlsx) |
| 88 | `report_ga4_social` | GA4 Social Traffic Report — social-sourced sessions and conversions | ga_property(text) | chrome → write(md) |
| 89 | `report_client_email` | Client Weekly Email Update Draft — turn reports into a friendly client email | client_name, reports_dir(path) | read → write(md) |
| 90 | `report_qbr_deck` | Quarterly Business Review Deck — quarter results + next-quarter plan (pptx) | client_name, quarter_label(text) | read → validation → write(pptx) |
| 91 | `report_prospect_audit` | Prospect Audit Teaser — quick audit of a prospect's socials → pitch-ready PDF | prospect_name(text), account_url | chrome → read → write(pdf) |
| 92 | `report_case_study` | Client Case Study Write-Up — turn results into a marketing asset | client_name, results_path(path) | read → write(md) |

## H. Agency Ops & Knowledge (8) — tag `client`

Where individual know-how becomes team property.

| # | slug | Title — what it does | Inputs | Node chain → outputDir |
|---|---|---|---|---|
| 93 | `ops_sop_writeup` | SOP Write-Up from a Finished Run — turn a completed process into a step-by-step playbook | process_notes_path(path) | read → write(md) → `strategies` |
| 94 | `ops_prompt_library` | Team Prompt/Hook Library Consolidation — merge scattered prompts into one library | sources_dir(path) | read → validation → write(csv) → `data/insights` |
| 95 | `ops_onboarding_guide` | New-Hire Onboarding Guide Builder — compile SOPs into a first-two-weeks guide | sops_dir(path) | read → write(md) → `strategies` |
| 96 | `ops_qa_checklist` | Pre-Publish QA Checklist Run — check drafts against the brand voice guide + QA rules | draft_path, voice_guide_path(path) | read → write(md) → `data/reports` |
| 97 | `ops_weekly_digest` | Weekly All-Clients Ops Digest — one founder-facing digest across every client | reports_dir(path) | read → write(md) → `data/reports` |
| 98 | `ops_capacity_snapshot` | Client Workload & Capacity Snapshot — deliverables per client vs team capacity | plan_paths(list/path) | read → write(xlsx) → `data/reports` |
| 99 | `ops_meeting_actions` | Meeting Notes → Action Items & Brief — structure raw notes into owners + deadlines | notes_path(path) | read → write(md) → `strategies` |
| 100 | `ops_kb_sync` | Learnings → Notion Knowledge Base Sync — push validated learnings to the team wiki | learnings_path(path) | read → mcp(notion) → `data/insights` |

---

## Playbooks (pillar chains that mirror real agency work)

| Playbook | Chain |
|---|---|
| New-Client Week 1 | #1 intake brief → #3 IG audit → #11 competitor set → #13 teardown → #25 pillars → #26 calendar → #10 onboarding pack |
| Weekly Content Engine | #21 trend scan → #37 reels scripts → #38 captions → #59 publish → #63 comment round → #79 weekly report |
| Founder-Bottleneck Killer | #96 QA checklist → #97 ops digest → #89 client email → #82 monthly pack |
| New-Business Machine | #91 prospect audit → #92 case study → #53 press release → #30 creator shortlist |
| Knowledge Flywheel | #93 SOP write-up → #94 prompt library → #95 onboarding guide → #100 Notion sync |

## The 11 working workflows (`specs/` folder)

Fully-specced, installable, covering 7 of 8 pillars with tool diversity. Wrap any
spec file's JSON in a ` ```workflow-spec ` fence and paste into the Workflow Builder
chat to create it — or install directly on disk (already done for the primary account).

| File | # | Pillar |
|---|---|---|
| `wf_agency_client_ig_audit.json` | 3 | A — Onboarding |
| `wf_agency_client_quick_wins.json` | 12 | A — Onboarding |
| `wf_agency_intel_trend_scan.json` | 21 | B — Intelligence |
| `wf_agency_strategy_calendar_30day.json` | 26 | C — Strategy |
| `wf_agency_strategy_hook_library.json` | 27 | C — Strategy |
| `wf_agency_create_reels_scripts.json` | 37 | D — Production |
| `wf_agency_create_seo_blog_post.json` | 51 | D — Production |
| `wf_agency_engage_ig_comment_round.json` | 63 | E — Engagement |
| `wf_agency_watch_brand_mentions.json` | 71 | F — Monitoring |
| `wf_agency_report_monthly_pack.json` | 82 | G — Reporting |
| `wf_agency_sales_prospect_audit.json` | 91 | G — Sales |

> **Note**: the builder-chat parser (`parseWorkflowSpecFromText`) reads only
> `title/description/inputs/nodes` and ignores `outputDir`/`tags` — when pasting via
> chat, set the tag in the UI afterward. The spec files carry both fields so they can
> be seeded or disk-installed as-is. For bundling all 100 as app seeds, prefer a JSON
> manifest lazy-seed over 100 hardcoded `mk()` calls (startup cost — see
> `electron/planning.ts` `SEED_VERSION`).
