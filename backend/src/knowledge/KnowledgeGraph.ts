import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';
import { KnowledgeNode, KnowledgeCategory } from '../types';
import { getLogger } from '../core/Logger';
import { eventBus } from '../core/EventBus';

export class KnowledgeGraph {
  private nodes: Map<string, KnowledgeNode> = new Map();
  private knowledgeDir: string;

  constructor(knowledgeDir: string) {
    this.knowledgeDir = knowledgeDir;
  }

  async initialize(): Promise<void> {
    if (!fs.existsSync(this.knowledgeDir)) {
      fs.mkdirSync(this.knowledgeDir, { recursive: true });
    }
    const seedFile = path.join(this.knowledgeDir, 'index.md');
    if (!fs.existsSync(seedFile)) {
      await this.seedDefaultKnowledge();
    }
    await this.loadAll();
    getLogger().info(`Knowledge graph loaded: ${this.nodes.size} nodes`);
  }

  private async seedDefaultKnowledge(): Promise<void> {
    const defaults: Record<string, { title: string; content: string; tags: string[]; links: string[]; category: KnowledgeCategory }> = {
      'index': {
        title: 'Umbra OS Knowledge Base',
        content: `# Umbra OS Knowledge Base

This is the brain of Umbra OS. Every node contains instructions, patterns, and data the AI needs to operate autonomously.

## Core Domains
- [[system/architecture]] — How Umbra OS is built
- [[automation/virtual-displays]] — Working with virtual displays
- [[automation/click-elements]] — Finding and clicking UI elements
- [[automation/scroll-page]] — Scrolling web pages and documents
- [[automation/type-text]] — Typing text into fields
- [[tools/file-system]] — File system operations
- [[tools/browser]] — Browser automation
- [[tools/sqlite]] — SQLite database operations
- [[tools/screen-capture]] — Capturing and analyzing screenshots
- [[tools/ocr]] — Optical character recognition
- [[config/providers]] — Model provider configuration
- [[config/knowledge-authoring]] — How to write knowledge nodes

## Social Platforms
- [[socials/twitter]] — Twitter/X automation
- [[socials/instagram]] — Instagram automation
- [[socials/reddit]] — Reddit automation
- [[socials/linkedin]] — LinkedIn automation
- [[socials/youtube]] — YouTube automation

## Learned Knowledge (Auto-Generated from Your Activity)
- [[learned/apps]] — All apps I've watched you use
- [[learned/patterns]] — Behavioral patterns I've detected
- [[learned/contexts]] — Contexts and workflows I've learned
- [[self-learning/how-i-learn]] — How I watch and learn from you

## Workflow Domains
Add your custom domains here. Each domain is a folder of nodes teaching Umbra how to operate in that space.`,
        tags: ['root', 'index'],
        links: ['system/architecture', 'automation/virtual-displays', 'tools/file-system', 'config/providers', 'socials/twitter', 'learned/apps', 'learned/patterns', 'learned/contexts', 'self-learning/how-i-learn'],
        category: 'system',
      },
      'system/architecture': {
        title: 'System Architecture',
        content: `# System Architecture

Umbra OS is a local AI computer assistant that runs on Windows.

## High-Level Flow
1. User speaks/types a command
2. Command HUD interprets intent
3. Task Planner breaks it into steps
4. If confidence > 85%, execute on Desktop 2
5. If confidence < 85%, ask user for clarification
6. Self-Healing Guard monitors execution
7. Result streamed back to user

## Key Principles
- Never interrupt Desktop 1 (input guard)
- Every action is logged (audit vault)
- Knowledge is self-updating
- Models are pluggable`,
        tags: ['architecture', 'system'],
        links: ['index'],
        category: 'system',
      },
      'automation/virtual-displays': {
        title: 'Virtual Display Management',
        content: `# Virtual Display Management

Umbra OS creates isolated virtual displays where AI agents work.

## Capabilities
- Create up to 3 virtual displays (1920×1080, 60Hz)
- Each display is an isolated workspace (Swarm slot)
- No physical input can reach these displays
- Displays can run headless (no rendering) for performance

## Usage
- VirtualDisplayManager.create(id) — creates a virtual display
- VirtualDisplayManager.destroy(id) — destroys it
- VirtualDisplayManager.capture(id) — takes screenshot of display

## Windows Implementation
Uses IDDCX (Indirect Display Driver Class Extension) to create virtual monitors. The driver appears as a physical monitor to Windows but routes pixels to our buffer instead of a real screen.`,
        tags: ['automation', 'display', 'windows', 'iddcx'],
        links: ['index', 'tools/screen-capture'],
        category: 'automation',
      },
      'tools/file-system': {
        title: 'File System Operations',
        content: `# File System Operations

## Capabilities
- Read and write files
- Create and delete directories
- List directory contents
- Copy, move, rename files
- Search files by pattern
- Read file metadata

## Methods
- fs.readFile(path) — read file contents
- fs.writeFile(path, content) — write to file
- fs.mkdir(path) — create directory
- fs.glob(pattern) — find files by glob pattern
- fs.copy(src, dest) — copy file or directory`,
        tags: ['tool', 'filesystem'],
        links: ['index'],
        category: 'tool',
      },
      'tools/browser': {
        title: 'Browser Automation',
        content: `# Browser Automation

## Capabilities
- Navigate to URLs
- Click elements by selector, text, or coordinates
- Scroll pages
- Type text into inputs
- Extract page content
- Take screenshots
- Manage tabs and windows
- Handle authentication flows

## Methods
- browser.navigate(url) — go to URL
- browser.click(selector) — click element
- browser.type(selector, text) — type into input
- browser.extract(selector) — get text from elements
- browser.screenshot() — capture page screenshot
- browser.scroll(direction, amount) — scroll page`,
        tags: ['tool', 'browser', 'web'],
        links: ['index', 'tools/screen-capture', 'tools/ocr'],
        category: 'tool',
      },
      'tools/screen-capture': {
        title: 'Screen Capture & Analysis',
        content: `# Screen Capture & Analysis

## Capabilities
- Capture screenshot of any virtual display
- Capture screenshot of specific region
- Compare screenshots for anomaly detection
- Convert to base64 for VLM analysis

## Methods
- capture.display(id) — capture entire display
- capture.region(id, rect) — capture region
- capture.compare(before, after) — detect changes

## VLM Integration
Screenshots are passed to vision-language models for analysis. The VLM can:
- Detect if an app is frozen or showing an error modal
- Read text from the screen (OCR)
- Identify UI elements and their states`,
        tags: ['tool', 'screen', 'capture', 'vision'],
        links: ['index', 'automation/click-elements', 'core/self-healing'],
        category: 'tool',
      },
      'tools/ocr': {
        title: 'OCR — Optical Character Recognition',
        content: `# OCR Capabilities

## Methods
- ocr.read(region) — extract text from screen region
- ocr.find(text) — find text on screen, return coordinates
- ocr.readAll(display) — extract all text from display

## Implementation
Uses the vision model (VLM) for OCR. Screenshot regions are passed to the model with instructions to read text.`,
        tags: ['tool', 'ocr', 'text'],
        links: ['index', 'tools/screen-capture', 'automation/click-elements'],
        category: 'tool',
      },
      'automation/click-elements': {
        title: 'Clicking UI Elements',
        content: `# Clicking UI Elements

## Strategy
1. Find the target element on screen
2. Get its coordinates
3. Send synthetic click to those coordinates on the virtual display

## Methods
- click.coordinates(x, y) — click at specific coordinates
- click.element(selector) — click element by CSS/XPath selector
- click.text(text) — find text on screen and click it
- click.nearest(description) — use VLM to find and click nearest matching element

## Element Finding
- Coordinate clicking: Most reliable when position is known
- Text matching: OCR + coordinate mapping
- VLM-guided: Pass screenshot to VLM, ask it to describe where to click`,
        tags: ['automation', 'click', 'ui'],
        links: ['index', 'tools/screen-capture', 'tools/ocr'],
        category: 'automation',
      },
      'automation/type-text': {
        title: 'Typing Text',
        content: `# Typing Text

## Methods
- type.text(text, target) — type text into a target field
- type.keyboard(keys) — send keyboard shortcuts
- type.paste(text) — paste text from clipboard

## Implementation
Sends synthetic keystrokes to the virtual display's input buffer. Supports:
- Regular text input
- Keyboard shortcuts (Ctrl+C, etc.)
- Special keys (Enter, Tab, Escape)
- Multi-language text via clipboard paste`,
        tags: ['automation', 'type', 'keyboard', 'input'],
        links: ['index', 'automation/click-elements'],
        category: 'automation',
      },
      'automation/scroll-page': {
        title: 'Scrolling Pages',
        content: `# Scrolling

## Methods
- scroll.down(amount) — scroll down by pixels or pages
- scroll.up(amount) — scroll up
- scroll.to(x, y) — scroll to specific position
- scroll.toElement(selector) — scroll until element is visible
- scroll.toBottom() — scroll to bottom of page`,
        tags: ['automation', 'scroll', 'page'],
        links: ['index', 'automation/click-elements'],
        category: 'automation',
      },
      'tools/sqlite': {
        title: 'SQLite Database Operations',
        content: `# SQLite Operations

Umbra uses SQLite for the Recall database.

## Schema
- activity_logs: Records every action Umbra performs
- auto_macros: Stores synthesized macros from pattern detection
- task_history: Stores completed task records

## Methods
- sqlite.query(sql, params) — run query
- sqlite.insert(table, data) — insert row
- sqlite.select(table, where, params) — select rows
- sqlite.backup(path) — backup database`,
        tags: ['tool', 'database', 'sqlite', 'recall'],
        links: ['index', 'core/recall'],
        category: 'tool',
      },
      'config/providers': {
        title: 'Model Provider Configuration',
        content: `# Model Providers

Umbra supports multiple model backends. Configure in ~/.umbra/config.json.

## Supported Providers

### Ollama (Default, Local)
- endpoint: http://localhost:11434
- Recommended models: qwen2.5:14b (reasoning), qwen2.5-vl:7b (vision), qwen2.5:7b (fast)
- Fully offline, no API key needed

### OpenAI
- endpoint: https://api.openai.com/v1
- Models: gpt-4o (reasoning+vision), gpt-4o-mini (fast)
- Requires API key

### Anthropic
- endpoint: https://api.anthropic.com/v1
- Models: claude-3-opus, claude-3-sonnet, claude-3-haiku
- Requires API key

### OpenAI-Compatible
- endpoint: your-endpoint
- Works with any OpenAI-compatible API (vLLM, TGI, etc.)`,
        tags: ['config', 'providers', 'models'],
        links: ['index'],
        category: 'config',
      },
      'self-learning/how-i-learn': {
        title: 'Self-Learning: How Umbra Watches and Learns',
        content: `# Self-Learning System

Umbra OS continuously watches your activity on Desktop 1 to learn your workflows.

## How It Works

1. **Activity Watcher** polls the foreground window every 3 seconds
2. It records: app name, window title, duration, keystrokes, clicks, URLs, file paths
3. Data goes into the **Recall Database** (user_activity table)
4. The **Recall-to-Knowledge Bridge** ingests activity into the Knowledge Graph
5. The **Proactive Agent** checks for patterns every 30 seconds
6. When patterns repeat 3+ times, a knowledge node is auto-created

## What Gets Learned

| Type | Trigger | Example |
|------|---------|---------|
| App nodes | 5+ activities in same app | "App: Visual Studio Code" |
| Context nodes | 2+ apps share same tag | "Context: Development" |
| Workflow nodes | 3+ repeated app sequences | "chrome -> vscode -> terminal" |
| Macros | 5+ repeated action sequences | "deploy_to_production" |

## Self-Healing Knowledge

- Knowledge nodes include a confidence score
- Nodes with low confidence are flagged for review
- Frequently accessed nodes are prioritized
- Stale nodes (not accessed in 30 days) are archived

## My Knowledge Schema

Every learned node has:
- id: unique path like "learned/apps/vscode"
- title: Human-readable name
- tags: For searching and categorization
- links: Related nodes
- category: app, pattern, context, or workflow
- content: Markdown with instructions for the AI`,
        tags: ['self-learning', 'system', 'how-it-works'],
        links: ['index', 'system/architecture', 'learned/apps', 'learned/patterns'],
        category: 'system',
      },
      'learned/apps': {
        title: 'Learned Apps Index',
        content: `# Apps Umbra Has Learned

This index is auto-generated. Each node below represents an app that Umbra has observed you using.

*Auto-generated knowledge index.*`,
        tags: ['learned', 'index', 'apps'],
        links: ['index', 'self-learning/how-i-learn'],
        category: 'domain',
      },
      'learned/patterns': {
        title: 'Learned Patterns Index',
        content: `# Behavioral Patterns Detected

This index is auto-generated. Each node below represents a repeated pattern in your workflow.

*Auto-generated knowledge index.*`,
        tags: ['learned', 'index', 'patterns'],
        links: ['index', 'self-learning/how-i-learn'],
        category: 'workflow',
      },
      'learned/contexts': {
        title: 'Learned Contexts Index',
        content: `# Contexts Umbra Has Learned

This index is auto-generated. Each node below represents a context detected from your app usage patterns.

*Auto-generated knowledge index.*`,
        tags: ['learned', 'index', 'contexts'],
        links: ['index', 'self-learning/how-i-learn'],
        category: 'domain',
      },
      'config/knowledge-authoring': {
        title: 'Knowledge Authoring Guide',
        content: `# Knowledge Authoring

This is how Umbra teaches itself.

## File Format
Each node is a markdown file with YAML front matter:
---
title: Node Title
tags: [tag1, tag2]
links: [related/node1, related/node2]
category: tool
---

Content with instructions...

## Linking
Use [[node-id]] syntax to link to other nodes. Links are resolved automatically.

## Node IDs
The file path (without .md) becomes the node ID.
Example: socials/twitter.md → id: "socials/twitter"

## Categories
- social: Social platform knowledge
- automation: Automation patterns
- tool: Tool capabilities
- domain: User workflow domains
- config: Configuration knowledge
- system: System architecture
- workflow: How to combine capabilities`,
        tags: ['config', 'authoring', 'meta'],
        links: ['index'],
        category: 'config',
      },
      'socials/twitter': {
        title: 'Twitter/X Automation',
        content: `# Twitter/X Automation

## Access
- URL: https://twitter.com
- Requires login
- Two-factor authentication may be present

## Common Tasks

### Post a Tweet
1. Navigate to twitter.com
2. Click "Post" button
3. Type content
4. Click "Post" to submit

### Search
1. Navigate to twitter.com/explore
2. Click search bar
3. Type query + Enter

### Read Timeline
1. Navigate to twitter.com/home
2. Scroll to load more tweets
3. Extract tweet content

### Get Trending Topics
1. Navigate to twitter.com/explore
2. Read "Trends for you" section`,
        tags: ['social', 'twitter', 'x'],
        links: ['index', 'tools/browser'],
        category: 'social',
      },
      'socials/instagram': {
        title: 'Instagram Automation',
        content: `# Instagram Automation

## Access
- URL: https://instagram.com
- Requires login
- Rate limiting is aggressive

## Common Tasks

### Post an Image
1. Navigate to instagram.com
2. Click + button
3. Upload image
4. Write caption
5. Click Share

### Search
1. Click search icon
2. Type query
3. Select result

### Extract Feed
1. Scroll feed
2. Extract image URLs and captions`,
        tags: ['social', 'instagram'],
        links: ['index', 'tools/browser'],
        category: 'social',
      },
      'socials/reddit': {
        title: 'Reddit Automation',
        content: `# Reddit Automation

## Access
- URL: https://reddit.com
- Login recommended for posting
- API rate limits apply

## Common Tasks

### Search Subreddit
1. Navigate to reddit.com/r/subreddit
2. Use search bar

### Extract Top Posts
1. Navigate to subreddit
2. Sort by top/hour/day/week/month/all
3. Scroll and extract

### Post
1. Click "Create Post"
2. Select community
3. Write title and content
4. Submit`,
        tags: ['social', 'reddit'],
        links: ['index', 'tools/browser'],
        category: 'social',
      },
      'socials/linkedin': {
        title: 'LinkedIn Automation',
        content: `# LinkedIn Automation

## Access
- URL: https://linkedin.com
- Requires login
- Rate limits are strict — slow down

## Common Tasks

### Search People
1. Navigate to linkedin.com/search
2. Use search filters
3. Scroll results

### Extract Profile
1. Navigate to profile URL
2. Extract headline, about, experience
3. Scroll to load all sections

### Post
1. Click "Start a post"
2. Write content
3. Click "Post"`,
        tags: ['social', 'linkedin', 'professional'],
        links: ['index', 'tools/browser'],
        category: 'social',
      },
      'socials/youtube': {
        title: 'YouTube Automation',
        content: `# YouTube Automation

## Access
- URL: https://youtube.com
- Google account login required for some features

## Common Tasks

### Search Videos
1. Navigate to youtube.com
2. Click search bar
3. Type query + Enter

### Extract Video Info
1. Navigate to video URL
2. Extract title, description, comments
3. Scroll for related videos

### Upload Video
1. Click camera icon
2. Select file
3. Fill in details
4. Set visibility

### Read Comments
1. Scroll below video
2. Extract comment threads`,
        tags: ['social', 'youtube', 'video'],
        links: ['index', 'tools/browser'],
        category: 'social',
      },
    };

    for (const [id, data] of Object.entries(defaults)) {
      await this.writeNode(id, data);
    }
  }

  private async writeNode(id: string, data: { title: string; content: string; tags: string[]; links: string[]; category: KnowledgeCategory }): Promise<void> {
    const filePath = path.join(this.knowledgeDir, `${id}.md`);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const frontMatter = {
      title: data.title,
      tags: data.tags,
      links: data.links,
      category: data.category,
    };

    const md = matter.stringify(data.content, frontMatter);
    fs.writeFileSync(filePath, md, 'utf-8');
  }

  async loadAll(): Promise<void> {
    this.nodes.clear();
    const files = this.findMarkdownFiles(this.knowledgeDir);
    for (const file of files) {
      const node = this.loadFile(file);
      if (node) {
        this.nodes.set(node.id, node);
      }
    }
  }

  private findMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...this.findMarkdownFiles(fullPath));
        } else if (entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }
    } catch { }
    return results;
  }

  private loadFile(filePath: string): KnowledgeNode | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = matter(raw);
      const relativePath = path.relative(this.knowledgeDir, filePath);
      const id = relativePath.replace(/\.md$/, '').replace(/\\/g, '/');

      return {
        id,
        title: parsed.data.title || id,
        content: parsed.content,
        tags: parsed.data.tags || [],
        links: parsed.data.links || [],
        category: parsed.data.category || 'domain',
        updatedAt: new Date(),
      };
    } catch (err) {
      getLogger().warn({ err, filePath }, 'Failed to load knowledge node');
      return null;
    }
  }

  async getNode(id: string): Promise<KnowledgeNode | null> {
    const node = this.nodes.get(id);
    if (node) return node;

    const filePath = path.join(this.knowledgeDir, `${id}.md`);
    if (fs.existsSync(filePath)) {
      const loaded = this.loadFile(filePath);
      if (loaded) {
        this.nodes.set(loaded.id, loaded);
        return loaded;
      }
    }
    return null;
  }

  async search(query: string): Promise<KnowledgeNode[]> {
    const q = query.toLowerCase();
    const results: KnowledgeNode[] = [];

    for (const node of this.nodes.values()) {
      if (
        node.title.toLowerCase().includes(q) ||
        node.tags.some(t => t.toLowerCase().includes(q)) ||
        node.content.toLowerCase().includes(q)
      ) {
        results.push(node);
      }
    }

    return results.sort((a, b) => {
      const aTitle = a.title.toLowerCase().includes(q) ? 2 : 0;
      const aTags = a.tags.some(t => t.toLowerCase().includes(q)) ? 1 : 0;
      const bTitle = b.title.toLowerCase().includes(q) ? 2 : 0;
      const bTags = b.tags.some(t => t.toLowerCase().includes(q)) ? 1 : 0;
      return (bTitle + bTags) - (aTitle + aTags);
    });
  }

  async getByCategory(category: KnowledgeCategory): Promise<KnowledgeNode[]> {
    return Array.from(this.nodes.values()).filter(n => n.category === category);
  }

  async getLinked(nodeId: string): Promise<KnowledgeNode[]> {
    const node = await this.getNode(nodeId);
    if (!node) return [];
    const linked: KnowledgeNode[] = [];
    for (const linkId of node.links) {
      const linkedNode = await this.getNode(linkId);
      if (linkedNode) linked.push(linkedNode);
    }
    return linked;
  }

  async addOrUpdate(id: string, title: string, content: string, tags: string[], links: string[], category: KnowledgeCategory): Promise<KnowledgeNode> {
    const node: KnowledgeNode = {
      id,
      title,
      content,
      tags,
      links,
      category,
      updatedAt: new Date(),
    };

    this.nodes.set(id, node);
    await this.writeNode(id, { title, content, tags, links, category });
    eventBus.emit('knowledge:updated', id);
    return node;
  }

  async learnFromExecution(taskDescription: string, steps: string[], result: string): Promise<void> {
    const id = `learned/${Date.now()}`;
    const content = `# Learned Workflow: ${taskDescription}\n\n## Steps\n${steps.map(s => `- ${s}`).join('\n')}\n\n## Result\n${result}\n\n*Auto-generated from execution. Review before relying on.*`;

    await this.addOrUpdate(
      id,
      `Learned: ${taskDescription}`,
      content,
      ['learned', 'auto-generated'],
      ['index'],
      'workflow'
    );
  }

  getAllNodes(): KnowledgeNode[] {
    return Array.from(this.nodes.values());
  }
}
