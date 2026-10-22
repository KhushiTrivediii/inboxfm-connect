import {
  Bot,
  CheckCircle2,
  Loader2,
  Pencil,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { AIProviderWithoutSensitiveData } from '@inboxfm-connect/shared'
import { AIProviderName } from '@/lib/api/ai-providers'

export interface AIProvidersTableProps {
  providers: AIProviderWithoutSensitiveData[]
  onEdit: (provider: AIProviderWithoutSensitiveData) => void
  onDelete: (provider: AIProviderWithoutSensitiveData) => void
  onBrowseModels: (provider: AIProviderWithoutSensitiveData) => void
  onToggleChat: (provider: AIProviderWithoutSensitiveData, enabled: boolean) => void
  togglingId?: string | null
  /** Set false for non-admin users: edit/delete and the chat toggle hit admin-only endpoints. */
  canManage?: boolean
}

const PROVIDER_NAMES: Record<string, string> = {
  [AIProviderName.OPENAI]: 'OpenAI',
  [AIProviderName.ANTHROPIC]: 'Anthropic',
  [AIProviderName.GOOGLE]: 'Google Gemini',
  [AIProviderName.OPENROUTER]: 'OpenRouter',
  [AIProviderName.MISTRAL]: 'Mistral AI',
  [AIProviderName.AZURE]: 'Azure OpenAI',
  [AIProviderName.BEDROCK]: 'AWS Bedrock',
  [AIProviderName.CLOUDFLARE_GATEWAY]: 'Cloudflare AI Gateway',
  [AIProviderName.CUSTOM]: 'Custom Provider',
  [AIProviderName.ACTIVEPIECES]: 'Activepieces Managed',
}

export function AIProvidersTable({
  providers,
  onEdit,
  onDelete,
  onBrowseModels,
  onToggleChat,
  togglingId,
  canManage = true,
}: AIProvidersTableProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-[10px] uppercase font-semibold text-muted-foreground border-b border-border">
          <tr>
            <th className="px-4 py-3">Provider</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Chat Default</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {providers.map((p) => {
            const isManaged = p.provider === AIProviderName.ACTIVEPIECES
            const isToggling = togglingId === p.id
            const isAnyToggling = togglingId !== null

            return (
              <tr key={p.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    <div className="h-7 w-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                      <Sparkles className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <span className="font-semibold text-foreground text-xs block">
                        {p.name}
                      </span>
                      <span className="text-[10px] font-mono text-muted-foreground">
                        {p.provider}
                      </span>
                    </div>
                  </div>
                </td>

                <td className="px-4 py-3">
                  <Badge variant="secondary" className="text-[11px] font-medium">
                    {PROVIDER_NAMES[p.provider] || p.provider}
                  </Badge>
                </td>

                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`chat-toggle-${p.id}`}
                      checked={p.enabledForChat}
                      disabled={isAnyToggling || isManaged || !canManage}
                      onCheckedChange={(checked) => onToggleChat(p, checked)}
                      aria-label={`Toggle chat for ${p.name}`}
                      title={isManaged ? 'Platform-managed provider cannot be disabled' : undefined}
                    />
                    {isToggling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    ) : p.enabledForChat ? (
                      <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        Default
                      </span>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">Off</span>
                    )}
                  </div>
                </td>

                <td className="px-4 py-3">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-[11px] font-medium text-foreground">
                      {isManaged ? 'Managed' : 'Configured'}
                    </span>
                  </div>
                </td>

                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      className="gap-1 text-xs h-7"
                      onClick={() => onBrowseModels(p)}
                      aria-label={`Browse models for ${p.name}`}
                      title="Browse available models"
                    >
                      <Bot className="h-3.5 w-3.5" />
                      <span>Models</span>
                    </Button>

                    {!isManaged && canManage && (
                      <>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => onEdit(p)}
                          aria-label={`Edit ${p.name}`}
                          title="Edit provider credentials"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>

                        <Button
                          size="xs"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => onDelete(p)}
                          aria-label={`Delete ${p.name}`}
                          title="Delete provider"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
