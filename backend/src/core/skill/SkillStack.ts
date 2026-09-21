/**
 * Master Skill Stack — the 100 skills the system runs on top of:
 * 20 domains × 5 skills, each with a purpose and success criteria.
 * Extended with the Master Skill Stack Matrix (20 specialized domains).
 */

import { MASTER_MATRIX_DOMAINS } from './MasterMatrix';

export interface StackSkill {
  id: string;
  domain: string;
  name: string;
  purpose: string;
  success: string;
  /** Trigger keywords used by the router. */
  triggers: string[];
}

export interface SkillDomain {
  id: string;
  label: string;
  skills: StackSkill[];
}

export type SkillRow = [name: string, purpose: string, success: string, triggers: string[]];

const DOMAINS: { id: string; label: string; rows: SkillRow[] }[] = [
  {
    id: 'personal', label: 'Personal Assistant',
    rows: [
      ['scheduling', 'Plan meetings and guard focused time.', 'Calendar conflict-free and on time.', ['schedule', 'calendar', 'meeting']],
      ['reminders', 'Create and manage task reminders.', 'Nothing falls through the cracks.', ['remind', 'reminder', 'remind me']],
      ['task-triage', 'Prioritize the day\'s open loops.', 'Top priorities done first.', ['triage', 'prioritize', 'to-do']],
      ['email-triage', 'Draft and route email responses.', 'Inbox zero or explicit deferral.', ['email', 'inbox', 'mail']],
      ['decision-briefing', 'Produce pro/con decision briefs.', 'Clear recommendation with evidence.', ['decide', 'should i', 'pros cons']],
    ],
  },
  {
    id: 'productivity', label: 'Productivity',
    rows: [
      ['note-taking', 'Capture and structure meeting notes.', 'Searchable, actionable notes.', ['notes', 'meeting notes', 'capture']],
      ['doc-drafting', 'Draft long-form documents from outline.', 'Coherent first draft.', ['draft', 'document', 'write']],
      ['spreadsheet-analysis', 'Analyze and summarize spreadsheet data.', 'Key insights surfaced.', ['spreadsheet', 'excel', 'csv']],
      ['meeting-prep', 'Prepare agendas and background briefs.', 'Ready-to-run agenda.', ['prep', 'agenda', 'brief']],
      ['inbox-zero', 'Bulk-process email backlog.', 'Inbox under 10 messages.', ['backlog', 'inbox zero']],
    ],
  },
  {
    id: 'coding', label: 'Coding',
    rows: [
      ['code-review', 'Review diffs for bugs and style.', 'Actionable review comments.', ['review', 'diff', 'pull request']],
      ['bug-triage', 'Diagnose and prioritize reported bugs.', 'Root cause + repro steps.', ['bug', 'crash', 'error']],
      ['refactoring', 'Restructure code with minimal behavior change.', 'Green tests after refactor.', ['refactor', 'clean up']],
      ['test-generation', 'Generate unit tests for coverage gaps.', 'Coverage above threshold.', ['test', 'coverage']],
      ['onboarding', 'Explain a codebase to a new engineer.', 'Navigable mental model.', ['onboard', 'explain codebase', 'walkthrough']],
    ],
  },
  {
    id: 'research', label: 'Research',
    rows: [
      ['web-research', 'Gather and cite web sources.', 'Cited, deduplicated findings.', ['research', 'find', 'sources']],
      ['paper-summarization', 'Summarize papers and technical docs.', 'TL;DR + key claims.', ['paper', 'arxiv', 'summarize']],
      ['citation-manager', 'Organize references and bibliographies.', 'Formatted citations on demand.', ['cite', 'bibliography', 'references']],
      ['market-research', 'Profile a market or industry.', 'Market size and trends.', ['market', 'industry']],
      ['competitive-intel', 'Track competitors and positioning.', 'Feature and pricing matrix.', ['competitor', 'competitive']],
    ],
  },
  {
    id: 'design', label: 'Design',
    rows: [
      ['ui-critique', 'Critique UI against UX heuristics.', 'Prioritized fix list.', ['critique', 'ui review', 'ux']],
      ['brand-identity', 'Draft brand voice and palette.', 'Consistent brand kit.', ['brand', 'logo', 'identity']],
      ['image-generation', 'Generate images from prompts.', 'On-brief outputs.', ['image', 'generate picture', 'art']],
      ['color-system', 'Build an accessible color scale.', 'WCAG-AA contrast verified.', ['colors', 'palette']],
      ['accessibility-audit', 'Audit surfaces for accessibility.', 'Conformance report.', ['accessibility', 'a11y', 'wcag']],
    ],
  },
  {
    id: 'marketing', label: 'Marketing',
    rows: [
      ['campaign-planning', 'Plan multi-channel campaigns.', 'Goal-aligned campaign brief.', ['campaign', 'launch']],
      ['copywriting', 'Write marketing copy variants.', 'Multiple tested variants.', ['copy', 'tagline', 'ad']],
      ['seo-audit', 'Audit pages for SEO issues.', 'Ranked fixes with impact.', ['seo', 'keywords']],
      ['social-calendar', 'Plan and schedule social posts.', 'Two-week content calendar.', ['social', 'posts', 'calendar']],
      ['analytics-reporting', 'Turn analytics into reports.', 'KPI narrative.', ['analytics', 'report', 'kpi']],
    ],
  },
  {
    id: 'sales', label: 'Sales',
    rows: [
      ['lead-qualification', 'Score and route leads.', 'Qualified vs unqualified split.', ['lead', 'prospect']],
      ['follow-up-drafting', 'Draft follow-up emails.', 'Sent-ready sequences.', ['follow up', 'reach out']],
      ['crm-hygiene', 'Clean and dedupe CRM records.', 'Auditable data health.', ['crm', 'dedupe']],
      ['deal-review', 'Review pipeline deals.', 'Risk flags per deal.', ['deal', 'pipeline', 'stage']],
      ['pitch-deck', 'Build pitch deck structure.', 'Narrative + slide plan.', ['pitch', 'deck', 'slides']],
    ],
  },
  {
    id: 'finance', label: 'Finance',
    rows: [
      ['budgeting', 'Build and track a budget.', 'Zero-based budget draft.', ['budget', 'spending']],
      ['expense-categorization', 'Categorize transactions.', '95%+ accurate tags.', ['expenses', 'transactions', 'categorize']],
      ['invoice-drafting', 'Draft invoices and follow-ups.', 'Send-ready invoices.', ['invoice', 'bill']],
      ['tax-prep', 'Organize tax documents.', 'Complete checklist.', ['tax', 'deductions']],
      ['investment-review', 'Summarize portfolio exposure.', 'Risk concentration report.', ['portfolio', 'investments', 'stocks']],
    ],
  },
  {
    id: 'hr', label: 'HR',
    rows: [
      ['job-description', 'Draft role descriptions.', 'Inclusive, accurate JD.', ['job', 'role', 'hiring']],
      ['resume-screen', 'Screen resumes against criteria.', 'Shortlist with rationale.', ['resume', 'cv', 'candidate']],
      ['interview-scheduling', 'Coordinate interview logistics.', 'Confirmed slots.', ['interview', 'schedule interview']],
      ['performance-feedback', 'Draft structured feedback.', 'Balanced, actionable.', ['feedback', 'performance']],
      ['onboarding-checklist', 'Build onboarding plans.', 'Day-1 ready checklist.', ['onboard new hire', 'checklist']],
    ],
  },
  {
    id: 'operations', label: 'Operations',
    rows: [
      ['process-mapping', 'Document workflows as maps.', 'Stakeholder-validated map.', ['process', 'workflow', 'sop']],
      ['incident-triage', 'Triage operational incidents.', 'Severity + first response.', ['incident', 'outage', 'alert']],
      ['vendor-management', 'Track vendor contracts.', 'Renewal calendar.', ['vendor', 'supplier', 'contract']],
      ['kpi-dashboard', 'Define and assemble KPI views.', 'Single-pane-of-glass view.', ['kpi', 'dashboard', 'metrics']],
      ['runbook-drafting', 'Draft operational runbooks.', 'Step-complete runbooks.', ['runbook', 'playbook']],
    ],
  },
  {
    id: 'health', label: 'Health',
    rows: [
      ['workout-planning', 'Plan workouts for goals.', 'Progressive, safe plan.', ['workout', 'exercise', 'gym']],
      ['meal-planning', 'Plan balanced meals.', 'Nutrition-balanced plan.', ['meal', 'diet', 'menu']],
      ['sleep-analysis', 'Interpret sleep patterns.', 'Actionable sleep tweaks.', ['sleep', 'insomnia']],
      ['symptom-triage', 'Triage symptoms to guidance.', 'Care escalation + watchlist.', ['symptom', 'pain', 'sick']],
      ['habit-tracking', 'Design habit systems.', 'Sustainable cue-routine.', ['habit', 'routine']],
    ],
  },
  {
    id: 'education', label: 'Education',
    rows: [
      ['lesson-planning', 'Design lesson plans.', 'Objective-aligned plan.', ['lesson', 'teach', 'curriculum']],
      ['quiz-generation', 'Generate quizzes from material.', 'Graded, difficulty-banded.', ['quiz', 'questions']],
      ['study-schedule', 'Build spaced study plans.', 'Retention-optimized.', ['study', 'cram', 'prepare for exam']],
      ['concept-explainer', 'Explain concepts at any level.', 'Accurate, age-appropriate.', ['explain', 'what is']],
      ['progress-report', 'Summarize learning progress.', 'Insightful report.', ['progress', 'grade']],
    ],
  },
  {
    id: 'media', label: 'Media',
    rows: [
      ['article-drafting', 'Draft articles from outline.', 'Publish-ready structure.', ['article', 'blog', 'post']],
      ['headline-testing', 'Generate and rank headlines.', 'CTR-ranked options.', ['headline', 'title']],
      ['newsletter', 'Assemble and send newsletters.', 'Scheduled newsletter.', ['newsletter', 'digest']],
      ['video-scripting', 'Script videos from ideas.', 'Shot-by-shot script.', ['video', 'script', 'youtube']],
      ['social-captioning', 'Write platform captions.', 'Platform-adapted captions.', ['caption', 'ig post', 'tweet']],
    ],
  },
  {
    id: 'travel', label: 'Travel',
    rows: [
      ['itinerary-building', 'Build day-by-day itineraries.', 'Realistic and balanced.', ['itinerary', 'trip', 'travel']],
      ['booking-research', 'Compare flights and stays.', 'Best-value shortlist.', ['flight', 'hotel', 'book']],
      ['packing-lists', 'Generate context-aware lists.', 'Zero forgotten essentials.', ['pack', 'packing']],
      ['expense-tracking', 'Track trip expenses.', 'Within-budget tracker.', ['trip expenses', 'travel costs']],
      ['review-digest', 'Digest place reviews.', 'Signal over noise.', ['reviews', 'restaurants']],
    ],
  },
  {
    id: 'food', label: 'Food',
    rows: [
      ['recipe-scaling', 'Scale recipes up and down.', 'Ratio-correct scaling.', ['scale', 'double', 'half recipe']],
      ['grocery-lists', 'Turn meals into grocery lists.', 'Merged, categorized list.', ['grocery', 'shopping list']],
      ['meal-prep', 'Plan batch cooking sessions.', 'Time-budgeted prep plan.', ['meal prep', 'batch']],
      ['dietary-substitution', 'Swap ingredients for diets.', 'Equivalent substitutions.', ['substitute', 'vegan', 'gluten free']],
      ['menu-planning', 'Plan weekly menus.', 'Variety-balanced menu.', ['menu', 'weekly meals']],
    ],
  },
  {
    id: 'legal', label: 'Legal',
    rows: [
      ['contract-review', 'Flag contract risks.', 'Issue list with severity.', ['contract', 'terms', 'agreement']],
      ['clause-explanation', 'Explain clauses in plain terms.', 'Accessible plain English.', ['clause', 'what does this mean']],
      ['compliance-checklist', 'Check against regulations.', 'Gap analysis.', ['compliance', 'gdpr', 'regulation']],
      ['nd-template', 'Draft NDAs and simple templates.', 'Template + guidance.', ['nda', 'non disclosure']],
      ['case-research', 'Summarize case law.', 'Cited precedent digest.', ['case', 'precedent', 'ruling']],
    ],
  },
  {
    id: 'realestate', label: 'Real Estate',
    rows: [
      ['listing-drafting', 'Draft property listings.', 'Compelling + accurate copy.', ['listing', 'property']],
      ['comparable-analysis', 'Analyze comparable sales.', 'Pricing range + evidence.', ['comps', 'comparable', 'price']],
      ['mortgage-calc', 'Model mortgage scenarios.', 'Scenario comparison.', ['mortgage', 'loan', 'payment']],
      ['inspection-checklist', 'Build inspection checklists.', 'Room-by-room checklist.', ['inspection', 'walkthrough']],
      ['staging-advice', 'Advise on staging.', 'Budgeted impact plan.', ['staging', 'sell faster']],
    ],
  },
  {
    id: 'iot', label: 'IoT',
    rows: [
      ['device-onboarding', 'Guide device setup.', 'Configured + verified.', ['setup device', 'smart home', 'onboard']],
      ['automation-recipes', 'Write automation recipes.', 'Working triggers + actions.', ['automation', 'if this then']],
      ['alert-triage', 'Triage device alerts.', 'Anomaly vs noise.', ['device alert', 'sensor']],
      ['energy-audit', 'Analyze energy usage.', 'Savings opportunities.', ['energy', 'power', 'usage']],
      ['routine-builder', 'Build daily routines.', 'Scheduled routine.', ['routine', 'scene']],
    ],
  },
  {
    id: 'gaming', label: 'Gaming',
    rows: [
      ['session-prep', 'Prepare for game sessions.', 'Loadout + strat sheet.', ['session', 'loadout', 'match']],
      ['strategy-analysis', 'Analyze strategies.', 'Win-condition breakdown.', ['strategy', 'build order', 'meta']],
      ['build-theory', 'Theory-craft character builds.', 'Optimized build card.', ['build', 'theorycraft']],
      ['stream-highlights', 'Cut highlight moments.', 'Clip queue ready.', ['highlight', 'clip', 'stream']],
      ['community-digest', 'Summarize community chatter.', 'Topic digest.', ['community', 'meta report']],
    ],
  },
  {
    id: 'social', label: 'Social Media',
    rows: [
      ['post-tweet', 'Publish a tweet with optional media via Playwright.', 'Tweet live on X.com.', ['tweet', 'post on x', 'post to twitter', 'x post']],
      ['comment-tweets', 'Search X.com and comment on matching posts.', 'Comments posted to targeted threads.', ['comment on twitter', 'reply to tweets', 'engage twitter']],
      ['search-x', 'Search X.com for posts on a topic.', 'Top posts returned.', ['search twitter', 'search x', 'find tweets']],
      ['upload-youtube', 'Upload a video to YouTube with title/description.', 'Video published on the channel.', ['upload to youtube', 'publish video', 'youtube upload']],
      ['comment-youtube', 'Search YouTube and comment on the first result.', 'Comment posted on a video.', ['comment youtube', 'youtube comment']],
    ],
  },
  {
    id: 'carousel', label: 'Carousel Designer',
    rows: [
      ['design-carousel', 'Design an Instagram carousel with Claude-generated HTML slides.', 'Pixel-perfect, on-brand slides exported as PNGs.', ['carousel', 'instagram carousel', 'design slides', 'create carousel']],
      ['carousel-chat', 'Chat with Claude to iterate on carousel slide designs.', 'Slides tweaked and refined through conversation.', ['refine slide', 'change carousel', 'edit slide', 'tweak carousel']],
      ['export-carousel', 'Export carousel slides as PNG files ready for Instagram.', 'ZIP of pixel-perfect PNGs at Instagram dimensions.', ['export carousel', 'download slides', 'png carousel']],
      ['carousel-brand', 'Configure brand colors, fonts, and style for carousel generation.', 'All slides stay on-brand with consistent design.', ['brand carousel', 'set brand', 'carousel style', 'brand config']],
    ],
  },
  {
    id: 'crm', label: 'CRM (Twenty)',
    rows: [
      ['crm-companies', 'Create, list, and search companies in the CRM.', 'Companies correctly recorded and searchable.', ['company', 'create company', 'list companies', 'crm', 'client']],
      ['crm-people', 'Create and manage contacts/people in the CRM.', 'Contacts linked to companies with full profiles.', ['person', 'contact', 'add person', 'create contact', 'lead']],
      ['crm-opportunities', 'Track deals and opportunities with pipeline stages.', 'Deals tracked with amount, stage, and close date.', ['opportunity', 'deal', 'pipeline', 'sales pipeline']],
      ['crm-tasks', 'Create and manage CRM tasks and follow-ups.', 'Tasks assigned with due dates and status.', ['crm task', 'follow up', 'reminder']],
      ['crm-notes', 'Add notes to companies, people, or opportunities.', 'Timeline notes attached to the right record.', ['crm note', 'add note', 'log call']],
    ],
  },
  {
    id: 'security', label: 'Security',
    rows: [
      ['phishing-triage', 'Assess suspicious messages.', 'Safe/unsafe verdict.', ['phishing', 'scam', 'suspicious']],
      ['password-hygiene', 'Audit and refresh passwords.', 'Strengthened accounts.', ['password', 'credentials', 'breach']],
      ['breach-watch', 'Monitor breach mentions.', 'Impact report.', ['breach', 'leak', 'compromised']],
      ['2fa-setup', 'Guide two-factor setup.', 'Enrolled accounts.', ['2fa', 'mfa', 'authenticator']],
      ['incident-response', 'Run incident playbooks.', 'Contained + logged.', ['security incident', 'ransomware']],
    ],
  },
];

export const SKILL_DOMAINS: SkillDomain[] = DOMAINS.map(d => ({
  id: d.id,
  label: d.label,
  skills: d.rows.map(([name, purpose, success, triggers]) => ({
    id: `${d.id}.${name}`,
    domain: d.id,
    name,
    purpose,
    success,
    triggers,
  })),
}));

// ── Master Skill Stack Matrix (PDF) — 20 extra specialized domains ──
for (const d2 of MASTER_MATRIX_DOMAINS) {
  SKILL_DOMAINS.push({
    id: d2.id,
    label: d2.label,
    skills: d2.rows.map(([name, purpose, success, triggers]) => ({
      id: `${d2.id}.${name}`,
      domain: d2.id,
      name,
      purpose,
      success,
      triggers,
    })),
  });
}

export const ALL_SKILLS: StackSkill[] = SKILL_DOMAINS.flatMap(d => d.skills);

export function skillCount(): number {
  return ALL_SKILLS.length;
}

export function findSkill(id: string): StackSkill | undefined {
  return ALL_SKILLS.find(s => s.id === id);
}
