# Inboxfm Connect Design System (`packages/web`)

This document defines the visual foundation, component standards, and UX conventions for `packages/web` (developer console and dashboard), ensuring consistency across all screens.

---

## 1. Visual Foundation & Color Tokens

Colors are defined in `src/styles/globals.css` using HSL CSS variables and Tailwind v4 `@theme inline`:

| Token | Light Value | Dark Value | Usage |
|---|---|---|---|
| `--primary` | `257 74% 57%` (`#8142E3`) | `257 74% 57%` (`#8142E3`) | Brand purple accent, primary CTA buttons, active states, key icons |
| `--background` | `0 0% 98%` (`#FAFAFA`) | `0 0% 4%` (`#0A0A0A`) | Viewport background |
| `--card` | `0 0% 100%` (`#FFFFFF`) | `0 0% 9%` (`#171717`) | Cards, tables, surface containers |
| `--muted` | `0 0% 96%` (`#F5F5F5`) | `0 0% 15%` (`#262626`) | Inactive pills, code blocks, hovered rows |
| `--border` | `0 0% 90%` (`#E5E5E5`) | `0 0% 100% / 0.14` (`rgba(255, 255, 255, 0.14)`) | 1px border dividers |
| `--destructive` | `350 89% 60%` (`#F43F5E`) | `351 95% 72%` (`#FB7185`) | Danger badges, delete dialogs, destructive actions |
| `--success` | `160 84% 39%` (`#10B981`) | `160 60% 52%` (`#34D399`) | Success badges, active statuses, completion marks |
| `--warning` | `38 92% 50%` (`#F59E0B`) | `43 97% 56%` (`#FBBF24`) | Warning badges, caution indicators |

### Rules
- **Brand continuity**: The primary color remains purple (`hsl(257 74% 57%)`) in both light and dark mode.
- **Borders**: Always `1px`, never thicker. Use `border-border`.
- **Card elevation**: Cards use 1px border (`border-border`) with subtle shadow `shadow-xs` and rounded corners `rounded-lg` or `rounded-xl`.
- **No negative margins**: Never use negative margins (`-m-*`). Use `gap-*`, `space-y-*`, and proper padding.

---

## 2. Typography & Copy Standards

- **Font family**: Inter (`sans-serif`).
- **Body text**: `14px` (`text-sm`), `line-height: 1.25rem` (`leading-5`). Dense and tool-like, not loose 16px.
- **Headings**: Sentence case everywhere (e.g., "Trigger discovery", "Recent executions", "Create connection"). Proper nouns only for feature names (Flows, MCP, GitHub, Stripe).
- **Secondary text**: `12px` (`text-xs`) with `text-muted-foreground`.
- **Code & identifiers**: `font-mono text-xs` or `text-[11px]`.
- **Tracking**: Headings use subtle `-0.01em` to `-0.02em` tracking (`tracking-tight`).

---

## 3. Iconography

- **Lucide icons only**: Use `lucide-react` with 1.5–2px stroke.
- **Sizes**:
  - In buttons: `h-3.5 w-3.5` with `gap-1.5`
  - In section headers / cards: `h-4 w-4`
  - In empty states: `h-6 w-6` inside a `h-12 w-12 rounded-full bg-muted/80` container
- **No emoji or unicode symbols**: Never use raw emojis or unicode arrows (`->`, `✓`, `x`). Always use typed Lucide components (`ArrowRight`, `Check`, `X`).

---

## 4. Empty States & Navigation

Every list view (Connections, Trigger Bindings, Scheduled Tasks, API Keys, Activity) must render a structured `EmptyState` component (`src/components/ui/empty-state.tsx`) when data is empty:

```tsx
<EmptyState
  icon={IconComponent}
  title="Actionable heading"
  description="Helpful explanation of what appears here and why."
  actionLabel="Primary next action"
  onAction={() => navigate('/target-route')}
/>
```

- **Clear next action**: Always guide the user to the next logical step with an action button.
- **Client-side routing**: Never use `window.location.href = ...` inside actions — always use React Router's `navigate()` or `<Link>` component to preserve SPA state.

---

## 5. Loading States & Skeletons

- **List skeletons**: While queries are fetching initial data, show `<Skeleton>` rows matching the layout rather than a generic spinner.
- **Page transitions**: Suspended lazy pages use `<LoadingState rows={4} />`.
- **Button pending states**: Use `<Loader2 className="h-3.5 w-3.5 animate-spin" />` with `disabled` prop on mutations.

---

## 6. Query Error Handling (`meta`)

Per architecture conventions, `packages/web/src/lib/query/query-client.ts` catches query errors:

- **Primary page data queries** (table rows, lists: `useConnectionsQuery`, `useTriggerBindingsQuery`, `useScheduledTasksQuery`, `useExecutionsQuery`, `useProjectApiKeysQuery`, `usePlatformApiKeysQuery`, `useMcpServerQuery`):
  Include `meta: { showErrorToast: true, showErrorDialog: true }` so failure surfaces a toast and error state. The fork's query cache also accepts `showErrorDialog` alone for compatibility with the shared convention.
- **Auxiliary queries** (categories, metadata, single-item lookups):
  Omit `showErrorToast` so they fail silently or gracefully without alerting modal cascades.

---

## 7. Accessibility & Interactions

- **Focus rings**: Focus-visible uses `focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none`.
- **Hover states**: Hover states darken subtly (`hover:bg-muted/40`, `hover:border-primary/40`). No 3D transform, scale, or elevation jumps on hover.
- **Disabled state**: `opacity-50 pointer-events-none`.
- **Aria attributes**: Tables provide `<caption className="sr-only">`, dialogs provide `<DialogTitle>` / `<VisuallyHidden>`, and status messages use `role="status"` or `aria-live="polite"`.
