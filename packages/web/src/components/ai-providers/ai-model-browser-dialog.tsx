import { Bot, Image as ImageIcon, Loader2, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useAIProviderModelsQuery } from '@/lib/query/hooks'
import { AIProviderName } from '@/lib/api/ai-providers'

export interface AIModelBrowserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerName: string
  providerType: AIProviderName | null
}

export function AIModelBrowserDialog({
  open,
  onOpenChange,
  providerName,
  providerType,
}: AIModelBrowserDialogProps) {
  const [searchTerm, setSearchTerm] = useState('')
  const { data: models, isLoading, isError, error, refetch, isFetching } = useAIProviderModelsQuery(
    providerType ?? undefined,
    open && !!providerType
  )

  const filteredModels = useMemo(() => {
    if (!models) return []
    const term = searchTerm.trim().toLowerCase()
    if (!term) return models
    return models.filter(
      (m) => m.name.toLowerCase().includes(term) || m.id.toLowerCase().includes(term)
    )
  }, [models, searchTerm])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6">
        <DialogHeader className="pb-2">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <DialogTitle className="text-base font-bold">
              Available Models — {providerName}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            Models discovered from the {providerType} provider endpoint.
          </DialogDescription>
        </DialogHeader>

        <div className="relative mt-2">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Filter models by name or ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9 text-xs h-9"
          />
        </div>

        <div className="flex-1 overflow-y-auto min-h-[260px] max-h-[380px] mt-3 space-y-2 border border-border rounded-lg p-2 bg-muted/10">
          {isLoading ? (
            <div className="space-y-2 p-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2 justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span>Fetching models from {providerName}...</span>
              </div>
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-10 w-full rounded-md" />
            </div>
          ) : isError ? (
            <div className="p-4 text-center space-y-3">
              <p className="text-xs text-destructive font-medium">
                {error instanceof Error ? error.message : 'Failed to retrieve provider models.'}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void refetch()}
                disabled={isFetching}
                className="gap-1.5 text-xs mx-auto"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                <span>Retry</span>
              </Button>
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {searchTerm ? 'No models match your search query.' : 'No models available for this provider.'}
            </div>
          ) : (
            <div className="space-y-1.5" data-testid="models-list">
              {filteredModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-center justify-between p-2.5 rounded-md border border-border bg-card hover:bg-muted/40 transition-colors"
                >
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground">{model.name}</span>
                      <Badge
                        variant="secondary"
                        className="text-[10px] font-mono font-normal px-1.5 py-0"
                      >
                        {model.id}
                      </Badge>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className="text-[10px] capitalize gap-1 text-muted-foreground"
                  >
                    {model.type === 'image' ? (
                      <ImageIcon className="h-3 w-3 text-purple-500" />
                    ) : (
                      <Bot className="h-3 w-3 text-blue-500" />
                    )}
                    <span>{model.type}</span>
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="mt-4 flex items-center justify-between sm:justify-between w-full">
          <span className="text-[11px] text-muted-foreground">
            {models ? `${filteredModels.length} of ${models.length} model${models.length === 1 ? '' : 's'}` : ''}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="text-xs"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
