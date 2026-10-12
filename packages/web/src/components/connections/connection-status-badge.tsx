import { Badge } from '@/components/ui/badge'
import { AppConnectionStatus } from '@/lib/api/types'

const STATUS_LABELS: Record<AppConnectionStatus, string> = {
  ACTIVE: 'Connected',
  MISSING: 'Needs setup',
  ERROR: 'Error',
}

const STATUS_VARIANTS: Record<AppConnectionStatus, 'success' | 'warning' | 'destructive'> = {
  ACTIVE: 'success',
  MISSING: 'warning',
  ERROR: 'destructive',
}

/**
 * MISSING means "placeholder connection — no credentials attached yet": placeholder upserts are
 * stored with that status server-side (`app-connection.controller.ts`). Instead of a bare,
 * misleading label, the chip gets an explanatory tooltip pointing at the reconnect flow (#546).
 */
const STATUS_HINTS: Partial<Record<AppConnectionStatus, string>> = {
  MISSING: 'Placeholder connection — no credentials attached yet. Use Reconnect to finish setting it up.',
}

interface ConnectionStatusBadgeProps {
  status: AppConnectionStatus
  className?: string
}

export function ConnectionStatusBadge({ status, className }: ConnectionStatusBadgeProps) {
  return (
    <Badge
      variant={STATUS_VARIANTS[status] ?? 'outline'}
      className={`text-[10px] ${className ?? ''}`}
      dot
      title={STATUS_HINTS[status]}
    >
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}
