import { Bell, BookOpen, Command as CmdIcon, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

export interface HeaderProps {
  onOpenCommandPalette: () => void
}

export function Header({ onOpenCommandPalette }: HeaderProps) {
  const { t } = useTranslation()

  return (
    <TooltipProvider delayDuration={300}>
      <header className="flex h-14 items-center justify-between border-b border-border bg-card/60 px-6 backdrop-blur-xs">
        {/* Left Area: Project & Search */}
        <div className="flex items-center gap-4 flex-1 max-w-lg">
          <button
            onClick={onOpenCommandPalette}
            className="flex h-8 w-full max-w-sm items-center justify-between rounded-md border border-input bg-card px-3 text-xs text-muted-foreground shadow-xs hover:bg-muted hover:text-foreground transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5" />
              <span>{t('Search integrations, tools, routes...')}</span>
            </div>
            <kbd className="inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
              <CmdIcon className="h-2.5 w-2.5" />
              <span>K</span>
            </kbd>
          </button>
        </div>

        {/* Right Area: Status & Quick Links */}
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="text-[11px] font-medium border-border/80 gap-1.5 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            <span>{t('Dev Environment')}</span>
          </Badge>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" asChild>
                <Link to="/developers">
                  <BookOpen className="h-4 w-4 text-muted-foreground" />
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{t('Developer Documentation & SDK')}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="relative">
                <Bell className="h-4 w-4 text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{t('No new notifications')}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </header>
    </TooltipProvider>
  )
}
