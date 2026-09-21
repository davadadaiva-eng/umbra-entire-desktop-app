/**
 * Master Skill Stack Matrix (from the UmbraOS master documentation).
 * 20 specialized domains. Skills whose backing repo was verified on GitHub
 * (`repo`) can load their SKILL.md content from `external/skills/`; the rest
 * are catalog definitions (prompt-routed) awaiting a public repo or endpoint.
 */

import { SkillRow } from './SkillStack';

export interface MasterMatrixDomain {
  id: string;
  label: string;
  repo?: string;
  repoPath?: string;
  rows: SkillRow[];
}

export const MASTER_MATRIX_DOMAINS: MasterMatrixDomain[] = [
  {
    id: 'tax', label: 'Tax, Accounting & Fiscal Advisory', repo: 'tax-ai/regime-fiscale-analyzer',
    rows: [
      ['regime-fiscale-analyzer', 'Analysis and simulation of tax regimes (Forfettario, Semplificato, Ordinario, SRL) and social contribution calculations.', 'Clear regime recommendation with contribution estimates.', ['forfettario', 'regime', 'srl', 'fiscal']],
      ['f24-tax-calculator', 'Automated calculation of taxes, withholding amounts, social security contributions, and F24 form generation with deadlines.', 'Correct F24 amounts and deadlines generated.', ['f24', 'withholding', 'deadline']],
      ['deduzioni-detrazioni', 'Corporate expense and invoice scanning to maximize legal tax deductions and reliefs.', 'Maximized legal deductions with evidence.', ['deduction', 'deductions', 'relief']],
      ['e-fattura-validator', 'Formal and semantic validation of electronic invoices (SDI standard) prior to transmission.', 'Validated invoices ready for SDI transmission.', ['fattura', 'sdi', 'invoice validate']],
      ['cassetto-fiscale-sync', 'Integration with institutional tax portals to monitor deadlines, debt notices, and fiscal standing.', 'Up-to-date fiscal standing report.', ['cassetto', 'tax portal', 'debt notice']],
    ],
  },
  {
    id: 'frontend', label: 'Frontend & UI/UX Design',
    rows: [
      ['design-engineering', 'Design engineering, fluid transitions, and spring physics easing curves.', 'Motion specs with easing curves.', ['spring', 'transition', 'easing']],
      ['taste-skill', 'Advanced typographic hierarchy, rhythmic spacing, and high-end minimal design.', 'Refined typographic system.', ['typography', 'spacing', 'minimal']],
      ['agent-react-skills', 'Native integration of accessible, scalable components (Tailwind + Radix).', 'Accessible, scalable components.', ['radix', 'tailwind', 'component']],
      ['motion-skills', 'Complex scroll-driven animations and cinematic layout transitions.', 'Cinematic scroll animations.', ['scroll', 'animation', 'motion']],
      ['virtual-dom-optimization', 'Extreme virtual DOM optimization and clean React patterns.', 'Optimized render performance.', ['react', 'virtual dom', 'render']],
      ['design-system-rules', 'Strict rules to maintain a coherent design system and prevent chaotic utility classes.', 'Coherent design tokens.', ['design system', 'tokens', 'utility classes']],
    ],
  },
  {
    id: 'seo', label: 'SEO & Growth Engineering',
    rows: [
      ['technical-seo-audit', 'Technical SEO audits, keyword clustering, and CRO.', 'Ranked technical fixes.', ['seo audit', 'keyword cluster', 'cro']],
      ['architecture-scan', 'Architectural site scanning and Core Web Vitals assessment.', 'Core Web Vitals report.', ['web vitals', 'lcp', 'cls']],
      ['programmatic-seo', 'Scalable page generation based on structured data and search intent.', 'Templated pages at scale.', ['programmatic', 'template pages']],
      ['search-console-ga4', 'Direct connection with Google Search Console and GA4 for traffic trend analysis.', 'Traffic trend analysis.', ['search console', 'ga4', 'traffic']],
      ['cognee-memory', 'Long-term semantic memory mapping domain authority and topic clusters.', 'Domain authority map.', ['semantic memory', 'topic cluster', 'authority']],
    ],
  },
  {
    id: 'social', label: 'Social Media & Content Distribution',
    rows: [
      ['ads-copywriting', 'High-retention copywriting frameworks and social psychology principles.', 'Retention-optimized copy.', ['social copy', 'retention', 'psychology']],
      ['editorial-calendar', 'Multi-platform editorial calendars (X, LinkedIn, TikTok, IG).', 'Two-week editorial calendar.', ['calendar', 'linkedin', 'tiktok']],
      ['shorts-director', 'Directorial rules to transform long-form content into viral vertical videos.', 'Clip-stacked vertical cut.', ['shorts', 'reels', 'vertical']],
      ['engagement-patterns', 'High-engagement visual and textual pattern analysis.', 'Engagement pattern report.', ['engagement', 'viral pattern']],
      ['humanize-copy', 'Strips away robotic styling to make copy natural, persuasive, and authentic.', 'Human-sounding copy.', ['humanize', 'natural', 'authentic']],
    ],
  },
  {
    id: 'paid-ads', label: 'Paid Ads & Performance Marketing',
    rows: [
      ['audience-targeting', 'Budget and audience targeting interaction via MCP layers.', 'Audience targeting plan.', ['audience', 'targeting', 'budget']],
      ['google-ads-optimizer', 'Paid keyword optimization, bidding strategies, and CTR maximization.', 'Optimized bidding strategy.', ['google ads', 'bidding', 'ctr']],
      ['meta-ads-scaling', 'Audience segmentation and creative fatigue mitigation.', 'Scaled audience plan.', ['meta ads', 'segmentation', 'fatigue']],
      ['tiktok-ads-master', 'Strategic positioning frameworks for sponsored short-form video.', 'Positioned campaign brief.', ['tiktok ads', 'short-form', 'sponsored']],
      ['paid-media-framework', 'ROI analysis, CAC/LTV calculation, and automated retargeting flows.', 'ROI and CAC/LTV model.', ['roi', 'cac', 'ltv', 'retargeting']],
    ],
  },
  {
    id: 'sales-copy', label: 'Sales & Copywriting',
    rows: [
      ['copywriting-masterclass', 'Execution of AIDA, PAS, and Hook-Story-Offer frameworks.', 'Framework-based copy.', ['aida', 'pas', 'hook-story-offer']],
      ['email-sequences', 'Personalized outbound email sequences optimized for high response rates.', 'Send-ready sequence.', ['outbound', 'email sequence', 'cold email']],
      ['landing-page-conversion', 'Copy analysis and rewriting focused on friction removal.', 'Lowered-friction variant.', ['landing page', 'friction', 'conversion']],
      ['sales-psychology', 'Application of urgency, scarcity, and social proof mental triggers.', 'Ethical trigger map.', ['urgency', 'scarcity', 'social proof']],
      ['funnel-architecture', 'End-to-end logical sales funnel design.', 'Full funnel blueprint.', ['funnel', 'journey', 'pipeline']],
    ],
  },
  {
    id: 'video', label: 'Video Editing & Multimedia', repo: 'DojoCodingLabs/remotion-superpowers',
    rows: [
      ['multi-track-timeline', 'Multi-track timeline management and intelligent video clipping.', 'Edited timeline cut.', ['timeline', 'clip', 'multitrack']],
      ['remotion-superpowers', 'Full programmatic control of Remotion for transitions and voiceover sync.', 'Rendered Remotion composition.', ['remotion', 'transition', 'voiceover']],
      ['animated-components', 'Dynamic library of animated components fetched instantly by agents.', 'Reusable animated component.', ['animation component', 'motion bit']],
      ['voice-synthesis', 'Control of emotional parameters and synthetic voice synchronization.', 'Synced emotional VO.', ['synthetic voice', 'emotion', 'vo']],
      ['render-pipeline', 'Headless rendering optimization on cloud Docker nodes using FFmpeg.', 'Headless render config.', ['ffmpeg', 'headless render', 'encode']],
    ],
  },
  {
    id: 'meetings', label: 'Meetings, Calls & AgentPhone',
    rows: [
      ['realtime-voice', 'Ultra-low latency bidirectional conversational voice calling flows.', 'Low-latency voice flow.', ['voice call', 'realtime', 'conversation']],
      ['cli-meet', 'Transcription, summarization, and action item extraction from audio/video meetings.', 'Meeting summary with actions.', ['transcribe', 'meeting notes', 'action items']],
      ['meeting-intelligence', 'Sentiment analysis and key point extraction during calls.', 'Sentiment + key points.', ['sentiment', 'call insights', 'key points']],
      ['tts-stream', 'Real-time streaming text-to-speech for immediate conversational responses.', 'Streamed TTS response.', ['tts', 'text to speech', 'speak']],
      ['call-routing', 'Intelligent call queue handling and request routing.', 'Routed call queue.', ['call routing', 'queue', 'transfer']],
    ],
  },
  {
    id: 'legal-compliance', label: 'Legal, Privacy & Compliance',
    rows: [
      ['legal-document-gen', 'Automated generation of Privacy Policies, Cookie Policies, and Terms of Service.', 'Compliant generated docs.', ['privacy policy', 'cookie policy', 'terms']],
      ['consent-manager', 'User consent management and privacy-compliant tracking.', 'Consent ledger.', ['consent', 'opt-in', 'gdpr']],
      ['copyright-validator', 'Pre-emptive copyright infringement checks for texts, images, and video assets.', 'Infringement risk report.', ['copyright', 'infringement', 'usage rights']],
      ['compliance-checker', 'Automated code audits against corporate security benchmarks.', 'Compliance gap audit.', ['compliance audit', 'benchmark', 'security review']],
      ['contract-analyzer', 'Extraction of critical clauses from contracts and Non-Disclosure Agreements.', 'Clause risk digest.', ['contract', 'nda', 'clause']],
    ],
  },
  {
    id: 'support', label: 'Customer Support & Success',
    rows: [
      ['ticket-routing', 'Automated classification and triage of incoming support tickets.', 'Triaged ticket queue.', ['ticket', 'triage', 'classify']],
      ['docs-auto-resolver', 'Contextual automated responses driven by official company documentation.', 'Docs-grounded reply.', ['support reply', 'knowledge base', 'docs']],
      ['churn-predictor', 'Early detection of user dissatisfaction to prevent customer churn.', 'Churn risk signals.', ['churn', 'at risk', 'dissatisfaction']],
      ['onboarding-flows', 'Interactive guided paths delivered via chat or voice.', 'Guided onboarding flow.', ['onboarding', 'welcome', 'guided']],
      ['faq-auto-writer', 'Conversion of resolved support interactions into structured FAQs and user guides.', 'FAQ catalog entry.', ['faq', 'guide', 'how-to']],
    ],
  },
  {
    id: 'data-bi', label: 'Data Analytics & Business Intelligence',
    rows: [
      ['sql-query-generator', 'Writing and optimizing database queries for Tencent DB and Supabase.', 'Optimized SQL.', ['sql', 'query', 'supabase']],
      ['kpi-tracker', 'Real-time tracking of MRR, Churn, CAC, and LTV.', 'Live KPI dashboard.', ['mrr', 'churn', 'cac', 'ltv']],
      ['dashboard-builder', 'Autonomous generation of visual dashboards and business report suites.', 'Generated dashboard.', ['dashboard', 'report', 'visuals']],
      ['retention-metrics', 'Behavioral analysis of user cohorts over time.', 'Cohort retention curve.', ['cohort', 'retention', 'behavior']],
      ['metrics-watchdog', 'Early-warning alert systems for abnormal KPI fluctuations.', 'Anomaly alert.', ['anomaly', 'kpi alert', 'watchdog']],
    ],
  },
  {
    id: 'cyber', label: 'Cybersecurity & Prompt Safety',
    rows: [
      ['prompt-firewall', 'Active defense mechanisms against prompt injection and jailbreak attempts.', 'Blocked injection attempts.', ['prompt injection', 'jailbreak', 'defense']],
      ['vulnerability-scanner', 'Automated vulnerability scanning of container dependencies (CVE tracking).', 'CVE report.', ['cve', 'vulnerability', 'scan']],
      ['jwt-oauth-master', 'Rigorous token lifecycle management, authentication, and end-to-end encryption.', 'Token lifecycle plan.', ['jwt', 'oauth', 'token']],
      ['pii-redactor', 'Automatic masking of Personally Identifiable Information (PII) before external API calls.', 'Masked payloads.', ['pii', 'redact', 'mask']],
      ['rate-limiting-guard', 'Protection against DDoS attacks and cloud resource abuse.', 'Rate limit policy.', ['rate limit', 'ddos', 'abuse']],
    ],
  },
  {
    id: 'product', label: 'Product Management & Roadmap Strategy',
    rows: [
      ['prd-generator', 'Automated generation of detailed Product Requirement Documents (PRDs).', 'Complete PRD.', ['prd', 'requirements', 'spec']],
      ['backlog-grooming', 'Organization, estimation, and prioritization of development backlogs.', 'Prioritized backlog.', ['backlog', 'estimation', 'priority']],
      ['feedback-synthesizer', 'Aggregation and structuring of user feedback to identify high-demand features.', 'Feature demand report.', ['feedback', 'feature request', 'aggregate']],
      ['roadmap-engine', 'Product roadmap creation mapped to milestones and cloud resource availability.', 'Milestone roadmap.', ['roadmap', 'milestones', 'timeline']],
    ],
  },
  {
    id: 'hr-ops', label: 'HR, Operations & Hiring',
    rows: [
      ['cv-screener', 'Automated CV and portfolio evaluation based on precise company requirements.', 'Shortlist with rationale.', ['cv', 'resume', 'candidate']],
      ['interview-evaluator', 'Generation of technical questions and behavioral test suites for targeted candidate interviews.', 'Question set per role.', ['interview', 'technical questions']],
      ['workflow-orchestrator', 'Optimization of internal operational processes across agent pipelines.', 'Optimized workflow.', ['workflow', 'process', 'pipeline']],
      ['employee-handbook', 'Automated creation of guides and onboarding paths for new personnel or digital agents.', 'Handbook draft.', ['handbook', 'onboarding', 'guide']],
    ],
  },
  {
    id: 'devops', label: 'DevOps, Cloud Infrastructure & Auto-Scaling',
    rows: [
      ['docker-orchestrator', 'Dockerfile optimization, persistent volume tracking, and strict resource limiting.', 'Optimized Dockerfile.', ['dockerfile', 'container', 'resource limit']],
      ['auto-scaling-rules', 'Predictive rules to scale cloud container instances based on agent workloads.', 'Scaling policy.', ['auto scale', 'predictive', 'capacity']],
      ['pipeline-generator', 'Creation and debugging of CI/CD pipelines (GitHub Actions / GitLab CI).', 'Working pipeline.', ['ci', 'cd', 'github actions', 'gitlab']],
      ['cluster-health', 'Autonomous network diagnostics and crash/memory leak resolution.', 'Cluster health report.', ['cluster', 'memory leak', 'crash']],
      ['backup-restore-bot', 'Management of automated database snapshots and disaster recovery protocols.', 'Backup plan + DR runbook.', ['backup', 'snapshot', 'disaster recovery']],
    ],
  },
  {
    id: 'pr', label: 'PR, Media Relations & Crisis Management',
    rows: [
      ['press-release-writer', 'Professional press release drafting for tech and financial publications.', 'Publish-ready release.', ['press release', 'announcement']],
      ['sentiment-watchdog', 'Continuous online mention monitoring to preempt public relations issues.', 'Mention pulse report.', ['mentions', 'sentiment', 'reputation']],
      ['pitch-email-generator', 'Customized pitch email creation for journalists and editorial desks.', 'Send-ready pitch email.', ['pitch', 'journalist', 'media email']],
      ['crisis-response', 'Rapid generation of communication strategies and official statements during emergencies.', 'Crisis statement.', ['crisis', 'statement', 'official response']],
      ['author-voice', 'High-profile opinion article (op-ed) development for company founders.', 'Op-ed draft.', ['op-ed', 'thought leadership', 'opinion']],
    ],
  },
  {
    id: 'localization', label: 'Localization, Translation & Cultural Adaptation',
    rows: [
      ['native-translator', 'Advanced contextual translation covering local slang and idioms.', 'Idiom-aware translation.', ['translate', 'idiom', 'slang']],
      ['codebase-localizer', 'Management of internationalization files (JSON/PO) for instant multi-language interfaces.', 'i18n file updates.', ['i18n', 'localization', 'json', 'po']],
      ['market-validator', 'Pre-emptive compliance analysis of international marketing copy and campaigns.', 'Market compliance check.', ['market check', 'cultural', 'compliance']],
      ['hreflang-manager', 'International SEO optimization with correct multi-language tag management.', 'Corrected hreflang map.', ['hreflang', 'multilingual seo', 'tags']],
      ['multilingual-audio', 'Speech timing adaptation for multi-language audio synchronization.', 'Synced multi-language audio.', ['dubbing', 'audio sync', 'voice-over']],
    ],
  },
  {
    id: 'fundraising', label: 'Financial Modeling, Fundraising & VC Pitching',
    rows: [
      ['deck-generator', 'Silicon Valley-standard investor presentation structuring and drafting.', 'Investor deck outline.', ['deck', 'pitch', 'investor']],
      ['saas-metrics', 'Predictive financial modeling covering LTV/CAC ratios, burn rates, runway, and long-term forecasts.', 'Financial model.', ['burn rate', 'runway', 'ltv/cac']],
      ['data-room-manager', 'Secure organization and access control of Virtual Data Rooms for due diligence.', 'Organized data room.', ['data room', 'due diligence', 'access control']],
      ['valuation-engine', 'Enterprise valuation calculation using discounted cash flows (DCF) and market multiples.', 'Valuation range.', ['valuation', 'dcf', 'multiples']],
      ['term-sheet-analyzer', 'Analysis and negotiation advisory for investment term sheets.', 'Term sheet review.', ['term sheet', 'negotiation', 'dilution']],
    ],
  },
  {
    id: 'supply-chain', label: 'Supply Chain, Logistics & Inventory Management',
    rows: [
      ['inventory-tracker', 'Real-time stock level monitoring with predictive resource reordering.', 'Reorder alerts.', ['inventory', 'stock', 'reorder']],
      ['vendor-optimizer', 'Comparative cost analysis of global suppliers to negotiate favorable rates.', 'Supplier cost matrix.', ['vendor', 'supplier', 'cost comparison']],
      ['fulfillment-bot', 'Automation and tracking of physical or digital shipments with delivery delay alerts.', 'Shipment tracking.', ['shipment', 'fulfillment', 'delivery delay']],
      ['smart-contract-rfq', 'Automated Request for Quotation (RFQ) generation dispatched to commercial partners.', 'RFQ dispatched.', ['rfq', 'quotation', 'procurement']],
      ['warehouse-cost-reduction', 'Optimization algorithms designed to drive down storage and handling overheads.', 'Cost reduction plan.', ['warehouse', 'storage cost', 'overhead']],
    ],
  },
  {
    id: 'ip', label: 'Intellectual Property & Patent Engineering',
    rows: [
      ['prior-art-search', 'Global patent database scans to verify invention or feature originality.', 'Prior art report.', ['prior art', 'patent search', 'novelty']],
      ['claims-writer', 'Technical drafting of patent claims and documentation (USPTO / EUIPO).', 'Drafted claims.', ['patent claims', 'uspto', 'euipo']],
      ['brand-protection', 'Global domain name, social media, and trademark registry monitoring against counterfeiting.', 'Infringement alert.', ['trademark', 'counterfeit', 'domain watch']],
      ['license-auditor', 'Compliance checks on dependency licenses to eliminate legal conflicts.', 'License compliance report.', ['license', 'opensource license', 'conflict']],
      ['ip-portfolio-manager', 'Strategic management of corporate intellectual property assets to maximize investor appeal.', 'IP portfolio map.', ['ip portfolio', 'assets', 'strategy']],
    ],
  },
];

/** Domains whose backing repo was verified to exist on GitHub. */
export const VERIFIED_MATRIX_REPOS: Record<string, { repo: string; repoPath: string }> = {
  'adkit/ads-skills': { repo: 'adkit/ads-skills', repoPath: 'external/skills/adkit__ads-skills' },
  'blader/humanizer': { repo: 'blader/humanizer', repoPath: 'external/skills/blader__humanizer' },
  'coreyhaines31/marketingskills': { repo: 'coreyhaines31/marketingskills', repoPath: 'external/skills/coreyhaines31__marketingskills' },
  'DojoCodingLabs/remotion-superpowers': { repo: 'DojoCodingLabs/remotion-superpowers', repoPath: 'external/skills/DojoCodingLabs__remotion-superpowers' },
  'emilkowalski/skill': { repo: 'emilkowalski/skill', repoPath: 'external/skills/emilkowalski__skill' },
  'hyperfx-ai/marketing-skills': { repo: 'hyperfx-ai/marketing-skills', repoPath: 'external/skills/hyperfx-ai__marketing-skills' },
  'Leonxlnx/taste-skill': { repo: 'Leonxlnx/taste-skill', repoPath: 'external/skills/Leonxlnx__taste-skill' },
  'openclaudia/openclaudia-skills': { repo: 'openclaudia/openclaudia-skills', repoPath: 'external/skills/openclaudia__openclaudia-skills' },
  'topoteretes/cognee': { repo: 'topoteretes/cognee', repoPath: 'external/skills/topoteretes__cognee' },
  'twominutereports/marketing-skills': { repo: 'twominutereports/marketing-skills', repoPath: 'external/skills/twominutereports__marketing-skills' },
};