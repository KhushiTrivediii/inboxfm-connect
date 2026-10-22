# Inboxfm Connect Web (`packages/web`)

Developer console, settings, connections, and flow-execution interfaces.

## Architecture & Conventions

- **Design System Contract**: The full formal specification for tokens, typography, 18 UI primitives, and 4-state lifecycle is documented in the canonical design system contract at [`docs/handbook/engineering/design-system.mdx`](../../docs/handbook/engineering/design-system.mdx).
- **Styling**: Tailwind CSS v4 via `@theme inline` in `src/styles/globals.css`. Never use hardcoded colors or ad-hoc margins; always use semantic variables (`bg-background`, `text-primary`, `border-border`).
- **Icons**: Lucide icons exclusively (`lucide-react`). No emojis or raw unicode glyphs.
- **Data Fetching**: TanStack React Query with domain hooks in `src/features/*/lib/*-hooks.ts`.
- **Query Error Handling**: Primary page queries must include `meta: { showErrorToast: true }`. Auxiliary queries omit this flag.
- **Component Primitives**: Always reuse components from `src/components/ui/` (`Button`, `Badge`, `Card`, `EmptyState`, `ErrorState`, `LoadingState`, `Skeleton`, `Dialog`, etc.) instead of creating one-offs.
