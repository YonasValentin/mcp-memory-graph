# Getting Past AI Slop: Frontend Design with Claude Code

That's a common frustration — the skill helps but it's not a magic fix on its own. Let me dig into what people who've actually gotten past the AI slop barrier are doing differently. Here's the honest truth: the `frontend-design` skill alone isn't enough. It's a ~400 token nudge — it changes Claude's defaults, but it doesn't give Claude *taste*. The people getting genuinely good results are doing more. Here's what actually works:

## 1. The Screenshot Loop (the biggest unlock)

The core problem is that Claude Code generates code but can't *see* what it built — it's working blind, making decisions based on code structure rather than visual output. The fix is setting up Puppeteer to screenshot your site during development so Claude can evaluate its own output and self-correct.

The workflow becomes: Claude generates a section, screenshots it, analyzes the screenshot, and fixes issues it spots — all without you saying a word. People report going from "70% there" on first generation to catching and fixing spacing, overlap, and proportion issues automatically. Each screenshot pass takes 15 to 30 seconds, but for anything client-facing, running it makes a visible difference.

## 2. Feed It Real Visual References

This is probably what you're missing. The workflow that actually produces good results involves pasting screenshots of designs you admire directly into your prompt — "Here are some design inspirations of the format that I currently like: [Pasted Image 1], [Pasted Image 2]." Claude can see images, so show it what Awwwards-quality looks like for *your* specific project.

Screenshots of portfolios you admire or even UI code snippets from designs you like help Claude understand your aesthetic direction.

A newer pipeline people are using: grab a screenshot from Pinterest, Dribbble, or godly.website of a layout that matches your target aesthetic, then use that as a reference. Some people are even using **Google Stitch** to generate a high-fidelity mockup first, export its `DESIGN.md`, and pass that to Claude Code as the source of truth.

## 3. Write a Proper Design System README, Not Just CLAUDE.md

One developer had Claude write a 300+ line design system README covering fonts, colors, spacing rules, and component patterns — then referenced it in every prompt. They called this a crucial step because without style guidelines, Claude easily goes astray.

The trick is to be *specific*: choose your exact fonts beforehand (and explain *why*), define your spacing scale, your color palette with named tokens, your animation philosophy. The skill says "be bold" but doesn't tell Claude what *your* bold looks like.

## 4. Build Section by Section, Not Full Pages

Reference cloning works better on sections than full pages. Trying to clone an entire homepage at once tends to produce something loosely inspired rather than closely matched. Breaking it into header, body, and footer gives you a lot more control.

On average after 3-5 messages per section, you'd have something 80-90% there.

## 5. Stack Additional Skills

The **UI/UX Pro Max** skill gives Claude a searchable database of 50+ UI styles, 97 color palettes, 57 font pairings, and 99 UX guidelines — it's the most comprehensive design intelligence skill in the ecosystem. Combine it with the frontend-design skill and Vercel's web design guidelines for layered quality.

## The Honest Bottom Line

The skill alone changes Claude's output from "obviously AI" to "less obviously AI." Getting to *actually good* requires the same thing it always does: a clear design vision you bring yourself, visual references, and iterative feedback. The screenshot loop is the closest thing to a silver bullet — it lets Claude close the gap between "code that should look right" and "actually looks right."

---

# Beyond Design Systems: The Animation & Interaction Layer

Good question — you're right to push further. The UI/UX Pro Max skill is great for *design system intelligence* (picking the right palette, fonts, layout patterns for an industry), but it doesn't actually teach Claude how to build the kind of buttery-smooth parallax, scroll-driven animations, and spatial depth you see on Awwwards or Apple's sites. Those are fundamentally different problems.

**UI/UX Pro Max is the wrong tool for what you want.** It's a design *system picker* — great at choosing palettes and fonts for a "beauty spa" vs a "fintech app." But it doesn't teach Claude how to build the cinematic, scroll-driven, parallax-heavy experiences you see on Awwwards or Apple.com. Those require a completely different stack of skills.

## What You Actually Need: The Animation & Interaction Layer

### 1. `scroll-experience` skill (the closest thing to "Awwwards in a box")

This is explicitly designed for building immersive scroll-driven experiences like NY Times interactives and Apple product pages — parallax storytelling, scroll animations, sticky sections, and cinematic web experiences. It includes a full scroll animation stack with setup patterns for GSAP ScrollTrigger, Framer Motion, Locomotive Scroll, Lenis, and CSS scroll-timeline, plus parallax layer speed tables and anti-patterns to avoid.

Install:
```bash
mkdir -p .claude/skills/scroll-experience && curl -L -o skill.zip "https://fastmcp.me/Skills/Download/1029" && unzip -o skill.zip -d .claude/skills/scroll-experience && rm skill.zip
```

### 2. `claudedesignskills` by freshtechbro (the most comprehensive bundle)

This is 27 plugins covering Three.js, GSAP ScrollTrigger, React Three Fiber, Framer Motion, Babylon.js, Locomotive Scroll, PixiJS, Lottie animations, Spline, Rive, and more. This is where the Apple-grade 3D, WebGL, and scroll animation knowledge lives.

```bash
# Add marketplace
/plugin marketplace add freshtechbro/claudedesignskills

# Install what matters for Awwwards-quality sites:
/plugin install gsap-scrolltrigger
/plugin install motion-framer
/plugin install locomotive-scroll
/plugin install threejs-webgl          # for 3D elements
/plugin install core-3d-animation      # bundle: Three.js + GSAP + R3F + Motion + Babylon
```

### 3. `scrollytelling` skill (narrative-focused)

Covers pinned narrative sections, progressive reveals, parallax depth layers, step sequences, and hybrid patterns — with explicit guidance on choosing GSAP vs Motion vs CSS-only based on complexity.

### 4. GSAP MCP Server

A dedicated MCP server that gives Claude direct access to all GSAP features — scroll-triggered animations, motion paths, SVG morphing, draggable elements, and timeline sequences — through tool calls rather than just prompt instructions.

### 5. `motion` skill by jezweb

Includes ready-to-copy templates for scroll parallax, layout transitions (FLIP animations), and UI components (modals, carousels, tabs), plus reference guides on performance optimization and Next.js integration.

## The Realistic Stack for Awwwards-Quality

Here's what I'd actually recommend combining:

| Layer | Skill/Tool | What it does |
|---|---|---|
| Design system | `frontend-design` (Anthropic) | Prevents generic aesthetics |
| Scroll & parallax | `scroll-experience` + `gsap-scrolltrigger` | Apple-style cinematic scroll |
| Animation library | `motion-framer` | Declarative React animations |
| 3D elements | `threejs-webgl` or `react-three-fiber` | WebGL, 3D product showcases |
| Smooth scroll | `locomotive-scroll` | Lenis/Locomotive smooth scrolling |
| Visual QA | Screenshot loop (Puppeteer) | Claude sees and self-corrects |
| References | **Paste screenshots from Awwwards/Dribbble** | This is the most important one |

## The Uncomfortable Truth

Even with all of this, you still won't get true Awwwards-quality output from *just prompting*. The sites that win Awwwards have custom shaders, hand-tuned easing curves, bespoke typography treatments, and months of polish from experienced creative developers. What these skills do is get Claude from "AI slop" to "solid, professional, animated site" — maybe a 7-8 out of 10. The last 20% (from "good" to "award-winning") still requires a human with taste iterating on the output, adjusting timing, tweaking parallax speeds, and adding those tiny details that make something feel *crafted* rather than generated.

The biggest single lever remains: **show Claude specific visual references of exactly what you want** and build section by section with the screenshot loop running.

---

## Additional Notes

- Wrap with `observer()` from `mobx-react-lite` when the component reads from any MobX store
- **Keep files under ~500 lines** — extract logical sections (sub-components, helpers, hooks) into their own files. Prefer smaller, reusable, readable pieces over monolithic screens/components

### Component File Structure (top to bottom)
1. React + React Native imports

| Path | Purpose |
|---|---|
| `app/i18n/` | da.ts (Danish translations), i18n.ts, translate.ts |
| `app/devtools/` | ReactotronConfig |

## Slash Commands

| Command | Purpose |
|---|---|
| `/team <task description>` | Multi-agent workflow: Architect -> Planner -> Developer(s) -> Review. Researches the codebase, produces a plan for approval, implements in parallel, then validates. |
| `/new-component <Name>` | Scaffold a new component following conventions |
| `/refactor-component [path]` | Refactor a component to follow conventions |
