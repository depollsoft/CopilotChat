---
name: CopilotChat
description: A quiet, local-first Copilot chat workspace for technical workflows.
colors:
  workbench-bg: "#f7f7f8"
  surface: "#ffffff"
  surface-muted: "#f0f0f1"
  sidebar: "#f4f4f5"
  ink: "#202123"
  ink-muted: "#62626a"
  border: "#dedee3"
  border-strong: "#c8c8cf"
  accent: "#08795f"
  accent-text: "#ffffff"
  danger: "#b42318"
  warning: "#946000"
  dark-bg: "#202123"
  dark-surface: "#2f3033"
  dark-surface-muted: "#343541"
  dark-sidebar: "#171717"
  dark-ink: "#ececf1"
  dark-ink-muted: "#c5c5d2"
  dark-border: "#3f4047"
  dark-border-strong: "#565761"
  dark-accent: "#19c37d"
  dark-accent-text: "#041910"
  dark-danger: "#ff8a7a"
  dark-warning: "#f0b45a"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(32px, 5vw, 50px)"
    fontWeight: 760
    lineHeight: 1.06
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 760
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 800
    letterSpacing: "0.06em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "20px"
  xl: "24px"
  pill: "999px"
spacing:
  2xs: "4px"
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.pill}"
    padding: "8px 14px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "8px 14px"
    height: "40px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "15px"
  chip:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
---

# Design System: CopilotChat

## 1. Overview

**Creative North Star: "The Local Workbench"**

CopilotChat's interface is a quiet workbench for local AI-assisted development. The visual system uses restrained neutrals, familiar product controls, and a single teal accent so the user's conversation, project context, tool state, and permissions remain the center of attention.

The system is dense enough for real work without becoming an admin console. Surfaces layer through tonal contrast, borders, and measured shadows; motion exists for status and feedback rather than spectacle. It explicitly rejects SaaS marketing gloss, over-decorated AI chat chrome, and distracting motion.

**Key Characteristics:**
- Restrained light and dark themes with the same semantic token vocabulary.
- One sans-serif family across headings, body, controls, and labels.
- Rounded, tactile controls with consistent hover and focus affordances.
- Floating composer and header controls that preserve conversation space.
- Clear status treatment for provider state, streaming, permissions, and tool activity.

## 2. Colors

The palette is restrained product-neutral with a rare teal accent for action and status.

### Primary
- **Copilot Teal** (#08795f): Primary actions, selected states, running indicators, counts, and success status in the light theme. It is deliberately darker than the original seed so white label text meets WCAG AA.
- **Dark Copilot Teal** (#19c37d): The same semantic accent tuned for dark surfaces.

### Neutral
- **Workbench Background** (#f7f7f8): Light theme app canvas.
- **Sheet Surface** (#ffffff): Primary panels, cards, composer, menus, and drawers.
- **Muted Surface** (#f0f0f1): Hover surfaces, chips, secondary controls, and nested panel backing.
- **Sidebar Rail** (#f4f4f5): Navigation rail background in the light theme.
- **Ink** (#202123): Primary text and high-emphasis controls.
- **Muted Ink** (#62626a): Secondary labels, helper copy, timestamps, and inactive icons.
- **Quiet Border** (#dedee3): Default dividers, input borders, and card outlines.
- **Strong Border** (#c8c8cf): Hover borders, dashed states, and higher-emphasis separators.
- **Dark Workbench Background** (#202123): Dark theme app canvas.
- **Dark Sheet Surface** (#2f3033): Dark panels, cards, menus, and drawers.
- **Dark Muted Surface** (#343541): Dark hover surfaces and nested panel backing.
- **Dark Sidebar Rail** (#171717): Dark navigation rail background.
- **Dark Ink** (#ececf1): Primary dark theme text.
- **Dark Muted Ink** (#c5c5d2): Secondary dark theme text.

### Tertiary
- **Danger Red** (#b42318): Errors, destructive actions, setup warnings, and danger-zone surfaces.
- **Dark Danger Red** (#ff8a7a): Danger states on dark surfaces.
- **Warm Thinking Amber** (#946000): In-progress or pending state where success and error are both wrong.
- **Dark Warm Thinking Amber** (#f0b45a): Dark theme warning and running-state text.

### Named Rules

**The One Accent Rule.** Teal is for primary action, selection, and status. It must not become general decoration.

**The Tonal Layer Rule.** Depth starts with `--surface`, `--surface-muted`, `--sidebar`, and `--border`; shadows come after tonal hierarchy, not before it.

**The Token Floor Rule.** Radius and small-label type come from tokens, never literals. `styles.css` exposes `--radius-xs|sm|md(--radius)|lg|xl|pill`, `--space-2xs|xs|sm|md|lg|xl`, `--text-label|meta|caption|body`, `--measure`, and `--hit`. Label-tier text renders at `--text-label` or above. Those tokens are clamped with `max(11px, ...)` so the 11px floor holds across the whole 0.85-1.2 text-scale range, not just at the default. Primary navigation, header, and composer controls reach a `--hit` (44px) pointer target; compact in-content controls keep their visual size and extend their hit area to `--hit` with a transparent `::after`. Spacing is migrating onto `--space-*`; new rules should use the tokens rather than literals.

## 3. Typography

**Display Font:** Inter, with the system sans stack as fallback.
**Body Font:** Inter, with the system sans stack as fallback.
**Label/Mono Font:** UI monospace only for code blocks, slash commands, structured scalar values, and terminal output.

**Character:** The type system is product-native and compact. It uses weight, spacing, and color to establish hierarchy instead of decorative type pairing.

### Hierarchy
- **Display** (760, clamp(32px, 5vw, 50px), 1.06): Welcome and project-level hero headings only.
- **Headline** (760, 24px, 1.15): Drawer titles and modal headers.
- **Title** (700-850, 14-18px, 1.3): Card headings, section titles, active row labels, and important control labels.
- **Body** (400, 15-16px, 1.5-1.65): Chat content, settings descriptions, helper copy, and readable prose. Long prose should stay near 65-75ch.
- **Label** (800-900, 12px, 0.04-0.06em): Status pills, section labels, metadata, timestamps, and compact control annotations. 11px rendered is the hard floor for any functional text.

### Named Rules

**The Single Family Rule.** Do not introduce display fonts for UI chrome. Product confidence comes from tuned weights and spacing inside one sans family.

**The Label Restraint Rule.** Uppercase labels are for compact metadata and status only. They should not become section decoration.

## 4. Elevation

CopilotChat uses a hybrid of tonal layering and ambient elevation. Flat surfaces are the default; shadows are reserved for floating controls, menus, drawers, modals, the composer, and hover feedback where an element has actually moved or risen above the page.

### Shadow Vocabulary
- **Ambient Overlay** (`0 18px 50px rgb(0 0 0 / 14%)`): Light theme menus, drawers, auth panels, modals, and popovers.
- **Dark Ambient Overlay** (`0 18px 50px rgb(0 0 0 / 36%)`): Dark theme equivalent for floating surfaces.
- **Composer Lift** (`0 14px 34px rgb(0 0 0 / 10%)`): The floating composer in light mode.
- **Dark Composer Lift** (`0 14px 40px rgb(0 0 0 / 32%)`): The floating composer in dark mode.
- **Hover Lift** (`0 12px 26px rgb(0 0 0 / 8%)`): Welcome cards and light interactive cards when raised on hover.

### Named Rules

**The Earned Elevation Rule.** A shadow must signal a real stacking or interaction state. Static nested cards should use borders and tonal layers instead.

## 5. Components

### Buttons
- **Shape:** Pill-shaped for primary and secondary buttons (`pill`) and rounded-square for icon buttons (`sm`, 12px).
- **Primary:** Teal background (`--accent`) with accent text (`--accent-text`), minimum height near 40px, and compact horizontal padding.
- **Hover / Focus:** Hover darkens or shifts the surface; focus uses a 2px accent-colored outline with a 2px offset.
- **Secondary / Ghost:** Secondary buttons use `--surface` plus `--border`; ghost buttons stay transparent until hover.

### Chips
- **Style:** Pills use muted surfaces, compact spacing, and 700+ weights. Active chips may use a subtle teal tint or outline.
- **State:** Project and permission chips are icon-forward on constrained surfaces; count badges use teal for compact status.

### Cards / Containers
- **Corner Style:** Standard containers use the `md` (16px) radius; large panels, drawers, and auth surfaces use `lg` (20px) or `xl` (24px). Small chips, checks, and code chrome use `xs` (8px).
- **Background:** Cards use `--surface`; summary cards and nested activity use mixed muted surfaces.
- **Shadow Strategy:** Cards are mostly flat with a 1px border. Hover can raise only when the card is actionable.
- **Border:** Default `--border`, stronger `--border-strong` on hover or emphasized states.
- **Internal Padding:** Compact cards use 10-15px; large panels use 16-28px depending on density.

### Inputs / Fields
- **Style:** 1px border, `md` (16px) radius, sheet surface, 10px by 12px padding.
- **Focus:** Accent-colored outline with offset; composer textareas remove the inner outline because the composer shell owns focus context.
- **Error / Disabled:** Error text uses `--danger`; disabled controls reduce opacity and keep shape stable.

### Navigation
- **Style:** A 280px sidebar on desktop with rounded rows, a floating slide-in sidebar below 880px, and scrims for modal navigation states.
- **Typography:** Row titles use compact title weights; metadata and section labels use muted label styling.
- **Default / Hover / Active:** Hover and active rows use `--surface-muted`; unread and running state use semantic pills rather than color washes.
- **Mobile Treatment:** The sidebar becomes a fixed overlay with safe-area padding and transform-based entry.

### Composer
- **Style:** Floating absolute overlay, 24px shell radius, sheet surface, ambient lift, and a gradient fade to the page background.
- **Controls:** Send, stop, permission, attachment, and active context controls share the pill vocabulary.
- **Behavior:** Attachment trays add rows only when files exist; default composition stays one row.
- **Media:** Raster image attachments show a rounded thumbnail that opens a full-size viewer; every other file, including SVG, keeps the icon chip with a download action. Markdown images and links that point at workspace files render the same way inside messages, and previews load only once they approach the viewport.

### Activity and Interaction Cards
- **Style:** Tool activity is compact and collapsible with tonal surfaces; permission and interaction cards float above the composer.
- **State:** Running, failed, and succeeded states use amber, danger red, and teal respectively.
- **Density:** Nested tool details should be readable but bounded with overflow and copy affordances for code or raw data.

### Drawers and Modals
- **Style:** Drawers slide from the right with sheet surfaces and tabbed navigation. Modals use fixed positioning, large radius, and the ambient overlay shadow.
- **Usage:** Prefer inline or drawer flows for settings and editing. Use modal treatment only for focused editing, confirmation, or constrained tasks.

## 6. Do's and Don'ts

### Do:
- **Do** preserve the quiet, capable, local-first posture from PRODUCT.md.
- **Do** use teal only for primary actions, selection, success, and live/running indicators.
- **Do** keep focus states visible on every keyboard-reachable control.
- **Do** use tonal layers and borders before adding new shadows.
- **Do** preserve reduced-motion support for cursor, pulse, and status animations.
- **Do** keep the composer and header controls floating without stealing space from the conversation.

### Don't:
- **Don't** use SaaS marketing gloss, over-decorated AI chat chrome, or distracting motion.
- **Don't** add gradient text, decorative glassmorphism, or purple/neon AI assistant tropes.
- **Don't** make teal a decorative wash across inactive surfaces.
- **Don't** introduce a display font for buttons, labels, data, or navigation.
- **Don't** use side-stripe borders as card or alert accents.
- **Don't** turn settings and project surfaces into dense admin-console layouts.
